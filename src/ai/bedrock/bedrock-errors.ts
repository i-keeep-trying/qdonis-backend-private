import type { Logger } from '@nestjs/common';

/** Failure with a message that is safe to show to the user. */
export class BedrockError extends Error {}

export const BEDROCK_MESSAGES = {
  timeout: 'The AI request timed out; retry with a smaller input',
  cancelled: 'Request cancelled',
  network: 'Could not reach the AI provider; retry the request',
  empty: 'The AI provider returned an empty response',
  failed: 'The AI request failed',
} as const;

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The AI request was rejected; try shortening the input',
  403: 'The AI provider refused the request (configuration)',
  404: 'The AI model is not available',
  429: 'The AI provider is busy; retry shortly',
  500: 'The AI provider failed; retry the request',
  503: 'The AI provider is unavailable; retry the request',
};

/** SDK exception names (incl. in-stream ones) without an HTTP status. */
const NAME_STATUS: Record<string, number> = {
  ValidationException: 400,
  AccessDeniedException: 403,
  UnrecognizedClientException: 403,
  ResourceNotFoundException: 404,
  ThrottlingException: 429,
  ServiceQuotaExceededException: 429,
  InternalServerException: 500,
  ModelStreamErrorException: 500,
  ModelErrorException: 500,
  ServiceUnavailableException: 503,
  ModelNotReadyException: 503,
};

/** Network-level failures (no response from the provider). */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'TimeoutError',
  'NetworkingError',
]);

interface SdkErrorShape {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

export interface ErrorContext {
  /** The per-call deadline or the stream idle watchdog fired. */
  timedOut: boolean;
  /** The caller cancelled (client disconnected). */
  aborted: boolean;
}

/**
 * Maps any SDK / network error to a user-safe {@link BedrockError}. Logs the
 * error name, status and message only, never the error object (it can carry
 * the signed request).
 */
export function toBedrockError(
  error: unknown,
  context: ErrorContext,
  logger: Logger,
  modelId: string,
): BedrockError {
  if (error instanceof BedrockError) return error;
  if (context.timedOut) return new BedrockError(BEDROCK_MESSAGES.timeout);
  if (context.aborted) return new BedrockError(BEDROCK_MESSAGES.cancelled);

  const shape: SdkErrorShape =
    typeof error === 'object' && error !== null ? error : {};
  const name = typeof shape.name === 'string' ? shape.name : 'Error';
  const message =
    typeof shape.message === 'string' ? shape.message : String(error);
  const code = typeof shape.code === 'string' ? shape.code : undefined;
  const httpStatus = shape.$metadata?.httpStatusCode;
  const status =
    typeof httpStatus === 'number' && httpStatus >= 400
      ? httpStatus
      : NAME_STATUS[name];

  if (
    status === undefined &&
    (NETWORK_CODES.has(name) || (code && NETWORK_CODES.has(code)))
  ) {
    logger.error(`Bedrock network error (${name}): ${message.slice(0, 500)}`);
    return new BedrockError(BEDROCK_MESSAGES.network);
  }
  logger.warn(
    `Bedrock ${status ?? 'error'} ${name} for ${modelId}: ${message.slice(0, 500)}`,
  );
  return new BedrockError(
    (status !== undefined ? STATUS_MESSAGES[status] : undefined) ??
      BEDROCK_MESSAGES.failed,
  );
}
