import type { SpecsData } from '../design/studio-specs.logic';

/** Numbers in a spec value: '90-264' -> [90, 264], '<= 100' -> [100], '80 °C' -> [80]. */
export function specNumbers(value: string | undefined): number[] {
  if (!value) return [];
  const out: number[] = [];
  for (const m of String(value).matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)) {
    const n = parseFloat(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  // '90-264' is a range, not 90 and -264.
  return out.map((n, i) =>
    i > 0 && n < 0 && /\d\s*-\s*\d/.test(value) ? -n : n,
  );
}

/** First spec row whose name matches `pattern`, as a number in base units. */
export function specValue(
  specs: SpecsData | null | undefined,
  pattern: RegExp,
  mode: 'max' | 'min' | 'first' = 'first',
): number | null {
  const row = specs?.rows.find(
    (r) => pattern.test(r.name) && specNumbers(r.value).length,
  );
  if (!row) return null;
  const nums = specNumbers(row.value);
  let v =
    mode === 'max'
      ? Math.max(...nums)
      : mode === 'min'
        ? Math.min(...nums)
        : nums[0];
  const unit = (row.unit || '').trim();
  if (/^k(hz|w|v|a)$/i.test(unit)) v *= 1e3;
  else if (/^MHz$/i.test(unit) || /^MW$/.test(unit)) v *= 1e6;
  else if (/^m(v|a|w)$/.test(unit)) v *= 1e-3;
  return v;
}

export interface SpecTemperatures {
  ambientC: number | null;
  maxJunctionC: number | null;
  lossJunctionC: number | null;
  source: string;
}

/** Temperatures come only from the specs: a junction spec first, then ambient. */
export function specTemperatures(
  specs: SpecsData | null | undefined,
): SpecTemperatures {
  const junction = specValue(specs, /junction/i, 'max');
  const ambient = specValue(
    specs,
    /^(?!.*junction).*(ambient|operating temp|environment|temperature)/i,
    'max',
  );
  if (junction !== null) {
    return {
      ambientC: ambient,
      maxJunctionC: junction,
      lossJunctionC: junction,
      source: 'Junction Temperature spec',
    };
  }
  if (ambient !== null) {
    return {
      ambientC: ambient,
      maxJunctionC: null,
      lossJunctionC: ambient,
      source: 'temperature spec',
    };
  }
  return {
    ambientC: null,
    maxJunctionC: null,
    lossJunctionC: null,
    source: 'none',
  };
}

/** Finite number or undefined; numeric strings accepted. */
export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

export const fmtW = (w: number): string =>
  w >= 0.1 ? `${w.toFixed(2)} W` : `${(w * 1e3).toFixed(1)} mW`;

/** Duty of the energising interval for a non-isolated converter, from the specs. */
export function estimateDuty(
  topologyId: string,
  vin: number | null,
  vout: number | null,
): number {
  if (!vin || !vout) return 0.5;
  if (/buck_boost|sepic|cuk|zeta/.test(topologyId)) return vout / (vin + vout);
  if (/boost|pfc/.test(topologyId)) return Math.max(0.05, 1 - vin / vout);
  if (/buck/.test(topologyId)) return Math.min(0.95, vout / vin);
  return 0.5;
}

export const round = (v: number | undefined, digits = 3): number | undefined =>
  v === undefined || !Number.isFinite(v)
    ? undefined
    : Number(v.toFixed(digits));
