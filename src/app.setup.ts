import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { mapBodyParserError } from './common/filters/all-exceptions.filter';
import type { AppConfiguration } from './config/configuration';

const bodyLogger = new Logger('BodyParser');

/**
 * HTTP pipeline shared by `main.ts` and the e2e tests, so tests exercise the
 * exact middleware stack production runs. The app must be created with
 * `bodyParser: false`; parsers are registered here with explicit limits.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService<AppConfiguration, true>);
  const appConfig = config.get('app', { infer: true });
  const corsConfig = config.get('cors', { infer: true });

  // `req.ip` (rate limiting, session audit) and secure cookies depend on
  // trusting exactly as many proxy hops as are really in front of the app;
  // trusting more would let clients spoof their IP via X-Forwarded-For.
  app.set(
    'trust proxy',
    appConfig.trustProxyHops > 0 ? appConfig.trustProxyHops : false,
  );
  app.disable('x-powered-by');

  app.useBodyParser('json', { limit: appConfig.bodyLimit });
  app.useBodyParser('urlencoded', {
    limit: appConfig.bodyLimit,
    extended: false,
  });

  // Parser failures happen before Nest's exception filters run; answer them
  // with the same error envelope instead of Express's default.
  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      const mapped = mapBodyParserError(error);
      if (!mapped || response.headersSent) return next(error);
      bodyLogger.warn(
        `${request.method} ${request.path} -> ${mapped.statusCode} ${mapped.code}`,
      );
      response.status(mapped.statusCode).json({
        ...mapped,
        path: request.path,
        timestamp: new Date().toISOString(),
      });
    },
  );

  app.use(
    helmet({
      // Swagger UI needs inline assets outside production.
      contentSecurityPolicy: appConfig.isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());

  // Health probes stay at a stable /health regardless of API versioning.
  app.setGlobalPrefix(appConfig.apiPrefix, {
    exclude: ['health', 'health/live'],
  });

  /**
   * Credentialed CORS: the refresh cookie only travels with `credentials`,
   * which the spec forbids pairing with `*`, hence an explicit allowlist. A
   * disallowed origin simply gets no CORS headers (the browser blocks it); it
   * is not turned into a server error.
   */
  app.enableCors({
    origin: (origin, callback) => {
      callback(null, !origin || corsConfig.origins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Response-Time', 'X-Request-Id', 'Retry-After'],
    maxAge: 86_400,
  });

  app.enableShutdownHooks();
}
