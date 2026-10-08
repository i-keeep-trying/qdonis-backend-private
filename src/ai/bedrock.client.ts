import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { AppConfiguration } from '../config/configuration';

export interface BedrockResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/** Failure with a message that is safe to show to the user. */
export class BedrockError extends Error {}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The AI request was rejected; try shortening the input',
  403: 'The AI provider refused the request (configuration)',
  404: 'The AI model is not available',
  429: 'The AI provider is busy; retry shortly',
  500: 'The AI provider failed; retry the request',
  503: 'The AI provider is unavailable; retry the request',
};

/** Minimal client for the Bedrock Converse API (bearer API key auth). */
@Injectable()
export class BedrockClient {
  private readonly logger = new Logger(BedrockClient.name);

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  private settings(): AppConfiguration['bedrock'] {
    return this.config.get('bedrock', { infer: true });
  }

  assertConfigured(): void {
    if (!this.settings().apiKey) {
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

  async converse(params: {
    modelId: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    temperature: number;
    maxTokens: number;
    signal: AbortSignal;
  }): Promise<BedrockResult> {
    const { apiKey, region, maxOutputTokens, timeoutMs } = this.settings();
    const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(params.modelId)}/converse`;
    const timeout = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey ?? ''}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          messages: params.messages.map((m) => ({
            role: m.role,
            content: [{ text: m.content }],
          })),
          inferenceConfig: {
            maxTokens: Math.min(params.maxTokens, maxOutputTokens),
            temperature: params.temperature,
          },
        }),
        signal: AbortSignal.any([params.signal, timeout]),
      });
    } catch (error) {
      if (timeout.aborted)
        throw new BedrockError(
          'The AI request timed out; retry with a smaller input',
        );
      if (params.signal.aborted) throw new BedrockError('Request cancelled');
      this.logger.error(
        `Bedrock network error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BedrockError(
        'Could not reach the AI provider; retry the request',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        `Bedrock ${response.status} for ${params.modelId}: ${detail.slice(0, 500)}`,
      );
      throw new BedrockError(
        STATUS_MESSAGES[response.status] ?? 'The AI request failed',
      );
    }

    const data = (await response.json()) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    const content = (data.output?.message?.content ?? [])
      .map((part) => part.text ?? '')
      .join('');
    if (!content)
      throw new BedrockError('The AI provider returned an empty response');
    return {
      content,
      inputTokens: Math.max(0, Math.floor(data.usage?.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.floor(data.usage?.outputTokens ?? 0)),
    };
  }
}
