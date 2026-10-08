import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Prisma } from '../../generated/prisma/client';

/** Stable error envelope returned for every failed request. */
export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
  /** Machine-readable discriminator for clients that branch on failures. */
  code?: string;
  /** Per-field messages produced by `ValidationPipe`. */
  details?: string[];
  /** Structured, client-safe context for specific codes (e.g. token balance). */
  meta?: Record<string, unknown>;
  /** Correlates the response with server logs (also in `X-Request-Id`). */
  requestId?: string;
  path: string;
  timestamp: string;
}

/** Numeric copies so comparisons with plain 
umber statuses are type-safe. */
const STATUS_SERVER_ERROR: number = HttpStatus.INTERNAL_SERVER_ERROR;
const STATUS_UNAVAILABLE: number = HttpStatus.SERVICE_UNAVAILABLE;
const STATUS_TOO_MANY: number = HttpStatus.TOO_MANY_REQUESTS;

export type MappedError = Pick<
  ErrorResponseBody,
  'statusCode' | 'error' | 'message' | 'code'
>;

/**
 * Single exit point for all errors leaving the HTTP layer.
 *
 *  1. Clients get one predictable shape regardless of the error's origin.
 *  2. Unexpected failures are logged with a stack trace but answered with a
 *     generic message, so internals and SQL never reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { id?: unknown }>();
    const response = ctx.getResponse<Response>();

    const mapped = this.map(exception);
    const requestId = typeof request.id === 'string' ? request.id : undefined;
    const path = request.originalUrl.split('?')[0];

    const body: ErrorResponseBody = {
      ...mapped,
      ...(requestId ? { requestId } : {}),
      path,
      timestamp: new Date().toISOString(),
    };
    if (exception instanceof HttpException) {
      const details = AllExceptionsFilter.validationDetails(exception);
      if (details) body.details = details;
      const payload = exception.getResponse();
      const meta =
        typeof payload === 'object' && payload !== null
          ? (payload as { meta?: unknown }).meta
          : undefined;
      if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
        body.meta = meta as Record<string, unknown>;
      }
    }

    const line = `${request.method} ${path} -> ${body.statusCode}${body.code ? ` ${body.code}` : ''}: ${body.message}`;
    if (body.statusCode >= STATUS_SERVER_ERROR) {
      this.logger.error(
        line,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(line);
    }

    if (response.headersSent) return;
    if (body.statusCode === STATUS_UNAVAILABLE) {
      response.setHeader('Retry-After', '5');
    }
    response.status(body.statusCode).json(body);
  }

  private map(exception: unknown): MappedError {
    if (exception instanceof HttpException)
      return this.fromHttpException(exception);

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception);
    }
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'The request could not be processed against the data model',
        code: 'DB_VALIDATION_FAILED',
      };
    }
    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return databaseUnavailable();
    }

    const bodyParser = this.fromBodyParserError(exception);
    if (bodyParser) return bodyParser;

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      code: 'INTERNAL_ERROR',
    };
  }

  private fromHttpException(exception: HttpException): MappedError {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      const isValidation = Array.isArray(record.message);
      const code =
        typeof record.code === 'string'
          ? record.code
          : isValidation
            ? 'VALIDATION_FAILED'
            : status === STATUS_TOO_MANY
              ? 'RATE_LIMITED'
              : undefined;

      return {
        statusCode: status,
        error:
          typeof record.error === 'string' ? record.error : statusName(status),
        message: isValidation
          ? 'Request validation failed'
          : typeof record.message === 'string'
            ? record.message
            : exception.message,
        ...(code ? { code } : {}),
      };
    }

    return {
      statusCode: status,
      error: statusName(status),
      message: typeof payload === 'string' ? payload : exception.message,
      ...(status === STATUS_TOO_MANY ? { code: 'RATE_LIMITED' } : {}),
    };
  }

  /**
   * Translates the Prisma codes worth distinguishing. The driver message is
   * never forwarded because it embeds table and column names.
   */
  private fromPrismaError(
    error: Prisma.PrismaClientKnownRequestError,
  ): MappedError {
    switch (error.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: 'A record with these details already exists',
          code: 'UNIQUE_VIOLATION',
        };
      case 'P2003':
      case 'P2014':
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: 'The change violates a relation between records',
          code: 'FOREIGN_KEY_VIOLATION',
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          error: 'Not Found',
          message: 'The requested record does not exist',
          code: 'RECORD_NOT_FOUND',
        };
      case 'P2034':
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: 'The record was modified concurrently; retry the request',
          code: 'TRANSACTION_CONFLICT',
        };
      case 'P2000':
      case 'P2006':
      case 'P2007':
      case 'P2011':
      case 'P2023':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: 'A value is invalid for the data model',
          code: 'DB_VALIDATION_FAILED',
        };
      case 'P1001':
      case 'P1002':
      case 'P1008':
      case 'P1017':
      case 'P2024':
        return databaseUnavailable();
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Internal Server Error',
          message: 'A database error occurred',
          code: 'DB_ERROR',
        };
    }
  }

  private fromBodyParserError(exception: unknown): MappedError | null {
    return mapBodyParserError(exception);
  }

  private static validationDetails(
    exception: HttpException,
  ): string[] | undefined {
    const payload = exception.getResponse();
    if (typeof payload !== 'object' || payload === null) return undefined;
    const message = (payload as { message?: unknown }).message;
    return Array.isArray(message)
      ? message.map((entry) => String(entry))
      : undefined;
  }
}

/**
 * body-parser errors (malformed JSON, oversized body) carry a `type`. They are
 * raised in Express middleware, before Nest's filters apply, so this is also
 * used by the Express error handler registered in `configureApp`.
 */
export function mapBodyParserError(exception: unknown): MappedError | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const { type } = exception as { type?: unknown };
  if (type === 'entity.too.large') {
    return {
      statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
      error: 'Payload Too Large',
      message: 'Request body is too large',
      code: 'PAYLOAD_TOO_LARGE',
    };
  }
  if (type === 'entity.parse.failed') {
    return {
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: 'Request body is not valid JSON',
      code: 'MALFORMED_JSON',
    };
  }
  if (
    type === 'encoding.unsupported' ||
    type === 'charset.unsupported' ||
    type === 'entity.verify.failed'
  ) {
    return {
      statusCode: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      error: 'Unsupported Media Type',
      message: 'Unsupported request encoding',
      code: 'UNSUPPORTED_ENCODING',
    };
  }
  return null;
}

function databaseUnavailable(): MappedError {
  return {
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    error: 'Service Unavailable',
    message: 'The service is temporarily unavailable; retry shortly',
    code: 'DB_UNAVAILABLE',
  };
}

function statusName(status: number): string {
  const name = Object.entries(HttpStatus).find(
    ([, value]) => Number(value) === status,
  )?.[0];
  return name
    ? name
        .toLowerCase()
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
    : 'Error';
}
