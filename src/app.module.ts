import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Module, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import {
  AUTH_THROTTLE_KEY,
  AUTH_THROTTLER,
} from './common/decorators/auth-throttle.decorator';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';
import { REQUEST_ID_HEADER, resolveRequestId } from './common/request-id';
import { AppConfigModule } from './config/config.module';
import type { AppConfiguration } from './config/configuration';
import { DocumentsModule } from './documents/documents.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.module';
import { StudioModule } from './studio/studio.module';
import { UsersModule } from './users/users.module';

/** Paths whose successful requests are not access-logged (probe noise). */
const QUIET_PATHS = new Set(['/health', '/health/live', '/favicon.ico']);

@Module({
  imports: [
    // Must come first: everything below resolves its options from ConfigService.
    AppConfigModule,

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => {
        const logging = config.get('logging', { infer: true });
        const app = config.get('app', { infer: true });

        return {
          // Express 5 / path-to-regexp v8 named-splat form.
          forRoutes: [{ path: '{*splat}', method: RequestMethod.ALL }],
          pinoHttp: {
            level: logging.level,
            ...(logging.pretty
              ? {
                  transport: {
                    target: 'pino-pretty',
                    options: {
                      singleLine: true,
                      translateTime: 'SYS:HH:MM:ss.l',
                    },
                  },
                }
              : {}),
            // Correlation id: honour a sane inbound X-Request-Id (from a proxy
            // or the client), otherwise mint one; echo it on the response.
            genReqId: (request: IncomingMessage, response: ServerResponse) => {
              const id =
                resolveRequestId(request.headers[REQUEST_ID_HEADER]) ??
                randomUUID();
              response.setHeader('X-Request-Id', id);
              return id;
            },
            // Credentials must never reach the log stream, even at trace level.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["stripe-signature"]',
                'res.headers["set-cookie"]',
                'req.body.password',
                'req.body.currentPassword',
                'req.body.newPassword',
                'req.body.token',
                'req.query.code',
                'req.query.state',
                'req.query.token',
                // Bedrock credentials, should a config or SDK object be logged.
                '*.secretAccessKey',
                '*.accessKeyId',
                '*.apiKey',
                '*.credentials',
                '*.token',
                '*.AWS_SECRET_ACCESS_KEY',
                '*.AWS_ACCESS_KEY_ID',
                '*.BEDROCK_API_KEY',
              ],
              censor: '[redacted]',
            },
            // Query strings may carry OAuth codes; log the path only.
            serializers: {
              req: (request: {
                id: unknown;
                method: string;
                url: string;
                remoteAddress?: string;
              }) => ({
                id: request.id,
                method: request.method,
                url: request.url.split('?')[0],
                remoteAddress: request.remoteAddress,
              }),
            },
            autoLogging: {
              ignore: (request: IncomingMessage) =>
                QUIET_PATHS.has((request.url ?? '').split('?')[0]),
            },
            quietReqLogger: true,
            ...(app.isTest ? { enabled: false } : {}),
          },
        };
      },
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => {
        const throttle = config.get('throttle', { infer: true });
        return {
          // In-memory storage: limits are per instance. With several replicas
          // use a shared store (e.g. Redis) for fleet-wide limits.
          throttlers: [
            { name: 'default', ttl: throttle.ttlMs, limit: throttle.limit },
            {
              // Tight bucket for credential / email endpoints only.
              name: AUTH_THROTTLER,
              ttl: throttle.authTtlMs,
              limit: throttle.authLimit,
              skipIf: (context) =>
                Reflect.getMetadata(AUTH_THROTTLE_KEY, context.getHandler()) !==
                true,
            },
          ],
        };
      },
    }),

    PrismaModule,
    MailModule,
    UsersModule,
    AuthModule,
    SettingsModule,
    BillingModule,
    AdminModule,
    AiModule,
    StudioModule,
    DocumentsModule,
    HealthModule,
  ],
  providers: [
    // Rate limiting runs before authentication so credential stuffing is
    // rejected before it costs an Argon2 verification.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Authentication is global and deny-by-default; `@Public()` opts out.
    { provide: APP_GUARD, useClass: JwtAuthGuard },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseTransformInterceptor },
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          // Strip undecorated properties, then reject payloads that carried
          // them: silently ignoring input hides client bugs and can mask
          // attempts to set fields like `role`.
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          transformOptions: { enableImplicitConversion: false },
          // Do not echo submitted values (e.g. passwords) back in errors.
          validationError: { target: false, value: false },
          stopAtFirstError: true,
        }),
    },
  ],
})
export class AppModule {}
