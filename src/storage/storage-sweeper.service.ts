import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../config/configuration';
import { ObjectStore } from './object-store';
import { PENDING_UPLOAD_TTL_MS } from './storage.constants';
import { StoredFilesRepository } from './stored-files.repository';

const BATCH = 500;
/** Claimed rows are invisible to other workers for this long. */
const LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
/** Stop draining after this many batches per run; the rest waits for the next tick. */
const MAX_BATCHES_PER_RUN = 20;

/**
 * Removes abandoned PENDING uploads and drains `storage_deletions` (filled by
 * the `stored_files` delete trigger). Safe on every replica: claims use
 * `FOR UPDATE SKIP LOCKED` and S3 deletes are idempotent.
 */
@Injectable()
export class StorageSweeperService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(StorageSweeperService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: StoredFilesRepository,
    private readonly store: ObjectStore,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  onApplicationBootstrap(): void {
    const { isTest } = this.config.get('app', { infer: true });
    const { enabled, sweepIntervalMs } = this.config.get('storage', {
      infer: true,
    });
    if (isTest || !enabled || sweepIntervalMs === 0) return;
    this.timer = setInterval(() => void this.run(), sweepIntervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Never throws; overlapping runs are skipped. */
  async run(): Promise<{ abandoned: number; deleted: number; failed: number }> {
    const result = { abandoned: 0, deleted: 0, failed: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      result.abandoned = await this.repository.deleteStalePending(
        new Date(Date.now() - PENDING_UPLOAD_TTL_MS),
      );
      for (let i = 0; i < MAX_BATCHES_PER_RUN; i += 1) {
        const claimed = await this.repository.claimDeletions(BATCH, LEASE_MS);
        if (claimed.length === 0) break;
        const { failed } = await this.store.delete(claimed.map((c) => c.key));
        const failedKeys = new Map(failed.map((f) => [f.key, f.error]));
        await this.repository.completeDeletions(
          claimed.filter((c) => !failedKeys.has(c.key)).map((c) => c.id),
        );
        for (const item of claimed) {
          const error = failedKeys.get(item.key);
          if (error === undefined) continue;
          const attempts = item.attempts + 1;
          const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** attempts);
          await this.repository.failDeletion(
            item.id,
            attempts,
            error,
            new Date(Date.now() + backoff),
          );
        }
        result.deleted += claimed.length - failed.length;
        result.failed += failed.length;
        if (claimed.length < BATCH) break;
      }
      if (result.abandoned + result.deleted + result.failed > 0) {
        this.logger.log(
          `Storage sweep: ${result.abandoned} abandoned upload(s), ${result.deleted} object(s) deleted, ${result.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Storage sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
    return result;
  }
}
