import { Controller, Get, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
  type HealthIndicatorFunction,
  HealthIndicatorService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SkipThrottle } from '@nestjs/throttler';
import type { AppConfiguration } from '../config/configuration';
import { probeNgspice } from '../simulation/ngspice/ngspice.probe';

/** Heap ceiling above which the process is reported unhealthy. */
const MAX_HEAP_BYTES = 512 * 1024 * 1024;

/**
 * Liveness and readiness probes.
 *
 * Public and exempt from rate limiting: an orchestrator polling these must never
 * be throttled or need a credential, or it will restart a perfectly healthy
 * process.
 */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly indicator: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  private readonly logger = new Logger(HealthController.name);

  /** Raw driver errors stay in the logs; unauthenticated probes get a generic reason. */
  private failureMessage(error: unknown, fallback: string): string {
    const detail = error instanceof Error ? error.message : fallback;
    this.logger.warn(`Health check failed: ${detail}`);
    return this.config.get('app', { infer: true }).isProduction
      ? fallback
      : detail;
  }

  /**
   * Liveness: is the process itself up? Deliberately does not touch the
   * database, so a database outage does not cause the container to be killed
   * and restarted in a loop.
   */
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: string; uptime: number } {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  /**
   * Readiness: can this instance serve traffic? Checks the database and that the
   * pgvector extension is actually present, because a missing extension makes
   * every vector query fail at runtime.
   */
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe: database, pgvector and memory' })
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      this.databaseIndicator(),
      this.pgvectorIndicator(),
      () => this.memory.checkHeap('memory_heap', MAX_HEAP_BYTES),
    ]);
  }

  /**
   * Full readiness of a simulation instance (qdonis-core `/health/ready`):
   * also requires the ngspice binary. Kept off `/health` so an instance
   * without ngspice still serves everything else.
   */
  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness incl. simulation: database, pgvector, ngspice, memory',
  })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      this.databaseIndicator(),
      this.pgvectorIndicator(),
      this.ngspiceIndicator(),
      () => this.memory.checkHeap('memory_heap', MAX_HEAP_BYTES),
    ]);
  }

  /** The simulation stage needs the ngspice binary on this instance. */
  private ngspiceIndicator(): HealthIndicatorFunction {
    return async () => {
      const indicator = this.indicator.check('ngspice');
      const { ngspicePath } = this.config.get('simulation', { infer: true });
      const probe = await probeNgspice(ngspicePath);
      return probe.ok
        ? indicator.up({ version: probe.version })
        : indicator.down({
            message: this.failureMessage(
              new Error(probe.error ?? 'unavailable'),
              'unavailable',
            ),
          });
    };
  }

  private databaseIndicator(): HealthIndicatorFunction {
    return async () => {
      const indicator = this.indicator.check('database');
      const startedAt = Date.now();

      try {
        await this.prisma.ping();
        return indicator.up({ responseTimeMs: Date.now() - startedAt });
      } catch (error) {
        return indicator.down({
          message: this.failureMessage(error, 'unreachable'),
        });
      }
    };
  }

  private pgvectorIndicator(): HealthIndicatorFunction {
    return async () => {
      const indicator = this.indicator.check('pgvector');

      try {
        const version = await this.prisma.getVectorExtensionVersion();
        return version
          ? indicator.up({ version })
          : indicator.down({
              message:
                'The vector extension is not enabled in this database. Run the migrations.',
            });
      } catch (error) {
        return indicator.down({
          message: this.failureMessage(error, 'check failed'),
        });
      }
    };
  }
}
