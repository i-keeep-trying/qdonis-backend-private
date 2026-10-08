import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import {
  isSettingKey,
  SETTING_KEYS,
  SETTINGS,
  type SettingKey,
  type SettingValue,
} from './settings.schema';
import { SettingsRepository } from './settings.repository';

/** Settings change rarely; cache briefly to keep hot paths off the DB. */
const CACHE_TTL_MS = 30_000;

export interface SettingView {
  key: SettingKey;
  value: Record<string, unknown>;
  updatedAt: Date | null;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<
    SettingKey,
    { value: unknown; at: number }
  >();

  constructor(private readonly repository: SettingsRepository) {}

  /**
   * Typed value of a setting. Stored values that fail validation (e.g. edited
   * by hand) fall back to the default and are logged, never surfaced raw.
   */
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS)
      return hit.value as SettingValue<K>;

    const row = await this.repository.find(key);
    const value = row ? await this.coerce(key, row.value) : null;
    const resolved = (value ?? {
      ...SETTINGS[key].defaults,
    }) as SettingValue<K>;
    this.cache.set(key, { value: resolved, at: Date.now() });
    return resolved;
  }

  async list(): Promise<SettingView[]> {
    const rows = new Map(
      (await this.repository.findAll()).map((row) => [row.key, row]),
    );
    return Promise.all(
      SETTING_KEYS.map(async (key) => ({
        key,
        value: { ...(await this.get(key)) },
        updatedAt: rows.get(key)?.updatedAt ?? null,
      })),
    );
  }

  /** Validates `raw` against the key's schema (whitelist, no extras) and stores it. */
  async update(
    key: string,
    raw: unknown,
    actorId: string,
  ): Promise<SettingView> {
    if (!isSettingKey(key)) {
      throw AppError.notFound(
        ErrorCode.SettingNotFound,
        `Unknown setting "${key}"`,
      );
    }
    const value = await this.validateOrThrow(key, raw);
    if (key === 'addon_pricing') {
      const pricing = value as SettingValue<'addon_pricing'>;
      if (pricing.customMinCents > pricing.customMaxCents) {
        throw AppError.badRequest(
          ErrorCode.ValidationFailed,
          'customMinCents must not exceed customMaxCents',
        );
      }
    }

    const row = await this.repository.upsert(key, { ...value }, actorId);
    this.cache.delete(key);
    this.logger.log(`Setting ${key} updated by ${actorId}`);
    return {
      key,
      value: { ...value },
      updatedAt: row.updatedAt,
    };
  }

  private async coerce(key: SettingKey, raw: unknown): Promise<object | null> {
    const instance = this.toInstance(key, raw);
    if (!instance) return null;
    const errors = await validate(instance, { whitelist: true });
    if (errors.length > 0) {
      this.logger.error(`Stored setting ${key} is invalid; using defaults`);
      return null;
    }
    return instance;
  }

  private async validateOrThrow(
    key: SettingKey,
    raw: unknown,
  ): Promise<object> {
    const instance = this.toInstance(key, raw);
    if (!instance) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Setting value must be an object',
      );
    }
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      const details = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        `Invalid value for ${key}: ${details.join('; ')}`,
      );
    }
    return instance;
  }

  private toInstance(key: SettingKey, raw: unknown): object | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      return null;
    return plainToInstance(SETTINGS[key].schema as new () => object, raw, {
      enableImplicitConversion: false,
    });
  }
}
