import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../config/configuration';
import type {
  MouserPart,
  MouserPartSearchRequest,
  MouserSearchRequest,
  MouserSearchResponse,
} from './mouser-search.logic';

const BASE_URL = 'https://api.mouser.com/api/v1';

export interface MouserCall {
  endpoint: '/search/keyword' | '/search/partnumber';
  statusCode: number | null;
  durationMs: number;
  results: number;
  error: string | null;
  response: MouserSearchResponse | null;
}

/** Thin Mouser Search API transport. Tests replace it. */
export abstract class MouserApi {
  abstract configured(): boolean;
  abstract keyword(request: MouserSearchRequest, timeoutMs: number): Promise<MouserCall>;
  abstract partNumber(request: MouserPartSearchRequest, timeoutMs: number): Promise<MouserCall>;
}

/** Real transport over `fetch`; the key never leaves the server. */
@Injectable()
export class HttpMouserApi extends MouserApi {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {
    super();
  }

  private key(): string | undefined {
    return this.config.get('mouser', { infer: true }).apiKey;
  }

  configured(): boolean {
    return Boolean(this.key());
  }

  keyword(request: MouserSearchRequest, timeoutMs: number): Promise<MouserCall> {
    return this.post('/search/keyword', request, timeoutMs);
  }

  partNumber(request: MouserPartSearchRequest, timeoutMs: number): Promise<MouserCall> {
    return this.post('/search/partnumber', request, timeoutMs);
  }

  private async post(
    endpoint: MouserCall['endpoint'],
    body: unknown,
    timeoutMs: number,
  ): Promise<MouserCall> {
    const started = Date.now();
    const url = `${BASE_URL}${endpoint}?apikey=${encodeURIComponent(this.key() ?? '')}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json().catch(() => null)) as MouserSearchResponse | null;
      const parts: MouserPart[] = json?.SearchResults?.Parts ?? [];
      return {
        endpoint,
        statusCode: res.status,
        durationMs: Date.now() - started,
        results: parts.length,
        error: res.ok ? null : `HTTP ${res.status}`,
        response: res.ok ? json : null,
      };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        endpoint,
        statusCode: null,
        durationMs: Date.now() - started,
        results: 0,
        // Never include the URL: it carries the API key.
        error: timedOut ? 'timeout' : error instanceof Error ? error.name : 'network error',
        response: null,
      };
    }
  }
}
