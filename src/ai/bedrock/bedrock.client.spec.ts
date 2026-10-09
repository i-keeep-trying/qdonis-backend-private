import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { HttpException, Logger } from '@nestjs/common';

import {
  fakeRuntime,
  scriptedStream,
  testBedrockClient,
} from '../../../test/helpers/bedrock-fakes';
import { BedrockError } from './bedrock-errors';
import { STREAM_IDLE_TIMEOUT_MS } from './bedrock.client';
import type { BedrockRequest, BedrockStreamEvent } from './bedrock.types';

const MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const request = (overrides: Partial<BedrockRequest> = {}): BedrockRequest => ({
  modelId: MODEL,
  messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
  maxTokens: 1000,
  temperature: 0.3,
  signal: new AbortController().signal,
  ...overrides,
});

async function collect(
  stream: AsyncIterable<BedrockStreamEvent>,
): Promise<BedrockStreamEvent[]> {
  const events: BedrockStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const okReply = {
  output: { message: { role: 'assistant', content: [{ text: 'Hello' }] } },
  usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  stopReason: 'end_turn',
};

describe('BedrockClient', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  describe('configuration checks', () => {
    it('answers 503 AI_NOT_CONFIGURED without credentials', () => {
      const client = testBedrockClient(fakeRuntime(() => okReply).runtime, {
        authMode: 'none',
      });
      expect(() => client.assertConfigured()).toThrow(HttpException);
    });

    it('allows only allowlisted models and defaults to the first', () => {
      const client = testBedrockClient(fakeRuntime(() => okReply).runtime);
      expect(client.resolveModel()).toBe(MODEL);
      expect(() => client.resolveModel('anthropic.opus')).toThrow(
        HttpException,
      );
    });
  });

  describe('converse', () => {
    it('sends system and tools only when present and caps maxTokens', async () => {
      const { runtime, sent } = fakeRuntime(() => okReply);
      const client = testBedrockClient(runtime, { maxOutputTokens: 500 });

      const result = await client.converse(request());
      expect(result).toMatchObject({
        text: 'Hello',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        stopReason: 'end_turn',
      });
      expect(sent[0].name).toBe('ConverseCommand');
      expect(sent[0].input).toEqual({
        modelId: MODEL,
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        inferenceConfig: { maxTokens: 500, temperature: 0.3 },
      });

      const toolConfig = {
        tools: [
          {
            toolSpec: {
              name: 't',
              description: 'd',
              inputSchema: { json: { type: 'object' } },
            },
          },
        ],
      };
      await client.converse(request({ system: ['Be brief'], toolConfig }));
      expect(sent[1].input.system).toEqual([{ text: 'Be brief' }]);
      expect(sent[1].input.toolConfig).toEqual(toolConfig);
      expect(sent[1].abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('rejects an empty reply', async () => {
      const client = testBedrockClient(
        fakeRuntime(() => ({ output: { message: { content: [] } } })).runtime,
      );
      await expect(client.converse(request())).rejects.toThrow(
        'The AI provider returned an empty response',
      );
    });

    it('accepts a tool-use-only reply', async () => {
      const client = testBedrockClient(
        fakeRuntime(() => ({
          output: {
            message: {
              content: [{ toolUse: { toolUseId: 'a', name: 'x', input: {} } }],
            },
          },
        })).runtime,
      );
      await expect(client.converse(request())).resolves.toMatchObject({
        text: '',
      });
    });

    it.each([
      [
        { $metadata: { httpStatusCode: 429 }, name: 'ThrottlingException' },
        /busy/,
      ],
      [{ name: 'ThrottlingException', message: 'slow down' }, /busy/],
      [{ name: 'ValidationException' }, /rejected/],
      [{ name: 'AccessDeniedException' }, /refused/],
      [{ name: 'ResourceNotFoundException' }, /not available/],
      [{ name: 'ServiceUnavailableException' }, /unavailable/],
      [
        Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
        /Could not reach/,
      ],
      [new Error('weird'), /^The AI request failed$/],
    ])('maps SDK error %o to a user-safe message', async (error, message) => {
      const client = testBedrockClient(
        fakeRuntime(() =>
          Promise.reject(
            error instanceof Error
              ? error
              : Object.assign(new Error('sdk failure'), error),
          ),
        ).runtime,
      );
      const failure = client.converse(request());
      await expect(failure).rejects.toBeInstanceOf(BedrockError);
      await expect(failure).rejects.toThrow(message);
    });

    it('reports a cancelled request', async () => {
      const aborter = new AbortController();
      const client = testBedrockClient(
        fakeRuntime(() => new Promise(() => undefined)).runtime,
      );
      const pending = client.converse(request({ signal: aborter.signal }));
      aborter.abort();
      await expect(pending).rejects.toThrow('Request cancelled');
    });
  });

  describe('converseStream', () => {
    const events: ConverseStreamOutput[] = [
      { messageStart: { role: 'assistant' } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi ' } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '' } } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: 'tu', name: 'ask_user' } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"q":' } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'there' } } },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '1}' } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: 'tool_use' } },
      {
        metadata: {
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          metrics: { latencyMs: 1 },
        },
      },
    ];

    it('maps interleaved text and tool blocks', async () => {
      const { runtime, sent } = fakeRuntime(() => ({
        stream: scriptedStream(events),
      }));
      const client = testBedrockClient(runtime);
      expect(await collect(client.converseStream(request()))).toEqual([
        { type: 'text', index: 0, text: 'Hi ' },
        { type: 'tool_use_start', index: 1, id: 'tu', name: 'ask_user' },
        { type: 'tool_use_delta', index: 1, input: '{"q":' },
        { type: 'text', index: 0, text: 'there' },
        { type: 'tool_use_delta', index: 1, input: '1}' },
        { type: 'stop', stopReason: 'tool_use' },
        {
          type: 'usage',
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        },
      ]);
      expect(sent[0].name).toBe('ConverseStreamCommand');
    });

    it('turns in-stream exceptions into user-safe errors', async () => {
      const client = testBedrockClient(
        fakeRuntime(() => ({
          stream: scriptedStream([
            events[1],
            {
              throttlingException: {
                name: 'ThrottlingException',
                message: 'x',
              },
            } as unknown as ConverseStreamOutput,
          ]),
        })).runtime,
      );
      const seen: BedrockStreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of client.converseStream(request()))
            seen.push(event);
        })(),
      ).rejects.toThrow(/busy/);
      expect(seen).toHaveLength(1);
    });

    it('aborts mid-stream when the caller cancels', async () => {
      const aborter = new AbortController();
      let signalSeen: AbortSignal | undefined;
      async function* hanging(): AsyncGenerator<ConverseStreamOutput> {
        yield events[1];
        await new Promise(() => undefined);
      }
      const client = testBedrockClient(
        fakeRuntime((command) => {
          signalSeen = command.abortSignal;
          return { stream: hanging() };
        }).runtime,
      );
      const stream = client.converseStream(request({ signal: aborter.signal }));
      const first = await stream.next();
      expect(first.value).toMatchObject({ type: 'text' });
      const second = stream.next();
      aborter.abort();
      await expect(second).rejects.toThrow('Request cancelled');
      expect(signalSeen?.aborted).toBe(true);
    });

    it('times out a stream that goes idle', async () => {
      jest.useFakeTimers();
      try {
        async function* stalled(): AsyncGenerator<ConverseStreamOutput> {
          yield events[1];
          await new Promise(() => undefined);
        }
        const client = testBedrockClient(
          fakeRuntime(() => ({ stream: stalled() })).runtime,
        );
        const stream = client.converseStream(request());
        await stream.next();
        const second = stream.next();
        const assertion = expect(second).rejects.toThrow(/timed out/);
        await jest.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
        await assertion;
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
