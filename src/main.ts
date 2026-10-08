import { Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { REFRESH_TOKEN_COOKIE } from './auth/auth.types';
import type { AppConfiguration } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Requests that arrive before Pino is wired up are buffered rather than lost.
    bufferLogs: true,
    // Registered by configureApp with an explicit size limit.
    bodyParser: false,
    // Keeps the exact request bytes for Stripe webhook signature checks.
    rawBody: true,
  });

  app.useLogger(app.get(PinoLogger));
  const logger = app.get(PinoLogger);

  configureApp(app);

  const config = app.get(ConfigService<AppConfiguration, true>);
  const appConfig = config.get('app', { infer: true });
  const swaggerConfig = config.get('swagger', { infer: true });

  if (swaggerConfig.enabled && !appConfig.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Qdonis API')
        .setDescription(
          'Access tokens go in the Authorization header; the refresh token is an httpOnly cookie sent automatically by the browser to /auth routes.',
        )
        .setVersion('1.0.0')
        .addBearerAuth({
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Paste the accessToken returned by /auth/login',
        })
        .addCookieAuth(REFRESH_TOKEN_COOKIE)
        .build(),
    );
    SwaggerModule.setup(swaggerConfig.path, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(appConfig.port);

  // Cut off slow or stalled clients (slowloris), and keep idle keep-alive
  // connections open longer than a typical load balancer's idle timeout.
  const server = app.getHttpServer();
  server.requestTimeout = appConfig.requestTimeoutMs;
  server.headersTimeout = Math.min(appConfig.requestTimeoutMs, 60_000);
  server.keepAliveTimeout = 65_000;

  logger.log(
    `API listening on port ${appConfig.port} under /${appConfig.apiPrefix}`,
  );
  if (swaggerConfig.enabled && !appConfig.isProduction) {
    logger.log(`API docs at /${swaggerConfig.path}`);
  }
}

const fatal = new NestLogger('Process');

process.on('unhandledRejection', (reason) => {
  fatal.error(
    `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    reason instanceof Error ? reason.stack : undefined,
  );
});

process.on('uncaughtException', (error) => {
  // State is unknown after an uncaught exception; exit and let the
  // orchestrator restart a clean process.
  fatal.error(`Uncaught exception: ${error.message}`, error.stack);
  process.exit(1);
});

bootstrap().catch((error: unknown) => {
  fatal.error(
    `Failed to start: ${error instanceof Error ? error.message : String(error)}`,
    error instanceof Error ? error.stack : undefined,
  );
  process.exit(1);
});
