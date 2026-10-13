import {
  type ContentBlock,
  ConverseCommand,
  type ConverseCommandInput,
  ConverseStreamCommand,
  type ConverseStreamOutput,
  type TokenUsage,
} from '@aws-sdk/client-bedrock-runtime';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import type { AppConfiguration } from '../../config/configuration';
import {
  BEDROCK_MESSAGES,
  BedrockError,
  toBedrockError,
} from './bedrock-errors';
import {
  BEDROCK_RUNTIME,
  type BedrockConverseResult,
  type BedrockRequest,
  type BedrockRuntime,
  type BedrockStreamEvent,
  type BedrockUsage,
} from './bedrock.types';

/**
 * A stream that produces no event for this long is treated as wedged
 * (qdonis-core BEDROCK_STREAM_READ_TIMEOUT = 60 s).
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Exception members a ConverseStream can carry instead of data. */
const STREAM_EXCEPTIONS = [
  ['internalServerException', 'InternalServerException'],
  ['modelStreamErrorException', 'ModelStreamErrorException'],
  ['validationException', 'ValidationException'],
  ['throttlingException', 'ThrottlingException'],
  ['serviceUnavailableException', 'ServiceUnavailableException'],
] as const;

const toUsage = (usage: TokenUsage | undefined): BedrockUsage => {
  const count = (n: number | undefined) => Math.max(0, Math.floor(n ?? 0));
  return {
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    totalTokens: count(usage?.totalTokens),
  };
};

/** Rejects as soon as `signal` aborts, even if `promise` never settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // The losing promise must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  const reason = () =>
    signal.reason instanceof Error ? signal.reason : new Error('Aborted');
  if (signal.aborted) return Promise.reject(reason());
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(reason());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener('abort', onAbort),
  );
}

/** One ConverseStream event -> zero or more normalised events. */
export function mapStreamEvent(
  event: ConverseStreamOutput,
): BedrockStreamEvent[] {
  if (typeof event !== 'object' || event === null) return [];
  for (const [member, name] of STREAM_EXCEPTIONS) {
    const failure = event[member];
    if (failure) {
      throw Object.assign(new Error(failure.message ?? name), { name });
    }
  }
  if (event.contentBlockStart) {
    const toolUse = event.contentBlockStart.start?.toolUse;
    if (!toolUse) return [];
    return [
      {
        type: 'tool_use_start',
        index: event.contentBlockStart.contentBlockIndex ?? 0,
        id: toolUse.toolUseId ?? '',
        name: toolUse.name ?? '',
      },
    ];
  }
  if (event.contentBlockDelta) {
    const index = event.contentBlockDelta.contentBlockIndex ?? 0;
    const delta = event.contentBlockDelta.delta;
    if (delta?.text) return [{ type: 'text', index, text: delta.text }];
    if (delta?.toolUse !== undefined) {
      return [
        { type: 'tool_use_delta', index, input: delta.toolUse.input ?? '' },
      ];
    }
    return [];
  }
  if (event.messageStop) {
    return [{ type: 'stop', stopReason: event.messageStop.stopReason }];
  }
  if (event.metadata) {
    return [{ type: 'usage', usage: toUsage(event.metadata.usage) }];
  }
  return [];
}

/**
 * Shared Bedrock Converse client (blocking and streaming). Feature services
 * build the request (system prompt, tools, multi-block messages); this class
 * owns auth checks, model allowlisting, timeouts, cancellation and error
 * mapping.
 */
@Injectable()
export class BedrockClient {
  private readonly logger = new Logger(BedrockClient.name);

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    @Inject(BEDROCK_RUNTIME) private readonly runtime: BedrockRuntime,
  ) {}

  private settings(): AppConfiguration['bedrock'] {
    return this.config.get('bedrock', { infer: true });
  }

  assertConfigured(): void {
    if (this.settings().authMode === 'none') {
      throw AppError.unavailable(
        ErrorCode.AiNotConfigured,
        'AI features are not configured on this server',
      );
    }
  }

  /** Validated model id: requested if allowlisted, else the default. */
  resolveModel(requested?: string): string {
    const { allowedModels } = this.settings();
    if (!requested) return allowedModels[0];
    if (!allowedModels.includes(requested)) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'This AI model is not allowed',
      );
    }
    return requested;
  }

  /** The exact SDK input for a request (also used by parity tests). */
  toConverseInput(request: BedrockRequest): ConverseCommandInput {
    const { maxOutputTokens } = this.settings();
    return buildConverseInput(request, maxOutputTokens);
  }

  async converse(request: BedrockRequest): Promise<BedrockConverseResult> {
    const deadline = AbortSignal.timeout(this.settings().timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    try {
      const output = await untilAborted(
        this.runtime.send(new ConverseCommand(this.toConverseInput(request)), {
          abortSignal: signal,
        }),
        signal,
      );
      const content: ContentBlock[] = output.output?.message?.content ?? [];
      const text = content.map((block) => block.text ?? '').join('');
      if (!text && !content.some((block) => block.toolUse)) {
        throw new BedrockError(BEDROCK_MESSAGES.empty);
      }
      return {
        text,
        content,
        usage: toUsage(output.usage),
        stopReason: output.stopReason,
      };
    } catch (error) {
      throw toBedrockError(
        error,
        { timedOut: deadline.aborted, aborted: request.signal.aborted },
        this.logger,
        request.modelId,
      );
    }
  }

  /**
   * Streams one Converse call as normalised events. Ends early (throwing a
   * {@link BedrockError}) on cancellation, on the overall deadline
   * (BEDROCK_TIMEOUT_MS) and when no event arrives for
   * {@link STREAM_IDLE_TIMEOUT_MS}.
   */
  async *converseStream(
    request: BedrockRequest,
  ): AsyncGenerator<BedrockStreamEvent, void, undefined> {
    const deadline = AbortSignal.timeout(this.settings().timeoutMs);
    const idle = new AbortController();
    let idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_TIMEOUT_MS);
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_TIMEOUT_MS);
    };
    const signal = AbortSignal.any([request.signal, deadline, idle.signal]);

    try {
      const output = await untilAborted(
        this.runtime.send(
          new ConverseStreamCommand(this.toConverseInput(request)),
          { abortSignal: signal },
        ),
        signal,
      );
      if (!output.stream) throw new BedrockError(BEDROCK_MESSAGES.empty);
      const iterator = output.stream[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await untilAborted(iterator.next(), signal);
          if (next.done) break;
          touch();
          for (const event of mapStreamEvent(next.value)) yield event;
        }
      } finally {
        // Release the HTTP stream; never wait on it.
        void iterator.return?.().catch(() => undefined);
      }
    } catch (error) {
      throw toBedrockError(
        error,
        {
          timedOut: deadline.aborted || idle.signal.aborted,
          aborted: request.signal.aborted,
        },
        this.logger,
        request.modelId,
      );
    } finally {
      clearTimeout(idleTimer);
    }
  }
}

/** Request -> SDK input. `system` and `toolConfig` only when present. */
export function buildConverseInput(
  request: BedrockRequest,
  maxOutputTokens: number,
): ConverseCommandInput {
  const input: ConverseCommandInput = {
    modelId: request.modelId,
    messages: request.messages,
    inferenceConfig: {
      maxTokens: Math.min(request.maxTokens, maxOutputTokens),
      temperature: request.temperature,
    },
  };
  const system = (request.system ?? []).filter((text) => text.length > 0);
  if (system.length) input.system = system.map((text) => ({ text }));
  if (request.toolConfig) input.toolConfig = request.toolConfig;
  return input;
}
