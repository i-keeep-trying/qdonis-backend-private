import { HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

import { BedrockError } from '../ai/bedrock/bedrock-errors';

const HEARTBEAT_MS = 20_000;
const logger = new Logger('DesignStepStream');

/** Work started after every pre-check passed; gets a signal that aborts on disconnect. */
export type StreamedWork<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Answers a long AI step as Server-Sent Events, like `/ai/bedrock/converse`:
 * `: heartbeat` comments every 20 s (so proxies keep the connection open),
 * then exactly one `data:` event — `{ done: true, result }` or
 * `{ error: { statusCode, code, message, meta? } }`. Validation, access and
 * balance failures are thrown before this is called, as normal JSON errors.
 */
export async function streamResult<T>(
  response: Response,
  work: StreamedWork<T>,
  requestId?: string,
): Promise<void> {
  const aborter = new AbortController();
  response.on('close', () => {
    if (!response.writableFinished) aborter.abort();
  });
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const send = (payload: unknown) => {
    if (!response.writableEnded)
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);

  try {
    send({ done: true, result: await work(aborter.signal) });
  } catch (error) {
    send({ error: describeError(error, requestId) });
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}

function describeError(error: unknown, requestId?: string) {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const record =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    return {
      statusCode: error.getStatus(),
      code: typeof record.code === 'string' ? record.code : undefined,
      message:
        typeof record.message === 'string' ? record.message : error.message,
      ...(typeof record.meta === 'object' && record.meta !== null
        ? { meta: record.meta }
        : {}),
    };
  }
  if (error instanceof BedrockError) {
    return { statusCode: 502, code: 'AI_ERROR', message: error.message };
  }
  logger.error(
    `Design step failed (${requestId ?? 'n/a'}): ${error instanceof Error ? error.message : String(error)}`,
    error instanceof Error ? error.stack : undefined,
  );
  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'The step failed; please retry',
  };
}
