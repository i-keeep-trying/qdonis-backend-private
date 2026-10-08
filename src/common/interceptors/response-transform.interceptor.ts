import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import type { Response } from 'express';
import { type Observable, map, tap } from 'rxjs';

/** Requests slower than this are logged at `warn` so they surface in triage. */
const SLOW_REQUEST_THRESHOLD_MS = 1_000;

/**
 * Normalises successful responses.
 *
 * Deliberately does *not* wrap payloads in a `{ data: ... }` envelope. Response
 * bodies stay the plain resource shape, which keeps them aligned with the
 * Swagger schema and means a frontend consumes `response.json()` directly. The
 * error path is the only place with an added structure, and that is handled by
 * `AllExceptionsFilter`.
 *
 * What it does do:
 *   * Runs `instanceToPlain` so `@Exclude()` on entities is honoured — this is
 *     what keeps `passwordHash` out of every response.
 *   * Emits an `X-Response-Time` header and logs slow requests.
 */
@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseTransformInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = process.hrtime.bigint();
    const http = context.switchToHttp();
    const response = http.getResponse<Response>();

    return next.handle().pipe(
      map((payload: unknown) =>
        // `excludeExtraneousValues` is off on purpose: plain objects returned
        // by services would otherwise be emptied out.
        instanceToPlain(payload, { enableCircularCheck: true }),
      ),
      tap(() => {
        const elapsedMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const rounded = elapsedMs.toFixed(1);

        if (!response.headersSent) {
          response.setHeader('X-Response-Time', `${rounded}ms`);
        }

        if (elapsedMs > SLOW_REQUEST_THRESHOLD_MS) {
          const request = http.getRequest<{
            method: string;
            originalUrl: string;
          }>();
          this.logger.warn(
            `Slow request ${request.method} ${request.originalUrl} took ${rounded}ms`,
          );
        }
      }),
    );
  }
}
