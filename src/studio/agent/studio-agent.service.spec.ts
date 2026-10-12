import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@nestjs/common';

import {
  fakeRuntime,
  scriptedStream,
  testBedrockClient,
} from '../../../test/helpers/bedrock-fakes';
import {
  loadStudioFixtures,
  loadTopologyIds,
  type StudioFixture,
} from '../../../test/parity/studio-agent-fixtures';
import type { AiService } from '../../ai/ai.service';
import type { TopologiesService } from '../../topologies/topologies.service';
import type { StudioAgentRequestDto } from '../dto/studio-agent.dto';
import { STUDIO_ERROR_PREFIX, type StudioAgentEvent } from '../studio.types';
import { StudioAgentService } from './studio-agent.service';

const MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

function setup(
  reply: Parameters<typeof fakeRuntime>[0],
  chargeImpl: () => Promise<unknown> = () =>
    Promise.resolve({ charged: 1, balance: 1, multiplier: 1 }),
) {
  const { runtime, sent } = fakeRuntime(reply);
  const chargeUsage = jest.fn(chargeImpl);
  const ai = { prepare: jest.fn(() => Promise.resolve(MODEL)), chargeUsage };
  const service = new StudioAgentService(
    ai as unknown as AiService,
    testBedrockClient(runtime),
    { ids: () => loadTopologyIds() } as unknown as TopologiesService,
  );
  return { service, sent, chargeUsage };
}

const fixtureReply = (fixture: StudioFixture) => () => {
  const error = fixture.bedrock_error;
  if (error?.on_call) return Promise.reject(new Error(error.message));
  return {
    stream: scriptedStream(
      fixture.bedrock_stream,
      error
        ? { after: error.after_events ?? 0, error: new Error(error.message) }
        : undefined,
    ),
  };
};

async function run(
  service: StudioAgentService,
  dto: StudioAgentRequestDto,
  signal = new AbortController().signal,
): Promise<StudioAgentEvent[]> {
  const events: StudioAgentEvent[] = [];
  for await (const event of service.runStep('user-1', MODEL, dto, signal)) {
    events.push(event);
  }
  return events;
}

const dtoOf = (fixture: StudioFixture) =>
  ({
    messages: fixture.input.messages,
    project_state: fixture.input.project_state,
  }) as StudioAgentRequestDto;

/** Python error text carries the raw exception; Nest the user-safe message. */
const comparable = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) =>
    event.type === 'error'
      ? {
          type: 'error',
          prefix: String(event.error).startsWith(STUDIO_ERROR_PREFIX),
        }
      : event,
  );

describe('StudioAgentService', () => {
  beforeAll(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterAll(() => jest.restoreAllMocks());

  describe.each(loadStudioFixtures().map((f) => [f.name, f] as const))(
    'replays %s',
    (_, fixture) => {
      it('emits the same events as qdonis-core and charges once on completion', async () => {
        const { service, sent, chargeUsage } = setup(fixtureReply(fixture));
        const events = await run(service, dtoOf(fixture));

        expect(comparable(events)).toEqual(comparable(fixture.expected_events));
        expect(sent).toHaveLength(1);
        expect(sent[0].input.modelId).toBe(fixture.expected_request.modelId);
        expect(sent[0].input.system).toEqual(fixture.expected_request.system);

        const done = fixture.expected_events.find((e) => e.type === 'done');
        const usage = done?.usage as
          { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (usage?.prompt_tokens !== undefined) {
          expect(chargeUsage).toHaveBeenCalledTimes(1);
          expect(chargeUsage).toHaveBeenCalledWith('user-1', {
            modelId: MODEL,
            step: 'studio_agent',
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
          });
        } else {
          expect(chargeUsage).not.toHaveBeenCalled();
        }
      });
    },
  );

  const dto = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  } as StudioAgentRequestDto;
  const textEvent: ConverseStreamOutput = {
    contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hel' } },
  };

  it('stops silently and charges nothing when the client disconnects', async () => {
    const aborter = new AbortController();
    async function* hanging(): AsyncGenerator<ConverseStreamOutput> {
      yield textEvent;
      await new Promise(() => undefined);
    }
    const { service, sent, chargeUsage } = setup(() => ({ stream: hanging() }));

    const events: StudioAgentEvent[] = [];
    const done = (async () => {
      for await (const event of service.runStep(
        'user-1',
        MODEL,
        dto,
        aborter.signal,
      )) {
        events.push(event);
        aborter.abort();
      }
    })();
    await done;

    expect(events).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(sent[0].abortSignal?.aborted).toBe(true);
    expect(chargeUsage).not.toHaveBeenCalled();
  });

  it('reports a charging failure as an error event (no tool calls, no done)', async () => {
    const { service } = setup(
      () => ({
        stream: scriptedStream([
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 't', name: 'run_design' } },
            },
          },
          {
            metadata: {
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              metrics: { latencyMs: 1 },
            },
          },
        ]),
      }),
      () => Promise.reject(new Error('db down')),
    );
    expect(await run(service, dto)).toEqual([
      {
        type: 'error',
        error: `${STUDIO_ERROR_PREFIX}The AI request failed; please retry`,
      },
    ]);
  });

  it('maps a provider error to the user-safe message', async () => {
    const { service, chargeUsage } = setup(() =>
      Promise.reject(
        Object.assign(new Error('x'), { name: 'ThrottlingException' }),
      ),
    );
    expect(await run(service, dto)).toEqual([
      {
        type: 'error',
        error: `${STUDIO_ERROR_PREFIX}The AI provider is busy; retry shortly`,
      },
    ]);
    expect(chargeUsage).not.toHaveBeenCalled();
  });
});
