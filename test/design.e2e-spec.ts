import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { BEDROCK_RUNTIME } from '../src/ai/bedrock/bedrock.types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Role } from '../src/generated/prisma/enums';
import { type MailMessage, MailTransport } from '../src/mail/mail.transport';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStore } from '../src/storage/object-store';
import { fakeRuntime, type SentCommand } from './helpers/bedrock-fakes';
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
const DOMAIN = 'design.e2e.test';
const run = Date.now().toString(36);
let counter = 0;

interface Session {
  id: string;
  email: string;
  token: string;
}

const promptOf = (c: SentCommand): string =>
  (c.input.messages ?? [])
    .flatMap((m) => m.content ?? [])
    .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
    .join('\n');

const reply = (text: string) => ({
  output: { message: { role: 'assistant', content: [{ text }] } },
  usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
  stopReason: 'end_turn',
});

/** Scripted model: picks the answer by the prompt it receives. */
function answer(command: SentCommand): unknown {
  const prompt = promptOf(command);
  if (prompt.includes('naming electronic circuit design projects')) {
    return reply('"24V Buck Converter for Robotics"\n');
  }
  if (
    prompt.includes('determine which stage-specific parameters are necessary')
  ) {
    return reply(
      '```json\n{"requiredParameters":[{"id":"pfc_requirement","reasoning":"AC input"},{"id":"bogus","reasoning":"x"},{"id":"input_voltage","reasoning":"always"}],"overallReasoning":"AC-DC supply"}\n```',
    );
  }
  if (
    prompt.includes('Extract parameter values from the design requirements')
  ) {
    return reply(
      JSON.stringify({
        parameters: [
          {
            id: 'input_voltage',
            label: 'Input Voltage',
            detectedValue: '230 VAC',
            source: 'user_input',
            confidence: 'high',
            reasoning: 'stated',
            recommendedValue: null,
            recommendationReasoning: null,
            isMissing: false,
            missingReason: null,
          },
          {
            id: 'environment',
            detectedValue: null,
            source: 'assistant_recommendation',
            confidence: 'low',
            reasoning: 'not stated',
            recommendedValue: 'Indoor',
            recommendationReasoning: 'Typical for LED drivers',
            isMissing: true,
            missingReason: 'Not provided',
          },
        ],
        missingParameters: [],
        notes: 'ok',
      }),
    );
  }
  if (prompt.includes('translating high-level product requirements')) {
    return reply(
      JSON.stringify({
        derivedParametersList: [
          {
            name: 'Output Voltage',
            value: '12V',
            reasoning: 'r',
            categoryKey: 'electrical_output_load',
          },
          {
            name: 'Isolation',
            value: true,
            reasoning: 'r',
            categoryKey: 'compliance_regulatory',
          },
        ],
        recommendedTopology: {
          name: 'Flyback',
          rationale: 'r',
          exampleApplications: 'x',
        },
        assumptionsMade: ['25C ambient'],
        overallCitations: [
          {
            title: 'TI app note',
            uri: 'https://www.ti.com/lit/an/slva959/slva959.pdf',
          },
          { title: 'Fake', uri: 'https://example.com/x' },
        ],
      }),
    );
  }
  if (prompt.includes('recommend the top 3 most suitable circuit topologies')) {
    return reply(
      JSON.stringify({
        topologies: ['Flyback', 'SEPIC', 'Boost'].map((name) => ({
          name,
          pros: ['a', 'b'],
          cons: ['c', 'd'],
          rationale: 'r',
          relevantCitations: [{ title: 't', uri: 'http://localhost/x' }],
        })),
      }),
    );
  }
  return reply('{}');
}

