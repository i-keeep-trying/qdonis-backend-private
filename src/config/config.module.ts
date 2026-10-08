import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { configuration } from './configuration';
import { validateEnv } from './env.validation';

/**
 * Wraps `@nestjs/config` with this project's validation and structure.
 *
 * Marked global so feature modules can inject `ConfigService` without importing
 * anything. Named `AppConfigModule` to avoid shadowing `ConfigModule` from
 * `@nestjs/config` at call sites.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Later files do not override earlier ones, so `.env.local` wins.
      envFilePath: ['.env.local', '.env'],
      load: [configuration],
      validate: validateEnv,
      expandVariables: true,
    }),
  ],
})
export class AppConfigModule {}
