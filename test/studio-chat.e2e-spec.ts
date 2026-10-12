import { randomUUID } from 'node:crypto';

import type {
  ContentBlock,
  ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { BEDROCK_RUNTIME } from '../src/ai/bedrock/bedrock.types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { type MailMessage, MailTransport } from '../src/mail/mail.transport';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  type SentCommand,
  fakeRuntime,
  scriptedStream,
} from './helpers/bedrock-fakes';

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
const DOMAIN = 'studio-chat.e2e.test';
const run = Date.now().toString(36);
let counter = 0;
const USAGE = { inputTokens: 1000, outputTokens: 100 };

interface ChatEvent {
  type: string;
  [key: string]: unknown;
}

/** SSE frames (`event:` + `data:`) -> events. */
function eventsOf(text: string): ChatEvent[] {
  return text
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join(''),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as ChatEvent);
}

/** One model step: optional text, then tool calls, then usage. */
function step(
  text: string,
  tools: Array<{ id: string; name: string; input: unknown }> = [],
): ConverseStreamOutput[] {
  const out: ConverseStreamOutput[] = [{ messageStart: { role: 'assistant' } }];
  if (text) {
    out.push({ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } });
    out.push({ contentBlockStop: { contentBlockIndex: 0 } });
  }
  tools.forEach((tool, i) => {
    const index = i + 1;
    out.push({
      contentBlockStart: {
        contentBlockIndex: index,
        start: { toolUse: { toolUseId: tool.id, name: tool.name } },
      },
    });
    out.push({
      contentBlockDelta: {
        contentBlockIndex: index,
        delta: { toolUse: { input: JSON.stringify(tool.input) } },
      },
    });
    out.push({ contentBlockStop: { contentBlockIndex: index } });
  });
  out.push({
    messageStop: { stopReason: tools.length ? 'tool_use' : 'end_turn' },
  });
  out.push({
    metadata: {
      usage: { ...USAGE, totalTokens: USAGE.inputTokens + USAGE.outputTokens },
      metrics: { latencyMs: 1 },
    },
  });
  return out;
}

const lastUserBlocks = (command: SentCommand): ContentBlock[] => {
  const messages = command.input.messages ?? [];
  return messages[messages.length - 1]?.content ?? [];
};