function events(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

const resultOf = <T>(text: string): T => {
  const last = events(text).at(-1);
  if (!last?.done) throw new Error(`step failed: ${JSON.stringify(last)}`);
  return last.result as T;
};

const waitFor = async (check: () => Promise<boolean>, ms = 5_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('Design steps (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;
  const fake = fakeRuntime((command) => answer(command));
  const store = new MemoryObjectStore();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(new SilentMail())
      .overrideProvider(ObjectStore)
      .useValue(store)
      .overrideProvider(BEDROCK_RUNTIME)
      .useValue(fake.runtime)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { endsWith: `@${DOMAIN}` } },
    });
    await app.close();
  });

  async function signUp(role: Role = Role.USER): Promise<Session> {
    const email = `ds-${run}-${++counter}@${DOMAIN}`;
    await request(http)
      .post(`${PREFIX}/auth/register`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const row = await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date(), role },
    });
    const res = await request(http)
      .post(`${PREFIX}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    // Creates the billing account and the signup trial tokens.
    await request(http)
      .get(`${PREFIX}/billing/me`)
      .set(
        'Authorization',
        `Bearer ${(res.body as { accessToken: string }).accessToken}`,
      )
      .expect(200);
    return {
      id: row.id,
      email,
      token: (res.body as { accessToken: string }).accessToken,
    };
  }

  const as = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

  const projectData = async (id: string) =>
    (await prisma.project.findUniqueOrThrow({ where: { id } })).data as Record<
      string,
      unknown
    >;

  async function create(owner: Session, body: Record<string, unknown> = {}) {
    const res = await request(http)
      .post(`${PREFIX}/projects`)
      .set(as(owner))
      .send(body)
      .expect(201);
    return res.body as { id: string; revision: number };
  }

  it('names a project from its prompt in the background and charges with project metadata', async () => {
    const owner = await signUp();
    const project = await create(owner, {
      prompt: 'A 24 V buck converter for a robot arm',
    });
    await waitFor(async () => {
      const row = await prisma.project.findUniqueOrThrow({
        where: { id: project.id },
      });
      return row.name === '24V Buck Converter for Robotics';
    });
    const ledger = await prisma.tokenLedgerEntry.findMany({
      where: { userId: owner.id, reason: 'ai_usage' },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({
      step: 'project_name_generation',
      projectId: project.id,
      actorId: owner.id,
    });
  });

  it('analyses the design intent and applies review edits server-side', async () => {
    const owner = await signUp();
    const project = await create(owner);
    const empty = await request(http)
      .post(`${PREFIX}/projects/${project.id}/design-intent/analyze`)
      .set(as(owner))
      .send({})
      .expect(400);
    expect((empty.body as { code: string }).code).toBe('STAGE_INPUT_MISSING');

    const res = await request(http)
      .post(`${PREFIX}/projects/${project.id}/design-intent/analyze`)
      .set(as(owner))
      .send({ userInput: '230 VAC to 12 V, 50 W LED driver' })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const result = resultOf<{
      requiredStageParams: string[];
      analysis: {
        parameters: Array<{ id: string; isMissing: boolean }>;
        missingParameters: unknown[];
      };
    }>(res.text);
    expect(result.requiredStageParams).toEqual(['pfc_requirement']);
    // 13 always-mandatory parameters + 1 stage parameter.
    expect(result.analysis.parameters).toHaveLength(14);
    expect(
      result.analysis.parameters.find((p) => p.id === 'input_voltage')
        ?.isMissing,
    ).toBe(false);

    const approved = await request(http)
      .patch(`${PREFIX}/projects/${project.id}/design-intent/parameters`)
      .set(as(owner))
      .send({ id: 'environment', action: 'approve_assumption' })
      .expect(200);
    const env = (
      approved.body as {
        analysis: { parameters: Array<Record<string, unknown>> };
      }
    ).analysis.parameters.find((p) => p.id === 'environment');
    expect(env).toMatchObject({
      detectedValue: 'Indoor',
      source: 'confirmed_assumption',
      isMissing: false,
    });

    await request(http)
      .patch(`${PREFIX}/projects/${project.id}/design-intent/parameters`)
      .set(as(owner))
      .send({ id: 'input_voltage', action: 'set', value: '' })
      .expect(200);
    const stored = (await projectData(project.id))
      .mandatoryParametersAnalysis as {
      missingParameters: Array<{ id: string }>;
    };
    expect(stored.missingParameters.map((p) => p.id)).toContain(
      'input_voltage',
    );
  });

  it('turns requirements into a specification and filters bad citations', async () => {
    const owner = await signUp();
    const project = await create(owner, { prompt: 'Isolated 12 V supply' });
    const res = await request(http)
      .post(`${PREFIX}/projects/${project.id}/requirements/process`)
      .set(as(owner))
      .send({})
      .expect(200);
    const result = resultOf<{
      specification: { derivedParametersList: unknown[] };
      citations: Array<{ uri: string }>;
    }>(res.text);
    expect(result.specification.derivedParametersList).toHaveLength(2);
    expect(result.citations.map((c) => c.uri)).toEqual([
      'https://www.ti.com/lit/an/slva959/slva959.pdf',
    ]);
    const data = await projectData(project.id);
    expect(data.initialSpecification).toBeTruthy();
    expect(data.initialSelectedCategories).toHaveLength(10);
  });

  it('recommends topologies, injects a requested buck-boost, and caches by parameters', async () => {
    const owner = await signUp();
    const project = await create(owner, {
      prompt: 'I need a buck-boost converter from 12 V to -5 V',
    });
    const params = {
      inputVoltage: { value: '12V' },
      outputVoltage: { value: '-5V' },
    };
    const first = await request(http)
      .post(`${PREFIX}/projects/${project.id}/topologies/recommend`)
      .set(as(owner))
      .send({ parameters: params })
      .expect(200);
    const result = resultOf<{
      topologies: Array<{ name: string; relevantCitations: unknown[] }>;
      cached: boolean;
    }>(first.text);
    expect(result.cached).toBe(false);
    expect(result.topologies.map((t) => t.name)).toEqual([
      'Flyback',
      'SEPIC',
      'Buck-Boost',
    ]);
    expect(result.topologies[0].relevantCitations).toEqual([]);

    const sent = fake.sent.length;
    const again = await request(http)
      .post(`${PREFIX}/projects/${project.id}/topologies/recommend`)
      .set(as(owner))
      .send({
        parameters: {
          outputVoltage: { value: '-5V' },
          inputVoltage: { value: '12V' },
        },
      })
      .expect(200);
    expect(resultOf<{ cached: boolean }>(again.text).cached).toBe(true);
    expect(fake.sent.length).toBe(sent);
  });

  it('edits Studio specs, generates constraints, and forces stale clients to reload', async () => {
    const owner = await signUp();
    const project = await create(owner);
    const specs = await request(http)
      .patch(`${PREFIX}/projects/${project.id}/studio/specs`)
      .set(as(owner))
      .send({
        application: 'LED driver',
        rows: [{ name: 'Output voltage', value: '12', unit: 'V' }],
      })
      .expect(200);
    expect(specs.body).toMatchObject({
      ok: true,
      summary: 'Specs updated (1 rows)',
    });

    await request(http)
      .patch(`${PREFIX}/projects/${project.id}/studio/constraints`)
      .set(as(owner))
      .send({
        items: [
          {
            name: 'Isolation',
            value: '3 kV',
            category: 'compliance_regulatory',
          },
        ],
      })
      .expect(200);

    const gen = await request(http)
      .post(`${PREFIX}/projects/${project.id}/studio/constraints/generate`)
      .set(as(owner))
      .send({ notes: 'Automotive grade' })
      .expect(200);
    const outcome = resultOf<{
      ok: boolean;
      payload: { total: number };
      revision: number;
    }>(gen.text);
    expect(outcome.ok).toBe(true);
    // 'Isolation' is hand-set, so the AI item with the same name is dropped.
    expect(outcome.payload.total).toBe(2);
    const constraintsPrompt = promptOf(fake.sent.at(-1)!);
    expect(constraintsPrompt).toContain('- Output voltage: 12 V [user]');
    expect(constraintsPrompt).toContain("Engineer's notes: Automotive grade");

    const detail = await request(http)
      .get(`${PREFIX}/projects/${project.id}`)
      .set(as(owner))
      .expect(200);
    const body = detail.body as {
      revision: number;
      studio: Record<string, unknown>;
    };
    expect(body.revision).toBe(outcome.revision);
    await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({ studio: body.studio, revision: body.revision - 1 })
      .expect(409);
  });

  it('enforces access and the token balance before streaming', async () => {
    const owner = await signUp();
    const viewer = await signUp();
    const project = await create(owner, { prompt: 'x' });
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/invitations`)
      .set(as(owner))
      .send({ emails: [viewer.email], role: 'VIEWER' })
      .expect(201);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/requirements/process`)
      .set(as(viewer))
      .send({})
      .expect(403);

    await prisma.$executeRaw`UPDATE token_batches SET tokens_used = tokens_granted WHERE user_id = ${owner.id}::uuid`;
    const broke = await request(http)
      .post(`${PREFIX}/projects/${project.id}/requirements/process`)
      .set(as(owner))
      .send({})
      .expect(402);
    expect((broke.body as { code: string }).code).toBe('INSUFFICIENT_TOKENS');
  });

  it('sends PDF specifications to the model as documents', async () => {
    const owner = await signUp();
    const project = await create(owner, { prompt: 'From the attached spec' });
    const pdf = await request(http)
      .post(`${PREFIX}/projects/${project.id}/files/documents`)
      .set(as(owner))
      .attach('file', Buffer.from('%PDF-1.7 spec'), 'spec.pdf')
      .expect(201);
    const other = await signUp();
    await request(http)
      .post(
        `${PREFIX}/projects/${(await create(other)).id}/requirements/process`,
      )
      .set(as(other))
      .send({ documentIds: [(pdf.body as { id: string }).id] })
      .expect(404);

    await request(http)
      .post(`${PREFIX}/projects/${project.id}/requirements/process`)
      .set(as(owner))
      .send({ documentIds: [(pdf.body as { id: string }).id] })
      .expect(200);
    const input = fake.sent.at(-1)!.input as ConverseCommandInput;
    const blocks = input.messages?.[0].content ?? [];
    expect(blocks[0]).toMatchObject({
      document: { format: 'pdf', name: 'Specification 1' },
    });
  });

  it('charges team projects to the team owner within the team cap', async () => {
    const owner = await signUp();
    const member = await signUp();
    const admin = await signUp(Role.ADMIN);
    await request(http)
      .post(`${PREFIX}/admin/users/${owner.id}/plan`)
      .set(as(admin))
      .send({ planId: 'teams', interval: 'MONTHLY', tokenAllocation: 750000 })
      .expect(201);
    const team = (
      await request(http)
        .post(`${PREFIX}/teams`)
        .set(as(owner))
        .send({ name: 'T', tokenLimit: 5000 })
        .expect(201)
    ).body as { id: string };
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: member.id, role: 'MEMBER' },
    });
    const project = await create(owner, { teamId: team.id });

    await request(http)
      .post(`${PREFIX}/projects/${project.id}/requirements/process`)
      .set(as(member))
      .send({ userInput: 'A 5 V rail' })
      .expect(200);
    const usage = await prisma.teamTokenUsage.findMany({
      where: { teamId: team.id },
    });
    expect(usage).toEqual([
      expect.objectContaining({
        userId: member.id,
        projectId: project.id,
        operation: 'initial_requirements',
      }),
    ]);
    expect(
      await prisma.tokenLedgerEntry.count({
        where: { userId: member.id, reason: 'ai_usage' },
      }),
    ).toBe(0);

    await prisma.team.update({
      where: { id: team.id },
      data: { tokensUsed: 5000 },
    });
    const capped = await request(http)
      .post(`${PREFIX}/projects/${project.id}/requirements/process`)
      .set(as(member))
      .send({ userInput: 'A 5 V rail' })
      .expect(402);
    expect((capped.body as { code: string }).code).toBe(
      'TEAM_TOKEN_LIMIT_REACHED',
    );
  });
});
