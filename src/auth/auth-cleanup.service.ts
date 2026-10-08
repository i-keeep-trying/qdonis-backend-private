import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../config/configuration';
import { SessionsService } from './sessions/sessions.service';
import { AuthTokensService } from './tokens/auth-tokens.service';

/**
 * Periodically deletes expired sessions and spent email tokens so the tables
 * do not grow without bound. Runs on every instance; the deletes are
 * idempotent, so concurrent runs across replicas are harmless.
 */
@Injectable()
export class AuthCleanupService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AuthCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly sessions: SessionsService,
    private readonly tokens: AuthTokensService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  onApplicationBootstrap(): void {
    const { isTest } = this.config.get('app', { infer: true });
    const { cleanupIntervalMs } = this.config.get('auth', { infer: true });
    if (isTest || cleanupIntervalMs === 0) return;

    this.timer = setInterval(() => void this.run(), cleanupIntervalMs);
    // Never keep the process alive just for housekeeping.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Never throws; a run is skipped if the previous one is still going. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const [sessions, tokens] = await Promise.all([
        this.sessions.pruneExpired(),
        this.tokens.pruneStale(),
      ]);
      if (sessions + tokens > 0) {
        this.logger.log(
          `Cleanup removed ${sessions} session(s) and ${tokens} token(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Auth cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}
