import { createHash } from 'node:crypto';

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { AppConfiguration } from '../config/configuration';
import type { ComponentOption } from '../engines/reliability/reliability.types';
import type { Prisma } from '../generated/prisma/client';
import { type MouserCall, MouserApi } from './mouser-api';
import {
  type ComponentSpecifications,
  generateMouserCacheKey,
  generateSearchStrategies,
  hasPackageAttribute,
  type MouserPart,
  normalizeSpecifications,
  parseComponentName,
  rankAndDeduplicateResults,
  type SearchStrategy,
  transformMouserPartToComponentOption,
} from './mouser-search.logic';
import { SourcingRepository } from './sourcing.repository';

const SUPPLIER = 'mouser';
/** Pacing between calls (old frontend values), so a burst never trips Mouser's limits. */
const ENRICH_PAUSE_MS = 750;
const STRATEGY_PAUSE_MS = 1_000;
const COMPONENT_PAUSE_MS = 2_500;

export interface SearchContext {
  userId: string;
  projectId?: string | null;
  signal?: AbortSignal;
}

type Weighted = ComponentOption & { searchStrategyWeight?: number };

class RateLimited extends Error {}

/**
 * Mouser component search (port of the old frontend `mouserService`): the
 * API key, pacing, fleet-wide quota, result cache and usage log all live here.
 */
@Injectable()
export class SourcingService {
  private readonly logger = new Logger(SourcingService.name);

