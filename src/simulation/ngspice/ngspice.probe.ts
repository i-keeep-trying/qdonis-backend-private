/**
 * ngspice availability for the readiness probe (qdonis-core `_probe_ngspice`):
 * runs `ngspice -v` and caches the outcome so frequent probes don't spawn
 * a process each time.
 */

import { execFile } from 'node:child_process';

const CACHE_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface NgspiceProbe {
  ok: boolean;
  version: string | null;
  error: string | null;
}

let cached: { at: number; executable: string; result: NgspiceProbe } | null =
  null;

export function probeNgspice(executable: string): Promise<NgspiceProbe> {
  if (
    cached &&
    cached.executable === executable &&
    Date.now() - cached.at < CACHE_MS
  ) {
    return Promise.resolve(cached.result);
  }
  return new Promise((resolve) => {
    execFile(
      executable,
      ['-v'],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        const version = /ngspice-(\S+)/.exec(stdout)?.[1] ?? null;
        const result: NgspiceProbe =
          error && !version
            ? {
                ok: false,
                version: null,
                error:
                  (error as NodeJS.ErrnoException).code === 'ENOENT'
                    ? `ngspice not found at "${executable}"`
                    : error.message,
              }
            : { ok: true, version, error: null };
        cached = { at: Date.now(), executable, result };
        resolve(result);
      },
    );
  });
}
