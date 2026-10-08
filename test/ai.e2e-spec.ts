import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { type MailMessage, MailTransport } from '../src/mail/mail.transport';
import { PrismaService } from '../src/prisma/prisma.service';

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

interface SseEvent {
  done?: boolean;
  error?: string;
  content?: string;
  charged?: number;
  balance?: number;
  usage?: { totalTokens: number };
}

function lastEvent(text: string): SseEvent {
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);
  return events[events.length - 1];
}

describe('AI proxy (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;
  const realFetch = global.fetch;
  let bedrock: { status: number; body: unknown };
  let lastBedrockBody: { inferenceConfig?: { maxTokens: number } } | null =
    null;

  beforeAll(async () => {
    jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('bedrock-runtime')) {
        lastBedrockBody = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        ) as typeof lastBedrockBody;
        return Promise.resolve(
          new Response(JSON.stringify(bedrock.body), {
            status: bedrock.status,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return realFetch(input, init);
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(new SilentMail())
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
      where: { email: { endsWith: '@ai.e2e.test' } },
    });
    await app.close();
    jest.restoreAllMocks();
  });

  async function user(): Promise<{ token: string; id: string }> {
    const email = `ai-${run}-${++counter}@ai.e2e.test`;
    await request(http)
      .post(`${PREFIX}/auth/register`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const row = await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date() },
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

  const converse = (token: string, body: Record<string, unknown>) =>
    request(http)
      .post(`${PREFIX}/ai/bedrock/converse`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        messages: [{ role: 'user', content: 'Design a 12V buck converter' }],
        ...body,
      });

  const balance = async (token: string) =>
    (
      (
        await request(http)
          .get(`${PREFIX}/billing/me`)
          .set('Authorization', `Bearer ${token}`)
      ).body as { balance: number }
    ).balance;

  it('requires authentication', async () => {
    await request(http)
      .post(`${PREFIX}/ai/bedrock/converse`)
      .send({ messages: [] })
      .expect(401);
  });

  it('streams the completion and charges provider-reported tokens server-side', async () => {
    const { token } = await user();
    bedrock = {
      status: 200,
      body: {
        output: { message: { content: [{ text: 'Use a 22uH inductor.' }] } },
        usage: { inputTokens: 700, outputTokens: 300 },
      },
    };
    const res = await converse(token, { maxTokens: 999_999 }).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    const ok = await converse(token, { maxTokens: 1000 }).expect(200);
    expect(ok.headers['content-type']).toMatch(/text\/event-stream/);
    expect(lastEvent(ok.text)).toMatchObject({
      done: true,
      content: 'Use a 22uH inductor.',
      charged: 1000,
      balance: 9000,
    });
    expect(await balance(token)).toBe(9000);
  });

  it('caps output tokens and rejects models outside the allowlist', async () => {
    const { token } = await user();
    await converse(token, {
      modelId: 'anthropic.claude-opus-expensive',
    }).expect(400);
    bedrock = {
      status: 200,
      body: {
        output: { message: { content: [{ text: 'x' }] } },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    };
    await converse(token, {}).expect(200);
    expect(lastBedrockBody?.inferenceConfig?.maxTokens).toBe(64000);
  });

  it('does not charge failed provider calls', async () => {
    const { token } = await user();
    bedrock = { status: 429, body: { message: 'throttled' } };
    const res = await converse(token, {}).expect(200);
    expect(lastEvent(res.text).error).toMatch(/busy/);
    expect(await balance(token)).toBe(10000);
  });

  it('refuses to start without tokens and never overcharges past zero', async () => {
    const { token, id } = await user();
    bedrock = {
      status: 200,
      body: {
        output: { message: { content: [{ text: 'long answer' }] } },
        usage: { inputTokens: 9000, outputTokens: 6000 },
      },
    };
    const res = await converse(token, {}).expect(200);
    expect(lastEvent(res.text)).toMatchObject({ charged: 10000, balance: 0 });
    expect(await balance(token)).toBe(0);

    const denied = await converse(token, {}).expect(402);
    expect(denied.body).toMatchObject({ code: 'INSUFFICIENT_TOKENS' });
    expect(
      await prisma.tokenLedgerEntry.count({
        where: { userId: id, amount: { lt: 0 } },
      }),
    ).toBe(1);
  });
});
