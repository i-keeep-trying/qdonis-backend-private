import type {
  ConverseCommandInput,
  ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { ConfigService } from '@nestjs/config';

import { BedrockClient } from '../../src/ai/bedrock/bedrock.client';
import type { BedrockRuntime } from '../../src/ai/bedrock/bedrock.types';
import type { AppConfiguration } from '../../src/config/configuration';

/** Test-only fakes for the Bedrock SDK client (unit and e2e specs). */
export const TEST_BEDROCK_SETTINGS: AppConfiguration['bedrock'] = {
  authMode: 'sigv4',
  accessKeyId: 'AKIATESTKEY000000000',
  secretAccessKey: 'test-secret-0000000000000000',
  region: 'us-east-1',
  allowedModels: ['us.anthropic.claude-sonnet-4-5-20250929-v1:0'],
  maxOutputTokens: 64_000,
  timeoutMs: 600_000,
};

export interface SentCommand {
  name: string;
  input: ConverseCommandInput;
  abortSignal?: AbortSignal;
}

export type FakeReply = (command: SentCommand) => unknown;

/** A fake SDK client recording every command it is sent. */
export function fakeRuntime(reply: FakeReply): {
  runtime: BedrockRuntime;
  sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  const send = (
    command: { constructor: { name: string }; input: ConverseCommandInput },
    options?: { abortSignal?: AbortSignal },
  ) => {
    const record = {
      name: command.constructor.name,
      input: command.input,
      abortSignal: options?.abortSignal,
    };
    sent.push(record);
    return Promise.resolve().then(() => reply(record));
  };
  return { runtime: { send } as unknown as BedrockRuntime, sent };
}

/** An SDK-like event stream; optional failure after `failAfter` events. */
export async function* scriptedStream(
  events: readonly ConverseStreamOutput[],
  failure?: { after: number; error: unknown },
): AsyncGenerator<ConverseStreamOutput> {
  for (const [index, event] of events.entries()) {
    if (failure && index >= failure.after) break;
    await Promise.resolve();
    yield event;
  }
  if (failure) throw failure.error;
}

export function testBedrockClient(
  runtime: BedrockRuntime,
  overrides: Partial<AppConfiguration['bedrock']> = {},
): BedrockClient {
  const settings = { ...TEST_BEDROCK_SETTINGS, ...overrides };
  const config = { get: () => settings } as unknown as ConfigService<
    AppConfiguration,
    true
  >;
  return new BedrockClient(config, runtime);
}
