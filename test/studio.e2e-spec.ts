import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
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
import {
  type FakeReply,
  fakeRuntime,
  scriptedStream,
} from './helpers/bedrock-fakes';
import { loadStudioFixtures } from './parity/studio-agent-fixtures';

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
const run = Date.now().toString(36);
let counter = 0;

const fixture = loadStudioFixtures().find(
  (f) => f.name === '12-stream-text-and-tools',
)!;
const usage = { inputTokens: 5120, outputTokens: 230 };

function events(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

const waitFor = async (check: () => boolean, ms = 5_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('Studio agent (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;
  let reply: FakeReply = () => ({
    stream: scriptedStream(fixture.bedrock_stream),
  });
  const fake = fakeRuntime((command) => reply(command));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(new SilentMail())
      .overrideProvider(BEDROCK_RUNTIME)
      .useValue(fake.runtime)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
    });
    configureApp(app);
    await app.listen(0);
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { endsWith: '@studio.e2e.test' } },
    });
    await app.close();
  });

  beforeEach(() => {
    reply = () => ({ stream: scriptedStream(fixture.bedrock_stream) });
  });

  async function user(
    role: Role = Role.USER,
  ): Promise<{ token: string; id: string }> {
    const email = `studio-${run}-${++counter}@studio.e2e.test`;
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
    return {
      token: (res.body as { accessToken: string }).accessToken,
      id: row.id,
    };
  }

  const agent = (token: string, body: unknown = fixture.input) =>
    request(http)
      .post(`${PREFIX}/studio/agent`)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  const balance = async (token: string) =>
    (
      (
        await request(http)
          .get(`${PREFIX}/billing/me`)
          .set('Authorization', `Bearer ${token}`)
      ).body as { balance: number }
    ).balance;

  const charges = (userId: string) =>
    prisma.tokenLedgerEntry.findMany({
      where: { userId, amount: { lt: 0 } },
    });

  it('requires authentication', async () => {
    await request(http)
      .post(`${PREFIX}/studio/agent`)
      .send(fixture.input)
      .expect(401);
    expect(fake.sent).toHaveLength(0);
  });

  it('validates the body', async () => {
    const { token } = await user();
    await agent(token, { messages: [] }).expect(400);
    await agent(token, { messages: [{ role: 'user', content: 'hi' }] }).expect(
      400,
    );
    await agent(token, { ...fixture.input, project_state: 'x' }).expect(400);
  });

  it('streams the Python event sequence and charges exactly once', async () => {
    const { token, id } = await user();
    const sentBefore = fake.sent.length;
    const res = await agent(token).expect(200);

    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(events(res.text)).toEqual(fixture.expected_events);
    expect(fake.sent.length - sentBefore).toBe(1);

    const total = usage.inputTokens + usage.outputTokens;
    expect(await balance(token)).toBe(10_000 - total);
    const entries = await charges(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amount: -total, reason: 'ai_usage' });
    expect(entries[0].metadata).toMatchObject({
      step: 'studio_agent',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  });

  it('applies the studio_agent step multiplier', async () => {
    const admin = await user(Role.ADMIN);
    const { token } = await user();
    const setMultipliers = (multipliers: Record<string, number>) =>
      request(http)
        .put(`${PREFIX}/admin/settings/step_multipliers`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ multipliers })
        .expect(200);
    await setMultipliers({ studio_agent: 0.5 });
    try {
      await agent(token).expect(200);
      expect(await balance(token)).toBe(
        10_000 - Math.ceil((usage.inputTokens + usage.outputTokens) * 0.5),
      );
    } finally {
      await setMultipliers({ studio_agent: 1 });
    }
  });

  it('refuses to start at zero balance (402) without calling Bedrock', async () => {
    const { token } = await user();
    reply = () => ({
      stream: scriptedStream([
        {
          contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'long' } },
        },
        {
          metadata: {
            usage: {
              inputTokens: 9_000,
              outputTokens: 6_000,
              totalTokens: 15_000,
            },
            metrics: { latencyMs: 1 },
          },
        },
      ]),
    });
    await agent(token).expect(200);
    expect(await balance(token)).toBe(0);

    const sentBefore = fake.sent.length;
    const denied = await agent(token).expect(402);
    expect(denied.body).toMatchObject({ code: 'INSUFFICIENT_TOKENS' });
    expect(fake.sent.length).toBe(sentBefore);
  });

  it('sends one error event and charges nothing when Bedrock fails', async () => {
    const { token, id } = await user();
    reply = () =>
      Promise.reject(
        Object.assign(new Error('throttled'), {
          name: 'ThrottlingException',
          $metadata: { httpStatusCode: 429 },
        }),
      );
    const res = await agent(token).expect(200);
    expect(events(res.text)).toEqual([
      {
        type: 'error',
        error:
          'The assistant could not respond: The AI provider is busy; retry shortly',
      },
    ]);
    expect(await charges(id)).toHaveLength(0);
  });

  it('aborts the Bedrock call when the client disconnects, without charging', async () => {
    const { token, id } = await user();
    let signal: AbortSignal | undefined;
    reply = (command) => {
      signal = command.abortSignal;
      async function* hanging(): AsyncGenerator<ConverseStreamOutput> {
        yield {
          contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi' } },
        };
        await new Promise((resolve) =>
          command.abortSignal?.addEventListener('abort', resolve),
        );
        yield {
          metadata: {
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            metrics: { latencyMs: 1 },
          },
        };
      }
      return { stream: hanging() };
    };

    const { port } = app.getHttpServer().address() as AddressInfo;
    const body = JSON.stringify(fixture.input);
    // Read the first SSE chunk, then drop the connection like a closed tab.
    const firstChunk = await new Promise<{ status?: number; text: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: `${PREFIX}/studio/agent`,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            res.once('data', (chunk: Buffer) => {
              resolve({ status: res.statusCode, text: chunk.toString('utf8') });
              req.destroy();
            });
          },
        );
        req.on('error', (error) => {
          if (!req.destroyed) reject(error);
        });
        req.end(body);
      },
    );
    expect(firstChunk.status).toBe(200);
    expect(firstChunk.text).toContain('"type":"text"');

    await waitFor(() => signal?.aborted === true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await charges(id)).toHaveLength(0);
  });
});
