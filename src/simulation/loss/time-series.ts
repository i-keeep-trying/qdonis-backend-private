/**
 * Port of qdonis-core `simulator/time_series_utils.py` (`slice_steady_state`).
 */

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { floatRepr } from '../netlist/py';
import { readWhitespaceTable } from '../numeric/pandas-float';

/**
 * Deterministic stand-in for `glob` order: case-insensitive code-unit order
 * (what NTFS returns), ties broken by exact name.
 */
export function globOrder(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ua = a.toUpperCase();
    const ub = b.toUpperCase();
    if (ua !== ub) return ua < ub ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Non-hidden `*.csv` files of a directory, in `globOrder`. */
export function csvFiles(dir: string): string[] {
  return globOrder(
    readdirSync(dir).filter((n) => !n.startsWith('.') && n.endsWith('.csv')),
  );
}

const KEEP_PREFIXES = ['SW', 'S', 'D', 'M', 'Q', 'L', 'T', 'TX'];

/** `DataFrame.to_csv(sep=' ', index=False, header=False)` of float columns. */
function toCsv(columns: number[][], rows: number[]): string {
  let out = '';
  for (const r of rows) {
    out +=
      columns
        .map((col) => (Number.isNaN(col[r]) ? '' : floatRepr(col[r])))
        .join(' ') + '\n';
  }
  return out;
}

/** Python `str(e)` for errors raised while reading / writing a file. */
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `slice_steady_state(dir, loss_window_ms, keep_refs)`: keep the last
 * `lossWindowMs` of every CSV, deleting non-semiconductor / non-magnetic traces.
 */
export function sliceSteadyState(
  dir: string,
  lossWindowMs = 20.0,
  keepRefs: readonly string[] = [],
): void {
  const keepUpper = new Set(keepRefs.map((r) => r.toUpperCase()));
  const files = csvFiles(dir);
  if (files.length === 0) return;

  const tables = new Map<string, number[][]>();
  const read = (name: string): number[][] => {
    let table = tables.get(name);
    if (!table) {
      table = readWhitespaceTable(readFileSync(join(dir, name), 'latin1'));
      tables.set(name, table);
    }
    return table;
  };

  let maxTime = 0.0;
  for (const name of files) {
    const upper = name.toUpperCase();
    if (!(
      upper.startsWith('V_') ||
      upper.startsWith('I_') ||
      upper.startsWith('GATE_')
    )) {
      continue;
    }
    try {
      const col0 = read(name)[0];
      if (col0.length) {
        const last = col0[col0.length - 1];
        if (last > maxTime) maxTime = last; // Python max(): NaN never wins
      }
    } catch {
      // unreadable file: skipped, like the Python `except Exception: pass`
    }
  }
  if (maxTime === 0.0) return;

  let cutoff = maxTime - lossWindowMs / 1000.0;
  if (cutoff < 0) cutoff = 0.0;

  const log = [
    `✂️ Slicing time series from ${floatRepr(cutoff)} to ${floatRepr(maxTime)} (window: ${floatRepr(lossWindowMs)}ms)`,
  ];
  const gatedRefs = new Set(
    files
      .map((n) => n.toUpperCase())
      .filter((u) => u.startsWith('GATE_'))
      .map((u) => u.slice(5, -4)),
  );

  for (const name of files) {
    const filename = name.toUpperCase();
    let ref = '';
    if (filename.startsWith('V_') || filename.startsWith('I_')) {
      ref = filename.slice(2, -4);
    } else if (filename.startsWith('GATE_')) {
      ref = filename.slice(5, -4);
    }

    if (
      ref &&
      !KEEP_PREFIXES.some((p) => ref.startsWith(p)) &&
      !gatedRefs.has(ref) &&
      !keepUpper.has(ref)
    ) {
      try {
        unlinkSync(join(dir, name));
        log.push(`DELETED: ${filename} (ref=${ref})`);
      } catch (error) {
        log.push(`FAILED TO DELETE: ${filename} - ${errorText(error)}`);
      }
      continue;
    }

    try {
      const columns = read(name);
      const length = columns[0]?.length ?? 0;
      if (length) {
        const kept: number[] = [];
        for (let r = 0; r < length; r += 1) {
          if (columns[0][r] >= cutoff) kept.push(r);
        }
        writeFileSync(join(dir, name), toCsv(columns, kept));
        log.push(
          `SLICED: ${filename} (ref=${ref}) | ${length} -> ${kept.length} rows`,
        );
      } else {
        log.push(`EMPTY: ${filename} (ref=${ref})`);
      }
    } catch (error) {
      log.push(`ERROR: ${filename} - ${errorText(error)}`);
    }
  }

  writeFileSync(join(dir, 'slice_log.txt'), log.join('\n'), 'utf8');
}
