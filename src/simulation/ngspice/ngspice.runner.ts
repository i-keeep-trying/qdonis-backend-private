/**
 * ngspice execution, ported from `NgspiceMeasurePlotter.execute_and_process`
 * (deck sanitising + batch run per analysis).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { splitLines, upgradeLegacyTelemetry } from '../results/signal-names';

export type AnalysisKind = 'dc' | 'ac' | 'transient';

export const DECK_FILES: Record<AnalysisKind, string> = {
  dc: 'dc_analysis.cir',
  ac: 'ac_analysis.cir',
  transient: 'transient_analysis.cir',
};

/** `(name, file)` in core's run order. */
const ANALYSES: [string, AnalysisKind][] = [
  ['DC', 'dc'],
  ['AC', 'ac'],
  ['Transient', 'transient'],
];

/** Python `\bxl\s+[\w\.\+-]+\s+[\w\.\+-]+` (Unicode `\w`, `\b`). */
const XL_LIMIT =
  /(?<![\p{L}\p{N}_])xl\s+[\p{L}\p{N}_.+-]+\s+[\p{L}\p{N}_.+-]+/gu;

/** Whether a deck carries the auto-telemetry (`let v_` / `wrdata time_series`). */
const hasAutoTelemetry = (deck: string): boolean =>
  deck.includes('let v_') || deck.includes('wrdata time_series');

/**
 * A `save` that would restrict the stored vectors (and starve the
 * auto-telemetry `wrdata`). `save all @D1[id] ...` keeps everything and adds
 * the device-internal currents the telemetry reads (`let i_D1_auto =
 * @D1[id]`): without it ngspice keeps only their last value, so every device
 * probed that way had a constant current (PFC switch 0.1 A, diodes 0 A).
 */
const isSave = (stripped: string): boolean =>
  (stripped.startsWith('save ') || stripped.startsWith('.save ')) &&
  !/^\.?save\s+all\b/i.test(stripped);

const isXlPlot = (stripped: string): boolean =>
  stripped.startsWith('plot ') && stripped.includes(' xl ');

/** Rerun-route sanitising applied before the decks are written. */
export function sanitizeEditedDeck(content: string): string {
  const auto = hasAutoTelemetry(content);
  const out: string[] = [];
  for (let line of splitLines(content)) {
    const stripped = line.trim();
    if (auto && isSave(stripped)) {
      out.push(`* [REMOVED FOR FULL TELEMETRY] ${line}`);
      continue;
    }
    if (isXlPlot(stripped)) line = line.replace(XL_LIMIT, '');
    out.push(line);
  }
  return out.join('\n');
}

/**
 * `/api/simulate/prepare` deck cleanup: every `save` line commented out and
 * `xl` plot limits removed (whatever telemetry the deck has).
 */
export function sanitizePreparedDeck(content: string): string {
  const out: string[] = [];
  for (let line of splitLines(content.replace(/\r\n?/g, '\n'))) {
    const stripped = line.trim();
    if (isSave(stripped)) {
      out.push(`* [REMOVED FOR FULL TELEMETRY] ${line}`);
      continue;
    }
    if (isXlPlot(stripped)) line = line.replace(XL_LIMIT, '');
    out.push(line);
  }
  return out.join('\n');
}

/** Pre-execution sanitising; returns null when the deck is unchanged. */
export function sanitizeForExecution(content: string): string | null {
  const auto = hasAutoTelemetry(content);
  let lines: string[] = [];
  let modified = false;
  for (const line of splitLines(content)) {
    const stripped = line.trim();
    if (auto && isSave(stripped)) {
      lines.push(`* [REMOVED TO PREVENT SCRIPT ABORT] ${line}`);
      modified = true;
      continue;
    }
    if (isXlPlot(stripped)) {
      lines.push(line.replace(XL_LIMIT, ''));
      modified = true;
      continue;
    }
    lines.push(line);
  }
  const [upgraded, legacy] = upgradeLegacyTelemetry(lines.join('\n'));
  if (legacy) {
    lines = splitLines(upgraded);
    modified = true;
  }
  return modified ? lines.join('\n') : null;
}

export class NgspiceTimeoutError extends Error {
  constructor(seconds: number) {
    super(`ngspice timed out after ${seconds} seconds`);
  }
}

export interface NgspiceOptions {
  executable: string;
  timeoutSeconds: number;
}

/** `ngspice -b -o <log> -n -q <deck>` in `cwd`; resolves with stdout. */
function runBatch(
  cwd: string,
  deck: string,
  log: string,
  options: NgspiceOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.executable,
      ['-b', '-o', log, '-n', '-q', deck],
      {
        cwd,
        env: { ...process.env, DISPLAY: '', SPICE_NO_DISPLAY: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // Reject once the process has exited (Windows keeps its files locked
      // until then, so the caller's cleanup would fail with EBUSY and hide the
      // timeout); give up waiting after a few seconds.
      grace = setTimeout(
        () => reject(new NgspiceTimeoutError(options.timeoutSeconds)),
        5000,
      );
    }, options.timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(grace);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(grace);
      if (timedOut) reject(new NgspiceTimeoutError(options.timeoutSeconds));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

/**
 * Runs every present deck selected by `analysisFilter` and returns the raw
 * log text per analysis (stdout when the log file is empty), in run order.
 */
export async function runAnalyses(
  outputDir: string,
  analysisFilter: string[],
  options: NgspiceOptions,
): Promise<string[]> {
  const filter = analysisFilter.map((a) => a.toLowerCase());
  const logs: string[] = [];
  for (const [name, kind] of ANALYSES) {
    if (filter.length && !filter.includes(name.toLowerCase())) continue;
    const deckPath = join(outputDir, DECK_FILES[kind]);
    if (!existsSync(deckPath)) continue;

    const sanitized = sanitizeForExecution(readFileSync(deckPath, 'utf8'));
    if (sanitized !== null) writeFileSync(deckPath, sanitized, 'utf8');

    const logName = `${name.toLowerCase()}_analysis.log`;
    const stdout = await runBatch(
      outputDir,
      DECK_FILES[kind],
      logName,
      options,
    );
    const logPath = join(outputDir, logName);
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    logs.push(log || stdout);
  }
  return logs;
}