  constructor(
    private readonly api: MouserApi,
    private readonly repository: SourcingRepository,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  private settings() {
    return this.config.get('mouser', { infer: true });
  }

  assertConfigured(): void {
    if (!this.api.configured()) {
      throw AppError.unavailable(
        ErrorCode.SupplierNotConfigured,
        'Component search is not configured on this server',
      );
    }
  }

  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.config.get('app', { infer: true }).isTest) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        },
        { once: true },
      );
    });
  }

  /** Mouser allows N calls/minute and M/day per key, across every instance. */
  private async reserveCall(): Promise<void> {
    const { callsPerMinute, callsPerDay } = this.settings();
    const now = Date.now();
    const [minute, day] = await Promise.all([
      this.repository.callsSince(SUPPLIER, new Date(now - 60_000)),
      this.repository.callsSince(SUPPLIER, new Date(now - 86_400_000)),
    ]);
    if (minute >= callsPerMinute || day >= callsPerDay) throw new RateLimited();
  }

  private async call(
    ctx: SearchContext,
    run: () => Promise<MouserCall>,
    detail: string,
  ): Promise<MouserCall> {
    await this.reserveCall();
    const result = await run();
    await this.repository
      .logCall({
        supplier: SUPPLIER,
        endpoint: result.endpoint,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        results: result.results,
        error: result.error ? `${result.error} (${detail.slice(0, 200)})` : null,
        userId: ctx.userId,
        projectId: ctx.projectId ?? null,
      })
      .catch((error: unknown) =>
        this.logger.warn(`Supplier call not logged: ${error instanceof Error ? error.message : String(error)}`),
      );
    return result;
  }

  /** Maps a failed call to the user-facing error the old frontend showed. */
  private raise(call: MouserCall, what: string): never {
    if (call.error === 'timeout') {
      throw AppError.badGateway(ErrorCode.SupplierError, `Search request timed out for ${what}. Please try again.`);
    }
    if (call.statusCode === 401 || call.statusCode === 403) {
      this.logger.error('Mouser rejected the API key (401/403)');
      throw AppError.unavailable(ErrorCode.SupplierNotConfigured, 'Component search is misconfigured on this server');
    }
    if (call.statusCode === 429) this.rateLimited();
    throw AppError.badGateway(
      ErrorCode.SupplierError,
      'Mouser API is temporarily unavailable. Please try again later.',
    );
  }

  private rateLimited(): never {
    throw new HttpException(
      {
        message: 'Too many component searches right now. Please wait a moment and try again.',
        code: 'SUPPLIER_RATE_LIMITED',
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Full part data by Mouser part number; null when unknown or failed. */
  private async partByNumber(ctx: SearchContext, mouserPartNumber: string): Promise<MouserPart | null> {
    try {
      const call = await this.call(
        ctx,
        () =>
          this.api.partNumber(
            { SearchByPartRequest: { mouserPartNumber, partSearchOptions: 'None' } },
            15_000,
          ),
        mouserPartNumber,
      );
      if (!call.response || call.response.Errors?.length) return null;
      return call.response.SearchResults?.Parts?.[0] ?? null;
    } catch (error) {
      if (error instanceof RateLimited) return null; // keep the summary data
      throw error;
    }
  }

  private async enrich(ctx: SearchContext, part: MouserPart): Promise<MouserPart> {
    if (hasPackageAttribute(part.ProductAttributes ?? [])) return part;
    const full = await this.partByNumber(ctx, part.MouserPartNumber);
    await this.pause(ENRICH_PAUSE_MS, ctx.signal);
    return full ?? part;
  }

  /** Plain keyword search (manual search in Component Selection). */
  async keywordSearch(
    ctx: SearchContext,
    params: { keyword: string; records: number; startingRecord: number; searchOptions?: string },
  ): Promise<ComponentOption[]> {
    this.assertConfigured();
    let call: MouserCall;
    try {
      call = await this.call(
        ctx,
        () =>
          this.api.keyword(
            {
              SearchByKeywordRequest: {
                keyword: params.keyword,
                records: params.records,
                startingRecord: params.startingRecord,
                searchOptions: params.searchOptions ?? '',
                searchWithYourSignUpLanguage: 'en-US',
              },
            },
            10_000,
          ),
        params.keyword,
      );
    } catch (error) {
      if (error instanceof RateLimited) this.rateLimited();
      throw error;
    }
    if (!call.response) this.raise(call, `"${params.keyword}"`);
    if (call.response.Errors?.length) {
      throw AppError.badRequest(
        ErrorCode.SupplierError,
        `Mouser API Error: ${call.response.Errors.map((e) => e.Message).join(', ')}`,
      );
    }
    const parts = call.response.SearchResults?.Parts ?? [];
    const options: ComponentOption[] = [];
    for (const [index, part] of parts.entries()) {
      options.push(transformMouserPartToComponentOption(await this.enrich(ctx, part), index, ''));
    }
    return options;
  }

  /**
   * The part with this manufacturer part number (the BOM's selected devices),
   * or null when Mouser does not list it. Mouser lists some parts only in a
   * reel packaging (E4M0045075J2 as E4M0045075J2-TR), which also counts. Exact
   * number first, then a priced, in-stock one. Throws when the search is not
   * configured, rate limited or failing.
   */
  async exactPart(ctx: SearchContext, manufacturerPartNumber: string): Promise<ComponentOption | null> {
    this.assertConfigured();
    let call: MouserCall;
    try {
      call = await this.call(
        ctx,
        () =>
          this.api.partNumber(
            { SearchByPartRequest: { mouserPartNumber: manufacturerPartNumber, partSearchOptions: 'BeginsWith' } },
            15_000,
          ),
        manufacturerPartNumber,
      );
    } catch (error) {
      if (error instanceof RateLimited) this.rateLimited();
      throw error;
    }
    if (!call.response) this.raise(call, manufacturerPartNumber);
    if (call.response.Errors?.length) return null;
    const key = (pn: string) => pn.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const wanted = key(manufacturerPartNumber);
    const exact = (part: MouserPart) =>
      key(part.ManufacturerPartNumber ?? '') === wanted;
    const prefix = manufacturerPartNumber.toUpperCase();
    const reel = (part: MouserPart) => {
      const mpn = (part.ManufacturerPartNumber ?? '').toUpperCase();
      return (
        mpn.startsWith(prefix) &&
        /^-?(TR|T&R|TRL|TRR|REEL)$/.test(mpn.slice(prefix.length))
      );
    };
    const score = (part: MouserPart) =>
      (exact(part) ? 4 : 0) +
      (part.PriceBreaks?.some((b) => parseFloat(b.Price.replace(/[^0-9.]+/g, '')) > 0) ? 2 : 0) +
      (/in stock/i.test(part.Availability ?? '') ? 1 : 0);
    const matches = (call.response.SearchResults?.Parts ?? [])
      .filter((part) => exact(part) || reel(part))
      .sort((a, b) => score(b) - score(a));
    return matches[0] ? transformMouserPartToComponentOption(matches[0], 0, manufacturerPartNumber) : null;
  }

  async partDetails(ctx: SearchContext, mouserPartNumber: string): Promise<ComponentOption | null> {
    this.assertConfigured();
    const part = await this.partByNumber(ctx, mouserPartNumber);
    return part ? transformMouserPartToComponentOption(part, 0, '') : null;
  }

  /**
   * Spec-driven search (old `searchComponentsBySpecs`): weighted strategies
   * (or one AI keyword), paced calls, ranking/dedup, cached per spec set.
   */
  async searchBySpecs(
    ctx: SearchContext,
    input: {
      componentName: string;
      specs: ComponentSpecifications & { mouserSearch?: { primaryKeyword?: string; alternativeKeywords?: string[] } };
      maxResults: number;
      keyword?: string;
      forceRefresh?: boolean;
    },
  ): Promise<{ results: ComponentOption[]; cached: boolean }> {
    const { componentName, specs, maxResults } = input;
    const lowerName = componentName.toLowerCase();
    const lowerType = (specs.type || '').toLowerCase();
    if (lowerName.includes('ground') || lowerType.includes('ground') || lowerType.includes('voltage_source')) {
      return { results: [], cached: false };
    }

    const cacheKey = createHash('sha256')
      .update(`${generateMouserCacheKey(componentName, specs)}|${input.keyword ?? ''}|${maxResults}`)
      .digest('hex');
    const { cacheHours } = this.settings();
    if (!input.forceRefresh && cacheHours > 0) {
      const hit = await this.repository.cached(cacheKey);
      if (Array.isArray(hit) && hit.length > 0) return { results: hit as ComponentOption[], cached: true };
    }
    this.assertConfigured();

    let strategies: SearchStrategy[];
    if (input.keyword) {
      strategies = [{ keyword: input.keyword, weight: 1.0, strategyType: 'ai_direct' }];
    } else {
      const parsed = parseComponentName(componentName);
      const effectiveType = (parsed.trailingType || specs.type || '').toLowerCase();
      strategies = generateSearchStrategies(parsed, normalizeSpecifications(specs), effectiveType);
    }
    const ai = specs.mouserSearch;
    if (ai?.primaryKeyword) {
      strategies = strategies.map((s) => (s.strategyType === 'type_specs' ? { ...s, keyword: ai.primaryKeyword! } : s));
      (ai.alternativeKeywords ?? []).forEach((alt, i) => {
        strategies.push({ keyword: alt, weight: 0.9 - i * 0.1, strategyType: 'type_specs' });
      });
    }

    const all: Weighted[] = [];
    for (let s = 0; s < strategies.length; s += 1) {
      const strategy = strategies[s];
      if (!strategy.keyword.trim()) continue;
      if (all.length >= maxResults) break;
      const remaining = Math.max(0, maxResults - all.length);
      const perStrategy = Math.max(1, Math.ceil(remaining / (strategies.length - s)));

      let call: MouserCall;
      try {
        call = await this.call(
          ctx,
          () =>
            this.api.keyword(
              {
                SearchByKeywordRequest: {
                  keyword: strategy.keyword,
                  records: perStrategy + 1,
                  startingRecord: 0,
                  searchOptions: '',
                  searchWithYourSignUpLanguage: 'en-US',
                },
              },
              15_000,
            ),
          strategy.keyword,
        );
      } catch (error) {
        if (error instanceof RateLimited) {
          if (all.length === 0) this.rateLimited();
          break; // return what we have
        }
        throw error;
      }
      if (call.statusCode === 401 || call.statusCode === 403) this.raise(call, componentName);
      // Failed / warned strategies are skipped, as before.
      const parts = call.response && !call.response.Errors?.length ? (call.response.SearchResults?.Parts ?? []) : [];
      const batch: Weighted[] = [];
      for (const [index, part] of parts.entries()) {
        const option = transformMouserPartToComponentOption(await this.enrich(ctx, part), index, componentName);
        batch.push({ ...option, searchStrategyWeight: strategy.weight });
        if (batch.length >= perStrategy || all.length + batch.length >= maxResults) break;
      }
      all.push(...batch);
      if (s < strategies.length - 1 && all.length < maxResults) await this.pause(STRATEGY_PAUSE_MS, ctx.signal);
    }

    const results = rankAndDeduplicateResults(all, maxResults);
    if (results.length > 0 && cacheHours > 0) {
      await this.repository
        .cache({
          supplier: SUPPLIER,
          key: cacheKey,
          componentName,
          results: results as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + cacheHours * 3_600_000),
        })
        .catch((error: unknown) =>
          this.logger.warn(`Search results not cached: ${error instanceof Error ? error.message : String(error)}`),
        );
    }
    return { results, cached: false };
  }

  /** Several components in sequence (old `searchMultipleComponentsBySpecs`). */
  async searchMany(
    ctx: SearchContext,
    components: Array<{ name: string; specs: ComponentSpecifications; keyword?: string }>,
    maxResults: number,
  ): Promise<Array<{ componentName: string; results: ComponentOption[]; error?: string }>> {
    const out: Array<{ componentName: string; results: ComponentOption[]; error?: string }> = [];
    for (const [i, c] of components.entries()) {
      try {
        const { results } = await this.searchBySpecs(ctx, {
          componentName: c.name,
          specs: c.specs,
          maxResults,
          keyword: c.keyword,
        });
        out.push({ componentName: c.name, results });
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        out.push({
          componentName: c.name,
          results: [],
          error: error instanceof HttpException ? error.message : 'Unknown error occurred',
        });
      }
      if (i < components.length - 1) await this.pause(COMPONENT_PAUSE_MS, ctx.signal);
    }
    return out;
  }
}
