import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import type { AppConfiguration } from '../config/configuration';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Application-wide Prisma Client.
 *
 * Prisma 7 requires an explicit driver adapter for SQL databases, so the
 * connection is established by `pg` and handed to Prisma via {@link PrismaPg}.
 * Letting the adapter build the pool from a `PoolConfig` (rather than passing a
 * pool we own) means Prisma disposes of it during `$disconnect`, keeping the
 * shutdown path in one place.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<AppConfiguration, true>) {
    const database = config.get('database', { infer: true });
    const app = config.get('app', { infer: true });

    const poolErrorLogger = new Logger(`${PrismaService.name}:pool`);

    const adapter = new PrismaPg(
      {
        connectionString: database.url,
        max: database.poolMax,
        idleTimeoutMillis: database.idleTimeoutMs,
        connectionTimeoutMillis: database.connectionTimeoutMs,
        // Identifies this app in pg_stat_activity, which makes connection
        // leaks far easier to attribute.
        application_name: 'qdonis-backend',
        // The adapter sends DateTime values without an offset, and Postgres
        // reads them in the session time zone: on a non-UTC server every
        // written timestamp (run leases included) was shifted by that offset.
        options: '-c TimeZone=UTC',
      },
      {
        onPoolError: (error) =>
          poolErrorLogger.error(error.message, error.stack),
        onConnectionError: (error) =>
          poolErrorLogger.warn(`connection error: ${error.message}`),
      },
    );

    // Query logging is emitted to stdout rather than through an `$on('query')`
    // event listener: the event-based API types itself from the `log` option,
    // which forces the option to be a compile-time constant and would stop it
    // varying by environment. Outside production the extra SQL trace is worth
    // more than uniform log formatting.
    super({
      adapter,
      log: app.isProduction
        ? ['warn', 'error']
        : ['query', 'info', 'warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Cheapest possible round trip, used by the readiness probe.
   */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  /**
   * Returns the installed pgvector version, or `null` when the extension is
   * not enabled in the current database.
   */
  async getVectorExtensionVersion(): Promise<string | null> {
    const rows = await this.$queryRaw<Array<{ extversion: string }>>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector'
    `;
    return rows[0]?.extversion ?? null;
  }
}
