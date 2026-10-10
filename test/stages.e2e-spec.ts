import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { type MailMessage, MailTransport } from '../src/mail/mail.transport';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStore } from '../src/storage/object-store';
import { MemoryObjectStore } from './helpers/memory-object-store';

class SilentMail extends MailTransport {
  send(_message: MailMessage): Promise<void> {
    return Promise.resolve();
  }
  verify(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
}

const PREFIX = '/api/v1';
const PASSWORD = 'correct-horse-battery-1';
const DOMAIN = 'stages.e2e.test';
const run = Date.now().toString(36);
let counter = 0;

const EMC = {
  pfcInductorMH: 1.464,
  htRailVoltage: 394,
  inputPower: 108,
  inputRMSVoltage: 264,
  firstInputCapNF: 1,
  secondInputCapNF: 1,
  inputFilterInductorMH: 8,
  passMarginDB: 6,
  lisnResistanceOhm: 50,
};

interface StageBody {
  ok: boolean;
  summary: string;
  payload?: Record<string, unknown>;
  revision: number | null;
}

describe('Studio stages and calculators (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;
  let token = '';
  let projectId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(new SilentMail())
      .overrideProvider(ObjectStore)
      .useValue(new MemoryObjectStore())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);

    const email = `st-${run}-${++counter}@${DOMAIN}`;
    await request(http)
      .post(`${PREFIX}/auth/register`)
      .send({ email, password: PASSWORD })
      .expect(201);
    await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date() },
    });
    const login = await request(http)
      .post(`${PREFIX}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
    const project = await request(http)
      .post(`${PREFIX}/projects`)
      .set(auth())
      .send({})
      .expect(201);
    projectId = (project.body as { id: string }).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { endsWith: `@${DOMAIN}` } },
    });
    await app.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('designs entered magnetic parts and records the stage', async () => {
    const missing = await request(http)
      .post(`${PREFIX}/projects/${projectId}/studio/magnetics`)
      .set(auth())
      .send({ parts: [{ ref: 'L1', kind: 'inductor', fsw_khz: 100 }] })
      .expect(200);
    expect(missing.body).toMatchObject({
      ok: false,
      payload: { missing_inputs: { L1: ['inductance_uh', 'i_dc_a'] } },
    });

    const res = await request(http)
      .post(`${PREFIX}/projects/${projectId}/studio/magnetics`)
      .set(auth())
      .send({
        ambientC: 40,
        parts: [
          {
            ref: 'L1',
            kind: 'inductor',
            inductance_uh: 47,
            i_dc_a: 10,
            i_ripple_pp_a: 3,
            fsw_khz: 100,
          },
        ],
      })
      .expect(200);
    const body = res.body as StageBody;
    expect(body.ok).toBe(true);
    expect(body.revision).toBeGreaterThan(0);
    const designs = body.payload?.designs as Array<{
      ref: string;
      total_loss_w: number;
    }>;
    expect(designs).toHaveLength(1);
    expect(designs[0].total_loss_w).toBeGreaterThan(0);

    const detail = await request(http)
      .get(`${PREFIX}/projects/${projectId}`)
      .set(auth())
      .expect(200);
    const nodes = Object.values(
      (detail.body as { studio: { nodes: Record<string, { stage: string }> } })
        .studio.nodes,
    );
    expect(nodes.map((n) => n.stage)).toContain('magnetics');

    await request(http)
      .post(`${PREFIX}/projects/${projectId}/studio/magnetics`)
      .set(auth())
      .send({ parts: [{ ref: 'L1', kind: 'inductor', inductance_uh: -5 }] })
      .expect(400);
  });

  it('analyses entered heat sources and counts designed magnetics', async () => {
    const missing = await request(http)
      .post(`${PREFIX}/projects/${projectId}/studio/thermal`)
      .set(auth())
      .send({ inputs: { devices: [{ ref: 'Q1', kind: 'switch' }] } })
      .expect(200);
    expect((missing.body as StageBody).ok).toBe(false);

    const res = await request(http)
      .post(`${PREFIX}/projects/${projectId}/studio/thermal`)
      .set(auth())
      .send({
        ambientC: 50,
        inputs: {
          devices: [
            { ref: 'Q1', kind: 'switch', loss_w: 4.2, technology: 'SiC' },
            {
              ref: 'D1',
              kind: 'diode',
              conduction_loss_w: 0.8,
              switching_loss_w: 0.3,
            },
          ],
          output_power_w: 200,
        },
      })
      .expect(200);
    const body = res.body as StageBody;
    expect(body.ok).toBe(true);
    const magnetics = body.payload?.magnetics as Array<{
      ref: string;
      from: string;
    }>;
    expect(magnetics).toEqual([
      expect.objectContaining({ ref: 'L1', from: 'magnetics design' }),
    ]);
    expect(body.payload?.efficiency_pct).toBeGreaterThan(90);
  });

  it('reports the simulation-fed path as unavailable until the simulation module lands', async () => {
    const res = await request(http)
      .post(`${PREFIX}/projects/${projectId}/studio/thermal`)
      .set(auth())
      .send({ fromSimulation: true })
      .expect(200);
    // No simulation on the branch: the stage explains what to enter instead.
    expect((res.body as StageBody).ok).toBe(false);
  });

  it('builds the BOM, updates quantities and exports to storage', async () => {
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    await prisma.project.update({
      where: { id: projectId },
      data: {
        data: {
          ...(row.data as Record<string, unknown>),
          selectedParts: [
            {
              id: 'p1',
              componentName: 'Q1',
              manufacturer: 'Wolfspeed',
              partNumber: 'C3M0065090D',
              pricingTiers: [{ quantity: 1, price: 4.5 }],
              availability: '1,234 In Stock',
            },
            {
              id: 'p2',
              componentName: 'R1',
              description: '=HYPERLINK("http://evil")',
              quantity: 2,
            },
          ],
        },
      },
    });
    const bom = await request(http)
      .get(`${PREFIX}/projects/${projectId}/bom`)
      .set(auth())
      .expect(200);
    expect(
      (bom.body as { summary: { totalCost: number; totalQuantity: number } })
        .summary,
    ).toMatchObject({
      totalCost: 4.5,
      totalQuantity: 3,
    });
    const qty = await request(http)
      .patch(`${PREFIX}/projects/${projectId}/bom/parts/p1`)
      .set(auth())
      .send({ quantity: 10 })
      .expect(200);
    expect(
      (qty.body as { summary: { totalCost: number } }).summary.totalCost,
    ).toBe(45);
    await request(http)
      .patch(`${PREFIX}/projects/${projectId}/bom/parts/nope`)
      .set(auth())
      .send({ quantity: 1 })
      .expect(404);
    await request(http)
      .patch(`${PREFIX}/projects/${projectId}/bom/parts/p1`)
      .set(auth())
      .send({ quantity: 0 })
      .expect(400);

    for (const format of ['xlsx', 'csv']) {
      const res = await request(http)
        .post(`${PREFIX}/projects/${projectId}/bom/export`)
        .set(auth())
        .send({ format })
        .expect(201);
      expect(
        (res.body as { file: { kind: string; filename: string }; url: string })
          .file,
      ).toMatchObject({
        kind: 'EXPORT',
        filename: expect.stringMatching(
          new RegExp(`^BOM_My_Project_\\d{8}\\.${format}$`),
        ) as unknown,
      });
    }
  });

  it('runs the EMC and MTBF calculators', async () => {
    const scan = await request(http)
      .post(`${PREFIX}/calculators/emc/scan`)
      .set(auth())
      .send(EMC)
      .expect(200);
    const s = scan.body as {
      passCount: number;
      failCount: number;
      scanResults: unknown[];
    };
    expect(s.scanResults.length).toBe(s.passCount + s.failCount);
    await request(http)
      .post(`${PREFIX}/calculators/emc/scan`)
      .set(auth())
      .send({ ...EMC, pfcInductorMH: 0 })
      .expect(400);
    const spectrum = await request(http)
      .post(`${PREFIX}/calculators/emc/spectrum`)
      .set(auth())
      .send({ ...EMC, voltage: 230 })
      .expect(200);
    expect(
      (spectrum.body as { emissions: unknown[] }).emissions.length,
    ).toBeGreaterThan(0);

    const options = await request(http)
      .get(`${PREFIX}/calculators/mtbf/options`)
      .set(auth())
      .expect(200);
    const envs = (options.body as { environments: Record<string, string[]> })
      .environments['MIL-HDBK-217F'];
    const mtbf = await request(http)
      .post(`${PREFIX}/calculators/mtbf`)
      .set(auth())
      .send({
        predictionMethod: 'MIL-HDBK-217F',
        environment: envs[1],
        parts: [
          {
            id: 'p1',
            componentName: 'Q1',
            componentType: 'mosfet',
            partNumber: 'C3M0065090D',
          },
          { id: 'p2', componentName: 'C1', componentType: 'capacitor' },
        ],
        thermal: [{ name: 'Q1', temperature: '95' }],
      })
      .expect(200);
    const m = mtbf.body as {
      mtbf: number;
      components: Array<{ contribution: number }>;
    };
    expect(m.mtbf).toBeGreaterThan(0);
    expect(m.components.reduce((a, c) => a + c.contribution, 0)).toBeCloseTo(
      100,
      0,
    );

    await request(http)
      .post(`${PREFIX}/calculators/mtbf`)
      .set(auth())
      .send({
        predictionMethod: 'MIL-HDBK-217F',
        environment: 'Moon base',
        parts: [],
      })
      .expect(400);
    const empty = await request(http)
      .post(`${PREFIX}/projects/${projectId}/mtbf`)
      .set(auth())
      .send({ predictionMethod: 'MIL-HDBK-217F', environment: envs[0] })
      .expect(400);
    expect((empty.body as { code: string }).code).toBe('STAGE_INPUT_MISSING');
  });
});