describe('Studio chat agent (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;
  /** The model's next steps, consumed in order. */
  let script: ConverseStreamOutput[][] = [];
  // Plain Converse calls are the background project naming; streams are the chat agent.
  const fake = fakeRuntime((command) =>
    command.name === 'ConverseCommand'
      ? {
          output: {
            message: {
              role: 'assistant',
              content: [{ text: 'Chat Test Project' }],
            },
          },
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }
      : { stream: scriptedStream(script.shift() ?? step('Done.')) },
  );

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
      where: { email: { endsWith: `@${DOMAIN}` } },
    });
    await app.close();
  });

  async function signUp(): Promise<{ token: string; id: string }> {
    const email = `chat-${run}-${++counter}@${DOMAIN}`;
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

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function project(token: string, prompt?: string) {
    const created = await request(http)
      .post(`${PREFIX}/projects`)
      .set(as(token))
      .send({ name: 'Chat e2e', ...(prompt ? { prompt } : {}) })
      .expect(201);
    const id = (created.body as { id: string }).id;
    const ws = await request(http)
      .get(`${PREFIX}/projects/${id}/studio`)
      .set(as(token))
      .expect(200);
    return {
      id,
      branchId: (ws.body as { activeBranchId: string }).activeBranchId,
      pending: (ws.body as { pendingInitialPrompt: unknown })
        .pendingInitialPrompt,
    };
  }

  it('runs a turn: specs tool, approval widget, answer, topology tool', async () => {
    const owner = await signUp();
    const p = await project(owner.token, 'A 60 W buck, 24 V to 12 V');
    expect(p.pending).toEqual({
      id: 'initial',
      text: 'A 60 W buck, 24 V to 12 V',
    });

    script = [
      step('Here is the spec table.', [
        {
          id: 'tu_specs',
          name: 'update_specs',
          input: {
            application: '60 W buck',
            rows: [
              { name: 'Input Voltage', value: '24', unit: 'V' },
              { name: 'Output Voltage', value: '12', unit: 'V' },
            ],
            request_approval: true,
          },
        },
      ]),
    ];
    const sentBefore = fake.sent.length;
    const clientMessageId = randomUUID();
    const first = await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/messages`)
      .set(as(owner.token))
      .send({
        clientMessageId,
        text: 'A 60 W buck, 24 V to 12 V',
        attachmentIds: [],
        branchId: p.branchId,
        initialPromptId: 'initial',
      })
      .expect(200);
    expect(first.headers['content-type']).toMatch(/^text\/event-stream/);
    const events = eventsOf(first.text);
    expect(events.map((e) => e.type)).toEqual([
      'run.accepted',
      'message.started',
      'text.delta',
      'tool.started',
      'tool.finished',
      'workspace.updated',
      'widget',
      'usage',
      'run.completed',
    ]);
    // A blocking widget ends the turn after one model step.
    expect(fake.sent.length - sentBefore).toBe(1);
    expect((events[0].userMessage as { id: string }).id).toBe(clientMessageId);
    expect(events[4]).toMatchObject({ status: 'done' });
    expect(String(events[4].summary)).toContain('2 rows');
    expect(events[5]).toMatchObject({ stages: ['specs'], focus: 'specs' });
    const widget = events[6].widget as { id: string; kind: string };
    expect(widget.kind).toBe('spec_approval');
    expect(events[7]).toMatchObject({ tokensUsed: 1100 });
    const messageId = (events[1].message as { id: string }).id;

    const specs = await request(http)
      .get(`${PREFIX}/projects/${p.id}/branches/${p.branchId}/stages/specs`)
      .set(as(owner.token))
      .expect(200);
    expect(
      (specs.body as { data: { rows: unknown[]; approved: boolean } }).data,
    ).toMatchObject({
      approved: false,
      rows: [
        expect.objectContaining({
          name: 'Input Voltage',
          value: '24',
          source: 'user',
        }),
        expect.objectContaining({ name: 'Output Voltage', value: '12' }),
      ],
    });
    const ws = await request(http)
      .get(`${PREFIX}/projects/${p.id}/studio`)
      .set(as(owner.token))
      .expect(200);
    expect(
      (ws.body as { pendingInitialPrompt: unknown }).pendingInitialPrompt,
    ).toBeNull();

    // Answering the approval approves the specs and starts the next turn.
    script = [
      step('', [
        {
          id: 'tu_topo',
          name: 'select_topology',
          input: { topology_id: 'dcdc_buck' },
        },
      ]),
      step('The buck schematic is loaded.'),
    ];
    const answered = await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/widgets/${widget.id}/answer`)
      .set(as(owner.token))
      .send({ messageId, answer: { kind: 'spec_approval', approve: true } })
      .expect(200);
    const second = eventsOf(answered.text);
    expect(second[0]).toMatchObject({
      type: 'run.accepted',
      userMessage: null,
    });
    expect(second.find((e) => e.type === 'tool.finished')).toMatchObject({
      toolUseId: 'tu_topo',
      status: 'done',
    });
    expect(
      second.find(
        (e) =>
          e.type === 'workspace.updated' &&
          (e.stages as string[]).includes('visualization'),
      ),
    ).toMatchObject({ focus: 'circuit' });
    expect(second.at(-1)).toMatchObject({ type: 'run.completed' });

    // The model saw the answer, then the tool result.
    const answerCall = fake.sent[fake.sent.length - 2];
    expect(JSON.stringify(lastUserBlocks(answerCall))).toContain('approved');
    // The snapshot in the system prompt already has the approval.
    const system = (answerCall.input.system ?? []) as Array<{ text?: string }>;
    expect(system[0]?.text).toContain('"approved": true');
    const resultCall = fake.sent[fake.sent.length - 1];
    expect(lastUserBlocks(resultCall)[0]).toMatchObject({
      toolResult: { toolUseId: 'tu_topo', status: 'success' },
    });

    const after = await request(http)
      .get(`${PREFIX}/projects/${p.id}/branches/${p.branchId}/stages/specs`)
      .set(as(owner.token))
      .expect(200);
    expect((after.body as { data: { approved: boolean } }).data.approved).toBe(
      true,
    );
    const circuit = await request(http)
      .get(
        `${PREFIX}/projects/${p.id}/branches/${p.branchId}/stages/visualization`,
      )
      .set(as(owner.token))
      .expect(200);
    expect(
      (circuit.body as { data: { topologyId: string } }).data.topologyId,
    ).toBe('dcdc_buck');

    // Stored conversation: blocks, the resolved widget, statuses.
    const page = await request(http)
      .get(`${PREFIX}/projects/${p.id}/chat?skip=0&take=50`)
      .set(as(owner.token))
      .expect(200);
    const items = (
      page.body as {
        items: Array<{
          id: string;
          sender: string;
          metadata: Record<string, unknown>;
        }>;
      }
    ).items;
    expect(items.map((i) => i.sender)).toEqual(['USER', 'AI', 'AI']);
    expect(items[0].id).toBe(clientMessageId);
    const blocks = items[1].metadata.blocks as Array<{
      type: string;
      widget?: { resolution: string | null; approved?: boolean };
    }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool', 'widget']);
    expect(blocks[2].widget).toMatchObject({
      resolution: 'Approved',
      approved: true,
    });
    expect(items[2].metadata.status).toBe('complete');

    // The same message id is never accepted twice; an answered widget stays answered.
    const dup = await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/messages`)
      .set(as(owner.token))
      .send({
        clientMessageId,
        text: 'again',
        attachmentIds: [],
        branchId: p.branchId,
      })
      .expect(409);
    expect((dup.body as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
    const twice = await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/widgets/${widget.id}/answer`)
      .set(as(owner.token))
      .send({ messageId, answer: { kind: 'spec_approval', approve: true } })
      .expect(409);
    expect((twice.body as { code: string }).code).toBe('WIDGET_ANSWERED');

    // Every model step was charged.
    const entries = (
      await prisma.tokenLedgerEntry.findMany({
        where: { userId: owner.id, amount: { lt: 0 } },
      })
    ).filter(
      (e) => (e.metadata as { step?: string } | null)?.step === 'studio_agent',
    );
    expect(entries).toHaveLength(3);
    expect(entries[0].metadata).toMatchObject({
      step: 'studio_agent',
      projectId: p.id,
    });
  });

  it('shows the project name as loading until the naming call ends', async () => {
    const owner = await signUp();
    const created = await request(http)
      .post(`${PREFIX}/projects`)
      .set(as(owner.token))
      .send({ prompt: 'A 60 W buck, 24 V to 12 V' })
      .expect(201);
    const body = created.body as { id: string; naming: boolean; name: string };
    expect(body).toMatchObject({ naming: true, name: 'My Project' });
    let detail = body;
    for (let i = 0; i < 100 && detail.naming; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      detail = (
        await request(http)
          .get(`${PREFIX}/projects/${body.id}`)
          .set(as(owner.token))
          .expect(200)
      ).body as typeof body;
    }
    expect(detail).toMatchObject({ naming: false, name: 'Chat Test Project' });
    // Named projects (no prompt, or a given name) never show as loading.
    const plain = await request(http)
      .post(`${PREFIX}/projects`)
      .set(as(owner.token))
      .send({ name: 'Mine', prompt: 'x' })
      .expect(201);
    expect((plain.body as { naming: boolean }).naming).toBe(false);
  });

  it('finishes a turn after the client disconnects; the turn is picked up via runs/active', async () => {
    const owner = await signUp();
    const p = await project(owner.token);
    script = [
      step('Loading it.', [
        {
          id: 'tu_bg',
          name: 'select_topology',
          input: { topology_id: 'dcdc_buck' },
        },
      ]),
      step('The buck schematic is loaded.'),
    ];
    const { port } = (
      app.getHttpServer() as { address(): { port: number } }
    ).address();
    const aborter = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${port}${PREFIX}/projects/${p.id}/chat/messages`,
      {
        method: 'POST',
        headers: { ...as(owner.token), 'content-type': 'application/json' },
        body: JSON.stringify({
          clientMessageId: randomUUID(),
          text: 'show me a buck',
          attachmentIds: [],
          branchId: p.branchId,
        }),
        signal: aborter.signal,
      },
    );
    // Read the first event, then leave (refresh / closed tab).
    await res.body!.getReader().read();
    aborter.abort();

    let active: unknown = 'pending';
    for (let i = 0; i < 100 && active; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const r = await request(http)
        .get(`${PREFIX}/projects/${p.id}/chat/runs/active`)
        .set(as(owner.token))
        .expect(200);
      active = (r.body as { run: unknown }).run;
    }
    expect(active).toBeNull();
    const page = await request(http)
      .get(`${PREFIX}/projects/${p.id}/chat?skip=0&take=50`)
      .set(as(owner.token))
      .expect(200);
    const last = (
      page.body as {
        items: Array<{
          metadata: {
            status: string;
            blocks: Array<{ type: string; status?: string }>;
          };
        }>;
      }
    ).items.at(-1)!;
    expect(last.metadata.status).toBe('complete');
    expect(last.metadata.blocks.find((b) => b.type === 'tool')).toMatchObject({
      status: 'done',
    });
    const circuit = await request(http)
      .get(
        `${PREFIX}/projects/${p.id}/branches/${p.branchId}/stages/visualization`,
      )
      .set(as(owner.token))
      .expect(200);
    expect(
      (circuit.body as { data: { topologyId: string } }).data.topologyId,
    ).toBe('dcdc_buck');
  });

  it('keeps a tool failure inside the turn and reports it to the model', async () => {
    const owner = await signUp();
    const p = await project(owner.token);
    script = [
      step('', [{ id: 'tu_sim', name: 'run_simulation', input: {} }]),
      step('There is no design yet.'),
    ];
    const res = await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/messages`)
      .set(as(owner.token))
      .send({
        clientMessageId: randomUUID(),
        text: 'simulate',
        attachmentIds: [],
        branchId: p.branchId,
      })
      .expect(200);
    const events = eventsOf(res.text);
    expect(events.find((e) => e.type === 'tool.finished')).toMatchObject({
      status: 'error',
    });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
    const resultCall = fake.sent[fake.sent.length - 1];
    expect(lastUserBlocks(resultCall)[0]).toMatchObject({
      toolResult: { toolUseId: 'tu_sim', status: 'error' },
    });
  });

  it('checks access, input and the token balance before streaming', async () => {
    const owner = await signUp();
    const other = await signUp();
    const p = await project(owner.token);
    const body = {
      clientMessageId: randomUUID(),
      text: 'hi',
      attachmentIds: [],
      branchId: p.branchId,
    };
    await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/messages`)
      .send(body)
      .expect(401);
    await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/messages`)
      .set(as(other.token))
      .send(body)
      .expect(404);
    await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/messages`)
      .set(as(owner.token))
      .send({ ...body, text: '' })
      .expect(400);
    await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/messages`)
      .set(as(owner.token))
      .send({ ...body, branchId: 'br_missing' })
      .expect(404);
    // The token account is opened on first use; then spend it all.
    await request(http)
      .get(`${PREFIX}/billing/me`)
      .set(as(owner.token))
      .expect(200);
    await prisma.$executeRaw`UPDATE token_batches SET tokens_used = tokens_granted WHERE user_id = ${owner.id}::uuid`;
    const broke = await request(http)
      .post(`${PREFIX}/projects/${p.id}/chat/messages`)
      .set(as(owner.token))
      .send(body)
      .expect(402);
    expect((broke.body as { code: string }).code).toBe('INSUFFICIENT_TOKENS');
  });
});
