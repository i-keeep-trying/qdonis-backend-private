/**
 * Port of the old frontend's `lib/studio/magneticsOperatingPoint.ts`
 * (chat-first `cab4f1f`).
 *
 * Electrical operating point of a converter and the winding waveforms each of
 * its magnetic parts sees, for the Magnetics stage when there is no simulated
 * waveform for the part.
 *
 * The operating point (Vin, Vout, Pout, η, fsw, line frequency) comes from the
 * specs first, then the design values, the circuit template and the
 * simulation measurements. Each part's waveforms then follow from the
 * converter's steady-state relations, using the inductance / magnetizing
 * inductance and turns ratio actually in the circuit:
 *
 *   • non-isolated DC-DC: inductor volt-seconds per period (CCM or DCM from
 *     the inductance), worst case of Vin min / Vin max;
 *   • isolated: duty from the turns ratio, reflected load current plus
 *     magnetizing current, output inductor at fsw (forward) or 2·fsw (bridges);
 *   • PFC / active front end / inverter: one switching period at every
 *     phase angle of a half line cycle, so the line envelope sets the peak
 *     and the RMS, and the ripple follows the instantaneous duty;
 *   • LLC / CLLC at resonance (FHA), DAB with single phase shift solved for
 *     the power.
 */
import type { SpecsData } from '../design/studio-specs.logic';
import type {
  MagneticInputRow,
  MagneticInputs,
  MagneticKind,
  MagneticWaveforms,
} from '../engines/magnetics/magnetics-engine';
import type { CircuitInventory } from './circuit-data.provider';

/** The design node's data (only its design values are read). */
type DesignData = { recalculated_parameters?: unknown };
/** A simulation node (only its measurements are read). */
type SimulationNode = { data?: Record<string, unknown> } | null;

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

type InventoryMagnetic = CircuitInventory['magnetics'][number];

export type ConverterFamily =
  | 'buck'
  | 'boost'
  | 'buck_boost'
  | 'four_switch'
  | 'sepic_cuk_zeta'
  | 'flyback'
  | 'forward'
  | 'bridge'
  | 'llc'
  | 'dab'
  | 'pfc'
  | 'afe'
  | 'inverter'
  | 'rectifier'
  | 'other';

export interface OperatingPoint {
  family: ConverterFamily;
  /** Input voltage range; RMS for AC inputs (line-to-line for three-phase). */
  vinMin: number | null;
  vinMax: number | null;
  vinAc: boolean;
  /** Output voltage; RMS for AC outputs (line-to-line for three-phase). Magnitude (inverting outputs are positive). */
  vout: number | null;
  voutAc: boolean;
  pout: number;
  efficiency: number;
  fsw: number;
  fLine: number;
  phases: 1 | 3;
  /** Where each value came from. */
  sources: Record<
    'vin' | 'vout' | 'pout' | 'efficiency' | 'fsw' | 'fLine',
    string
  >;
  assumptions: string[];
}

export interface PartEstimate {
  kind: MagneticKind;
  /** Frequency of the part's own waveform (2·fsw for a bridge's output inductor). */
  fsw: number;
  inductance: number | null;
  turnsRatio: number | null;
  waves: MagneticWaveforms;
  unipolar?: boolean;
  inputs: MagneticInputs;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const sig = (v: number, digits = 3) =>
  Number.isFinite(v) ? String(Number(v.toPrecision(digits))) : '—';
const fV = (v: number) => `${sig(v)} V`;
const fA = (v: number) => `${sig(v)} A`;
const fW = (v: number) =>
  Math.abs(v) >= 1e3 ? `${sig(v / 1e3)} kW` : `${sig(v)} W`;
const fHz = (v: number) =>
  v >= 1e6
    ? `${sig(v / 1e6)} MHz`
    : v >= 1e3
      ? `${sig(v / 1e3)} kHz`
      : `${sig(v)} Hz`;
const fH = (v: number) =>
  v >= 1e-3
    ? `${sig(v * 1e3)} mH`
    : v >= 1e-6
      ? `${sig(v * 1e6)} µH`
      : `${sig(v * 1e9)} nH`;
const fPct = (v: number) => `${sig(v * 100)} %`;
const row = (label: string, value: string, note?: string): MagneticInputRow =>
  note ? { label, value, note } : { label, value };

// ---------------------------------------------------------------------------
// Operating point
// ---------------------------------------------------------------------------

export function converterFamily(topologyId: string): ConverterFamily {
  const id = topologyId.toLowerCase();
  if (/flyback/.test(id)) return 'flyback';
  if (/forward/.test(id)) return 'forward';
  if (/llc/.test(id)) return 'llc';
  if (/dual_active_bridge|\bdab\b/.test(id)) return 'dab';
  if (
    /full_bridge|half_bridge|push_pull|phase_shifted/.test(id) &&
    id.startsWith('dcdc')
  )
    return 'bridge';
  if (/power_factor|pfc|totem/.test(id)) return 'pfc';
  if (/active_front_end|vienna|afe/.test(id)) return 'afe';
  if (id.startsWith('dcac') || /inverter/.test(id)) return 'inverter';
  if (/diode_bridge|full_wave|centre_tapped|center_tapped|rectifier/.test(id))
    return 'rectifier';
  if (/four_switch/.test(id)) return 'four_switch';
  if (/sepic|cuk|zeta/.test(id)) return 'sepic_cuk_zeta';
  if (/buck_boost/.test(id)) return 'buck_boost';
  if (/boost/.test(id)) return 'boost';
  if (/buck/.test(id)) return 'buck';
  return 'other';
}

interface SpecHit {
  value: number;
  values: number[];
  ac: boolean;
  name: string;
}

function specNumbersOf(value: string): number[] {
  const out: number[] = [];
  for (const m of String(value).matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)) {
    const n = parseFloat(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out.map((n, i) =>
    i > 0 && n < 0 && /\d\s*-\s*\d/.test(value) ? -n : n,
  );
}

function unitScale(unit: string, value: string): number {
  const u = `${unit || ''} ${value || ''}`;
  if (/\bk(v|w|a|hz|va)\b/i.test(u)) return 1e3;
  if (/\bMHz\b|\bMW\b/.test(u)) return 1e6;
  if (/\bm(v|a|w)\b/.test(u)) return 1e-3;
  return 1;
}

function findSpec(
  specs: SpecsData | null | undefined,
  include: RegExp[],
  exclude?: RegExp,
): SpecHit | null {
  for (const pattern of include) {
    for (const r of specs?.rows || []) {
      if (!pattern.test(r.name) || (exclude && exclude.test(r.name))) continue;
      const values = specNumbersOf(r.value);
      if (!values.length) continue;
      const scale = unitScale(r.unit || '', r.value);
      const scaled = values.map((v) => v * scale);
      const text = `${r.name} ${r.unit || ''} ${r.value}`;
      return {
        value: scaled[0],
        values: scaled,
        ac: /\bac\b|vac|rms|mains|grid|line[- ]?(to|voltage)/i.test(text),
        name: r.name,
      };
    }
  }
  return null;
}

const NOT_A_LEVEL =
  /ripple|regulation|overshoot|undershoot|accuracy|tolerance|deviation|protection|\bovp\b|\buvlo\b|transient|droop|sense|reference|isolation|withstand|hold.?up|start/i;

function designVout(design: DesignData | null | undefined): number | null {
  const rows = Array.isArray(design?.recalculated_parameters)
    ? (design.recalculated_parameters as unknown[]).map(rec)
    : [];
  for (const r of rows) {
    const ref = (typeof r.ref === 'string' ? r.ref : '').toUpperCase();
    const param = (typeof r.param === 'string' ? r.param : '').toLowerCase();
    if (
      ref === 'VOUT' ||
      ref === 'V_OUT' ||
      ref === 'VO' ||
      param === 'target_voltage' ||
      param === 'target_vout'
    ) {
      const v = parseFloat(String(r.after));
      if (Number.isFinite(v) && v !== 0) return v;
    }
  }
  return null;
}

/** Output voltage measured by the simulation (average for DC outputs, RMS for AC). */
export function simulatedVout(
  sim: SimulationNode | undefined,
): { value: number; rms: boolean; key: string } | null {
  const results = rec(sim?.data?.results);
  if (!Object.keys(results).length) return null;
  const found: Array<{ key: string; value: number }> = [];
  for (const analysis of ['transient', 'dc']) {
    for (const req of Object.values(rec(results[analysis]))) {
      for (const [key, value] of Object.entries(rec(rec(req).measurement))) {
        const v = typeof value === 'number' ? value : parseFloat(String(value));
        if (Number.isFinite(v)) found.push({ key, value: v });
      }
    }
  }
  for (const re of [
    /^v_?out(_tot)?_?(avg|final|steady|dc|mean)$/i,
    /^v_?out(_a)?_?rms$/i,
    /^v_?out_avg/i,
  ]) {
    const hit = found.find((f) => re.test(f.key));
    if (hit)
      return { value: hit.value, rms: /rms/i.test(hit.key), key: hit.key };
  }
  return null;
}

export function buildOperatingPoint(args: {
  topologyId: string;
  specs: SpecsData | null | undefined;
  inventory: CircuitInventory;
  design?: DesignData | null;
  sim?: SimulationNode;
  fsw: number;
  fswSource: string;
}): OperatingPoint {
  const { topologyId, specs, inventory, design, sim, fsw, fswSource } = args;
  const family = converterFamily(topologyId);
  const assumptions: string[] = [];
  const lineInput =
    family === 'pfc' ||
    family === 'afe' ||
    family === 'rectifier' ||
    (family === 'flyback' && topologyId.startsWith('acdc'));
  const threePhase =
    /three_phase|vienna|t_type|3ph/.test(topologyId) ||
    (inventory.power_sources || []).filter((s) => s.kind === 'ac').length >=
      3 ||
    inventory.magnetics.filter(
      (m) =>
        /^L_?[ABC]$|phase_[abc]|_inductor_[abc]$/i.test(`${m.ref}`) ||
        /phase_[abc]|_[abc]$/i.test(String(m.role || '')),
    ).length >= 3;
  const phases: 1 | 3 =
    threePhase && (lineInput || family === 'inverter') ? 3 : 1;

  // ---- Input voltage
  const vinInclude = [
    /input voltage/i,
    /^v_?in\b/i,
    /\bvin\b/i,
    /mains|grid voltage|line voltage|ac input/i,
  ];
  if (family === 'inverter')
    vinInclude.push(/dc.?(link|bus)|bus voltage|battery voltage/i);
  const vinSpec = findSpec(specs, vinInclude, NOT_A_LEVEL);
  let vinMin: number | null = null,
    vinMax: number | null = null,
    vinAc = lineInput,
    vinSource = '';
  if (vinSpec) {
    vinMin = Math.min(...vinSpec.values.filter((v) => v > 0));
    vinMax = Math.max(...vinSpec.values.filter((v) => v > 0));
    vinAc = lineInput || vinSpec.ac;
    vinSource = `specs (${vinSpec.name})`;
    if (
      vinAc &&
      phases === 3 &&
      vinMax < 300 &&
      !/line|ll|l-l/i.test(vinSpec.name)
    ) {
      vinMin *= Math.sqrt(3);
      vinMax *= Math.sqrt(3);
      vinSource += ', taken as phase voltage';
    }
  } else {
    const sources = inventory.power_sources || [];
    const ac = sources.filter((s) => s.kind === 'ac' && s.peak);
    const dc = sources.filter((s) => s.kind === 'dc' && s.value);
    if (lineInput && ac.length) {
      const vph = ac[0].peak! / Math.SQRT2;
      vinMin = vinMax = phases === 3 ? vph * Math.sqrt(3) : vph;
      vinAc = true;
      vinSource = `circuit source ${ac[0].ref} (${sig(ac[0].peak!)} V peak)`;
    } else if (dc.length) {
      const inputs = dc.filter(
        (s) =>
          /input|dc_link|bus/i.test(String(s.role || '')) ||
          /^V(IN|S|DC)/i.test(s.ref),
      );
      const used = inputs.length ? inputs : dc.slice(0, 1);
      // Split DC links (VDC_TOP + VDC_BOT) add up.
      const total =
        family === 'inverter'
          ? used.reduce((a, s) => a + s.value!, 0)
          : used[0].value!;
      vinMin = vinMax = total;
      vinAc = false;
      vinSource = `circuit source${used.length > 1 && family === 'inverter' ? 's' : ''} ${used.map((s) => s.ref).join(' + ')}`;
    } else if (inventory.input_voltage) {
      vinMin = vinMax = inventory.input_voltage;
      vinAc = false;
      vinSource = 'circuit input source';
    }
  }

  // ---- Output voltage
  const voutInclude = [/output voltage/i, /^v_?out\b/i, /\bvout\b/i];
  if (family === 'pfc' || family === 'afe' || family === 'rectifier')
    voutInclude.push(/dc.?(bus|link)|bus voltage|output dc|dc output/i);
  if (family === 'inverter')
    voutInclude.push(/ac output|grid voltage|line voltage|load voltage/i);
  const voutSpec = findSpec(specs, voutInclude, NOT_A_LEVEL);
  const voutAc = family === 'inverter';
  let vout: number | null = null,
    voutSource = '';
  if (voutSpec) {
    vout = Math.abs(voutSpec.value);
    voutSource = `specs (${voutSpec.name})`;
    if (
      voutAc &&
      phases === 3 &&
      !/line|ll|l-l/i.test(voutSpec.name) &&
      vout < 300 &&
      /phase/i.test(voutSpec.name)
    ) {
      vout *= Math.sqrt(3);
      voutSource += ', phase voltage × √3';
    }
  } else {
    const fromDesign = designVout(design);
    const target = inventory.output_voltage;
    const measured = simulatedVout(sim);
    if (fromDesign !== null) {
      vout = Math.abs(fromDesign);
      voutSource = 'design values';
    } else if (target) {
      vout = Math.abs(target.value);
      voutSource = `circuit target (${target.key})`;
    } else if (measured) {
      vout = Math.abs(measured.value);
      voutSource = `simulation (${measured.key})`;
      if (voutAc && !measured.rms) vout /= Math.SQRT2;
    }
  }

  // ---- Power and efficiency
  const powerSpec = findSpec(
    specs,
    [
      /output power|rated power|\bpout\b|load power|continuous power/i,
      /^(max(imum)? )?power\b/i,
    ],
    /loss|density|factor|dissipation|supply|auxiliary|gate/i,
  );
  let pout = 0,
    poutSource = '';
  if (powerSpec) {
    pout = Math.max(...powerSpec.values.filter((v) => v > 0));
    poutSource = `specs (${powerSpec.name})`;
  } else {
    const currentSpec = findSpec(
      specs,
      [/output current|load current|\biout\b/i],
      NOT_A_LEVEL,
    );
    const rl = inventory.load_resistance;
    if (currentSpec && vout) {
      pout = vout * Math.max(...currentSpec.values);
      poutSource = `Vout × ${currentSpec.name}`;
    } else if (rl && vout) {
      const vph = voutAc && phases === 3 ? vout / Math.sqrt(3) : vout;
      pout = ((voutAc && phases === 3 ? 3 : 1) * (vph * vph)) / rl;
      poutSource = `Vout² / load resistance (${sig(rl)} Ω)`;
    } else {
      pout = 100;
      poutSource = 'assumed';
      assumptions.push('Output power is not in the specs: 100 W assumed.');
    }
  }
  const effSpec = findSpec(specs, [/efficiency/i]);
  let efficiency =
    family === 'pfc' || family === 'afe' || family === 'inverter'
      ? 0.96
      : family === 'rectifier'
        ? 0.9
        : 0.9;
  let effSource = 'assumed';
  if (effSpec) {
    const e = Math.max(...effSpec.values);
    if (e > 0) {
      efficiency = Math.min(0.995, e > 1 ? e / 100 : e);
      effSource = `specs (${effSpec.name})`;
    }
  }

  // ---- Line frequency
  const fLineSpec = findSpec(
    specs,
    [
      /line freq|grid freq|mains freq|output freq|ac freq|fundamental freq|^frequency$/i,
    ],
    /switch/i,
  );
  let fLine = 50,
    fLineSource = 'assumed 50 Hz';
  if (fLineSpec && fLineSpec.value > 0 && fLineSpec.value < 2000) {
    fLine = fLineSpec.value;
    fLineSource = `specs (${fLineSpec.name})`;
  } else {
    const ac = (inventory.power_sources || []).find(
      (s) => s.kind === 'ac' && s.frequency,
    );
    if (ac?.frequency) {
      fLine = ac.frequency;
      fLineSource = `circuit source ${ac.ref}`;
    }
  }

  if (vinMin === null)
    assumptions.push('No input voltage in the specs or the circuit.');
  if (vout === null)
    assumptions.push(
      'No output voltage in the specs, design values, circuit or simulation.',
    );

  return {
    family,
    vinMin,
    vinMax,
    vinAc,
    vout,
    voutAc,
    pout,
    efficiency,
    fsw,
    fLine,
    phases,
    sources: {
      vin: vinSource || 'missing',
      vout: voutSource || 'missing',
      pout: poutSource,
      efficiency: effSource,
      fsw: fswSource,
      fLine: fLineSource,
    },
    assumptions,
  };
}

/** Rows describing the operating point, for the view and the chat. */
export function operatingPointRows(op: OperatingPoint): MagneticInputRow[] {
  const lineSide = op.vinAc || op.voutAc;
  const vinLabel = op.vinAc
    ? op.phases === 3
      ? 'Vin (RMS, line-line)'
      : 'Vin (RMS)'
    : 'Vin';
  const voutLabel = op.voutAc
    ? op.phases === 3
      ? 'Vout (RMS, line-line)'
      : 'Vout (RMS)'
    : 'Vout';
  const rows: MagneticInputRow[] = [
    row(
      vinLabel,
      op.vinMin === null
        ? 'not given'
        : op.vinMin === op.vinMax
          ? fV(op.vinMin)
          : `${sig(op.vinMin)} – ${fV(op.vinMax!)}`,
      op.sources.vin,
    ),
    row(
      voutLabel,
      op.vout === null ? 'not given' : fV(op.vout),
      op.sources.vout,
    ),
    row('Pout', fW(op.pout), op.sources.pout),
    row('Efficiency', fPct(op.efficiency), op.sources.efficiency),
    row('fsw', fHz(op.fsw), op.sources.fsw),
  ];
  if (lineSide)
    rows.push(
      row('Line frequency', fHz(op.fLine), op.sources.fLine),
      row('Phases', String(op.phases)),
    );
  return rows;
}

// ---------------------------------------------------------------------------
// Waveform building blocks
// ---------------------------------------------------------------------------

/** Sample at x ∈ [0, 1) of one switching period: [winding voltage, primary current, secondary current]. */
type PeriodFn = ((x: number) => [number, number, number?]) & {
  /** Mean winding voltage over [x0, x1): keeps the volt-seconds of intervals shorter than a sample. */
  vMean?: (x0: number, x1: number) => number;
};

interface Seg {
  len: number;
  v: number;
  i0: number;
  i1: number;
  s0?: number;
  s1?: number;
}

/** Piecewise-linear period: constant voltage, linear currents in each segment. */
function pwl(segs: Seg[]): PeriodFn {
  const total = segs.reduce((a, s) => a + Math.max(0, s.len), 0) || 1;
  const parts = segs
    .filter((s) => s.len > 0)
    .map((s) => ({ ...s, len: s.len / total }));
  const fn: PeriodFn = (x) => {
    let start = 0;
    for (const s of parts) {
      if (x < start + s.len || s === parts[parts.length - 1]) {
        const t = Math.min(1, Math.max(0, (x - start) / s.len));
        const sec =
          s.s0 !== undefined ? s.s0 + ((s.s1 ?? s.s0) - s.s0) * t : undefined;
        return [s.v, s.i0 + (s.i1 - s.i0) * t, sec];
      }
      start += s.len;
    }
    return [0, 0, 0];
  };
  fn.vMean = (x0, x1) => {
    let start = 0,
      area = 0;
    for (const s of parts) {
      const lo = Math.max(x0, start),
        hi = Math.min(x1, start + s.len);
      if (hi > lo) area += s.v * (hi - lo);
      start += s.len;
    }
    return area / Math.max(x1 - x0, 1e-12);
  };
  return fn;
}

function buildWaves(
  fsw: number,
  periods: PeriodFn[],
  basis: string,
  withSecondary: boolean,
): MagneticWaveforms {
  const spp = periods.length > 1 ? 64 : 128;
  const v: number[] = [],
    iPri: number[] = [],
    iSec: number[] = [];
  for (const fn of periods) {
    for (let k = 0; k < spp; k++) {
      const [vv, ii, ss] = fn((k + 0.5) / spp);
      v.push(fn.vMean ? fn.vMean(k / spp, (k + 1) / spp) : vv);
      iPri.push(ii);
      if (withSecondary) iSec.push(ss ?? 0);
    }
  }
  return {
    dt: 1 / (fsw * spp),
    spp,
    v,
    iPri,
    iSec: withSecondary ? iSec : null,
    source: 'estimate',
    basis,
  };
}

function currentStats(w: MagneticWaveforms) {
  let peak = 0,
    sq = 0,
    sum = 0,
    max = -Infinity,
    min = Infinity;
  for (const x of w.iPri) {
    peak = Math.max(peak, Math.abs(x));
    sq += x * x;
    sum += x;
    max = Math.max(max, x);
    min = Math.min(min, x);
  }
  const n = w.iPri.length || 1;
  let sPeak = 0,
    sSq = 0;
  for (const x of w.iSec || []) {
    sPeak = Math.max(sPeak, Math.abs(x));
    sSq += x * x;
  }
  return {
    peak,
    rms: Math.sqrt(sq / n),
    avg: sum / n,
    pp: max - min,
    secPeak: sPeak,
    secRms: w.iSec?.length ? Math.sqrt(sSq / w.iSec.length) : 0,
  };
}

interface InductorPeriod {
  fn: PeriodFn;
  mode: 'CCM' | 'DCM';
  duty: number;
  ripplePP: number;
  peak: number;
}

/**
 * One period of an inductor that sees +vOn while the switch is on and −vOff
 * while it is off, carrying the average current iAvg. DCM when the ripple
 * would take the current below zero and the switch cannot conduct backwards.
 */
function inductorPeriod(
  vOn: number,
  vOff: number,
  iAvg: number,
  L: number,
  fsw: number,
  forceCcm: boolean,
): InductorPeriod {
  const on = Math.max(vOn, 1e-6),
    off = Math.max(vOff, 1e-6);
  const D = off / (on + off);
  const dI = (on * D) / (L * fsw);
  if (forceCcm || Math.abs(iAvg) >= dI / 2) {
    const lo = iAvg - dI / 2,
      hi = iAvg + dI / 2;
    return {
      fn: pwl([
        { len: D, v: on, i0: lo, i1: hi },
        { len: 1 - D, v: -off, i0: hi, i1: lo },
      ]),
      mode: 'CCM',
      duty: D,
      ripplePP: dI,
      peak: Math.max(Math.abs(lo), Math.abs(hi)),
    };
  }
  const a = Math.abs(iAvg);
  const d1 = Math.sqrt((2 * L * a * fsw) / (on * (1 + on / off)));
  const d2 = (d1 * on) / off;
  const ipk = (on * d1) / (L * fsw);
  return {
    fn: pwl([
      { len: d1, v: on, i0: 0, i1: ipk },
      { len: d2, v: -off, i0: ipk, i1: 0 },
      { len: Math.max(0, 1 - d1 - d2), v: 0, i0: 0, i1: 0 },
    ]),
    mode: 'DCM',
    duty: d1,
    ripplePP: ipk,
    peak: ipk,
  };
}

/** Phase angles of a half line cycle, symmetric about (and including) the crest. */
const LINE_SLICES = 33;
const lineAngles = () =>
  Array.from(
    { length: LINE_SLICES },
    (_, k) => ((k + 0.5) * Math.PI) / LINE_SLICES,
  );

const isEmi = (m: InventoryMagnetic) =>
  /(^|_)emi(_|$)|common.?mode|cm_choke|input_filter|line_filter/i.test(
    `${m.ref}_${m.role || ''}`,
  );
const isOutputInductor = (m: InventoryMagnetic) =>
  /output|(^|_)out(_|$)|filter/i.test(`${m.ref}_${m.role || ''}`) && !isEmi(m);
const isResonant = (m: InventoryMagnetic) =>
  /resonant|leakage|^l_?r$|^l_?lk$|^ls$/i.test(`${m.role || ''}`) ||
  /^(L_?R|LLK|LR|LS)$/i.test(m.ref);
const isTransformer = (m: InventoryMagnetic) => /transformer/.test(m.type);

// ---------------------------------------------------------------------------
// Per-part estimates
// ---------------------------------------------------------------------------

export function estimatePart(
  m: InventoryMagnetic,
  all: InventoryMagnetic[],
  op: OperatingPoint,
  topologyId: string,
  kind: MagneticKind,
): PartEstimate | null {
  if (op.vinMin === null || op.vinMax === null) return null;
  const id = topologyId.toLowerCase();
  const fsw = op.fsw;
  const assumptions: string[] = [...op.assumptions];
  const L0 = m.inductance ?? m.magnetizing_inductance ?? null;
  const n = m.turns_ratio && m.turns_ratio > 0 ? m.turns_ratio : null;
  const pin = op.pout / op.efficiency;
  const inductorsOf = (pred: (x: InventoryMagnetic) => boolean) =>
    all.filter((x) => !isTransformer(x) && pred(x));

  /** Inductance from the circuit, or one that gives ~30 % ripple when the circuit has none. */
  const needL = (vOn: number, D: number, iAvg: number, f: number): number => {
    if (L0 && L0 > 0) return L0;
    const L =
      (Math.max(vOn, 1e-3) * D) / (0.3 * Math.max(Math.abs(iAvg), 1e-3) * f);
    assumptions.push(
      `${m.ref} has no inductance in the circuit: ${fH(L)} assumed (30 % ripple).`,
    );
    return L;
  };

  const finish = (
    e: Omit<PartEstimate, 'inputs'> & {
      basis: string;
      rows: MagneticInputRow[];
    },
  ): PartEstimate => {
    const st = currentStats(e.waves);
    const rows = [...e.rows];
    if (e.inductance)
      rows.push(
        row(isTransformer(m) ? 'Lm' : 'L', fH(e.inductance), 'circuit'),
      );
    if (e.turnsRatio) rows.push(row('Ns/Np', sig(e.turnsRatio, 4), 'circuit'));
    rows.push(row('Waveform frequency', fHz(e.fsw)));
    rows.push(
      row('I peak', fA(st.peak)),
      row('I RMS', fA(st.rms)),
      row('I avg', fA(st.avg)),
    );
    if (e.waves.iSec)
      rows.push(
        row('I sec peak', fA(st.secPeak)),
        row('I sec RMS', fA(st.secRms)),
      );
    return {
      kind: e.kind,
      fsw: e.fsw,
      inductance: e.inductance,
      turnsRatio: e.turnsRatio,
      waves: e.waves,
      unipolar: e.unipolar,
      inputs: {
        basis: e.basis,
        rows,
        ...(assumptions.length
          ? { assumptions: Array.from(new Set(assumptions)) }
          : {}),
      },
    };
  };

  const vout = op.vout;
  const vinCases = Array.from(new Set([op.vinMin, op.vinMax]));
  const caseLabel = (vin: number) =>
    op.vinMin === op.vinMax
      ? ''
      : vin === op.vinMin
        ? ' · at Vin min'
        : ' · at Vin max';

  // ---------------------------------------------------------------- DC-DC inductors
  if (
    ['buck', 'boost', 'buck_boost', 'four_switch', 'sepic_cuk_zeta'].includes(
      op.family,
    ) &&
    !isTransformer(m)
  ) {
    if (vout === null) return null;
    const synchronous = /synchronous|interleaved|four_switch/.test(id);
    const phases = Math.max(
      1,
      inductorsOf((x) => /ph\d|phase/i.test(String(x.role || ''))).length,
    );
    const iout = op.pout / vout;
    let best: {
      ip: InductorPeriod;
      vin: number;
      vOn: number;
      vOff: number;
      iL: number;
      L: number;
      label: string;
    } | null = null;
    for (const vin of vinCases) {
      const iin = pin / vin;
      let vOn: number, vOff: number, iL: number, label: string;
      switch (op.family) {
        case 'buck':
          if (vin <= vout) continue;
          vOn = vin - vout;
          vOff = vout;
          iL = iout / phases;
          label =
            phases > 1
              ? `Buck phase inductor (1 of ${phases})`
              : 'Buck output inductor';
          break;
        case 'boost':
          if (vin >= vout) continue;
          vOn = vin;
          vOff = vout - vin;
          iL = iin;
          label = 'Boost inductor';
          break;
        case 'four_switch':
          if (vin > vout) {
            vOn = vin - vout;
            vOff = vout;
            iL = iout;
            label = 'Four-switch buck-boost inductor (buck mode)';
          } else {
            vOn = vin;
            vOff = vout - vin;
            iL = iin;
            label = 'Four-switch buck-boost inductor (boost mode)';
          }
          break;
        case 'buck_boost':
          vOn = vin;
          vOff = vout;
          iL = iin + iout;
          label = 'Inverting buck-boost inductor (I_L = Iin + Iout)';
          break;
        default: {
          const input =
            /input/i.test(String(m.role || '')) ||
            (!/output|transfer/i.test(String(m.role || '')) &&
              all.filter((x) => !isTransformer(x))[0]?.ref === m.ref);
          vOn = vin;
          vOff = vout;
          iL = input ? iin : iout;
          label = `${input ? 'Input' : 'Output'} inductor of the ${id.includes('sepic') ? 'SEPIC' : id.includes('cuk') ? 'Ćuk' : 'Zeta'} (I_L = ${input ? 'Iin' : 'Iout'})`;
        }
      }
      const L = needL(vOn, vOff / (vOn + vOff), iL, fsw);
      const ip = inductorPeriod(vOn, vOff, iL, L, fsw, synchronous);
      if (!best || ip.peak > best.ip.peak)
        best = { ip, vin, vOn, vOff, iL, L, label };
    }
    if (!best) return null;
    const { ip, vin, vOn, vOff, iL, L, label } = best;
    return finish({
      kind,
      fsw,
      inductance: L,
      turnsRatio: null,
      waves: buildWaves(
        fsw,
        [ip.fn],
        `idealised ${label.toLowerCase()} current (${ip.mode})`,
        false,
      ),
      basis: `${label} · ${ip.mode}${caseLabel(vin)} (worst-case peak current)`,
      rows: [
        row('Vin', fV(vin), op.sources.vin),
        row('Vout', fV(vout), op.sources.vout),
        row('Pout', fW(op.pout), op.sources.pout),
        row(
          'Duty D',
          fPct(ip.duty),
          ip.mode === 'CCM' ? 'D = V_off/(V_on + V_off)' : 'DCM on-time',
        ),
        row('V_L on / off', `${sig(vOn)} / −${fV(vOff)}`),
        row('I_L average', fA(iL)),
        row(
          'ΔI_L (p-p)',
          fA(ip.ripplePP),
          ip.mode === 'CCM' ? 'V_on·D/(L·fsw)' : 'DCM peak',
        ),
      ],
    });
  }

  // ---------------------------------------------------------------- Flyback
  if (op.family === 'flyback' && isTransformer(m)) {
    const Lm = m.magnetizing_inductance ?? m.inductance ?? null;
    if (!Lm) return null;
    let nn = n,
      vo = vout;
    const acLine = op.vinAc;
    const vinRef = acLine ? op.vinMin * Math.SQRT2 : op.vinMin;
    if (!vo && nn) {
      vo = nn * vinRef * (0.45 / 0.55);
      assumptions.push(
        `Vout not given: ${fV(vo)} assumed (D = 0.45 at Vin min).`,
      );
    }
    if (vo && !nn) {
      nn = vo / (vinRef * (0.45 / 0.55));
      assumptions.push(
        `No turns ratio in the circuit: Ns/Np = ${sig(nn)} assumed (D = 0.45 at Vin min).`,
      );
    }
    if (!vo || !nn) return null;
    const vor = vo / nn;

    if (acLine) {
      // DCM PFC flyback with constant on-time: Pin = Vpk²·D²/(4·Lm·fsw).
      const vpk = op.vinMin * Math.SQRT2;
      let D = Math.sqrt(4 * pin * Lm * fsw) / vpk;
      if (D > 0.9) {
        D = 0.9;
        assumptions.push(
          'Lm is too large for DCM at this power: on-time clamped at D = 0.9.',
        );
      }
      const periods = lineAngles().map((th) => {
        const vin = vpk * Math.sin(th);
        const ipk = (vin * D) / (Lm * fsw);
        const d2 = Math.min(1 - D, (ipk * Lm * fsw) / vor);
        return pwl([
          { len: D, v: vin, i0: 0, i1: ipk, s0: 0, s1: 0 },
          { len: d2, v: -vor, i0: 0, i1: 0, s0: ipk / nn, s1: 0 },
          { len: Math.max(0, 1 - D - d2), v: 0, i0: 0, i1: 0, s0: 0, s1: 0 },
        ]);
      });
      return finish({
        kind: 'flyback',
        fsw,
        inductance: Lm,
        turnsRatio: nn,
        waves: buildWaves(
          fsw,
          periods,
          'idealised DCM flyback currents over a half line cycle',
          true,
        ),
        basis: `PFC flyback · DCM, constant on-time · half line cycle at Vin min`,
        rows: [
          row('Vin (RMS)', fV(op.vinMin), op.sources.vin),
          row('Vin peak', fV(vpk)),
          row('Vout', fV(vo), op.sources.vout),
          row('Pout', fW(op.pout), op.sources.pout),
          row('Reflected Vor = Vout/n', fV(vor)),
          row('On-time duty D', fPct(D), 'D = √(4·Pin·Lm·fsw)/Vpk'),
        ],
      });
    }

    let best: {
      fn: PeriodFn;
      mode: string;
      D: number;
      ipk: number;
      iv: number;
      vin: number;
    } | null = null;
    for (const vin of vinCases) {
      let D = vor / (vin + vor);
      const dI = (vin * D) / (Lm * fsw);
      let iv = pin / (vin * D) - dI / 2;
      let ipk: number, fn: PeriodFn, mode: string;
      if (iv >= 0) {
        ipk = iv + dI;
        mode = 'CCM';
        fn = pwl([
          { len: D, v: vin, i0: iv, i1: ipk, s0: 0, s1: 0 },
          { len: 1 - D, v: -vor, i0: 0, i1: 0, s0: ipk / nn, s1: iv / nn },
        ]);
      } else {
        iv = 0;
        mode = 'DCM';
        ipk = Math.sqrt((2 * pin) / (Lm * fsw));
        D = (ipk * Lm * fsw) / vin;
        const d2 = Math.min(1 - D, (ipk * Lm * fsw) / vor);
        fn = pwl([
          { len: D, v: vin, i0: 0, i1: ipk, s0: 0, s1: 0 },
          { len: d2, v: -vor, i0: 0, i1: 0, s0: ipk / nn, s1: 0 },
          { len: Math.max(0, 1 - D - d2), v: 0, i0: 0, i1: 0, s0: 0, s1: 0 },
        ]);
      }
      if (!best || ipk > best.ipk) best = { fn, mode, D, ipk, iv, vin };
    }
    const b = best!;
    return finish({
      kind: 'flyback',
      fsw,
      inductance: Lm,
      turnsRatio: nn,
      waves: buildWaves(
        fsw,
        [b.fn],
        `idealised ${b.mode} flyback currents`,
        true,
      ),
      basis: `${/active_clamp/.test(id) ? 'Active-clamp flyback' : 'Flyback'} transformer · ${b.mode}${caseLabel(b.vin)}`,
      rows: [
        row('Vin', fV(b.vin), op.sources.vin),
        row('Vout', fV(vo), op.sources.vout),
        row('Pout', fW(op.pout), op.sources.pout),
        row('Reflected Vor = Vout/n', fV(vor)),
        row(
          'Duty D',
          fPct(b.D),
          b.mode === 'CCM'
            ? 'D = Vor/(Vin + Vor)'
            : 'DCM: Ipk = √(2·Pin/(Lm·fsw))',
        ),
        row('I valley / peak (pri)', `${sig(b.iv)} / ${fA(b.ipk)}`),
      ],
    });
  }

  // ---------------------------------------------------------------- Forward
  if (op.family === 'forward') {
    const xfmr = all.find(isTransformer);
    const nn = (isTransformer(m) ? n : xfmr?.turns_ratio) ?? null;
    if (!vout || !nn) return null;
    const iout = op.pout / vout;
    const outL = inductorsOf(isOutputInductor)[0] || inductorsOf(() => true)[0];
    const Lo = outL?.inductance ?? null;
    const duty = (vin: number) => {
      const D = vout / (nn * vin);
      return D > 0.5 ? 0.5 : D;
    };
    if (vout / (nn * op.vinMin) > 0.5)
      assumptions.push(
        `Vout/(n·Vin min) = ${sig(vout / (nn * op.vinMin))} needs D > 0.5, which the reset cannot support: duty clamped at 50 % (raise Ns/Np).`,
      );
    if (!isTransformer(m)) {
      let best: { ip: InductorPeriod; vin: number; L: number } | null = null;
      for (const vin of vinCases) {
        const D = duty(vin);
        const vOn = Math.max(nn * vin - vout, 1e-3);
        const L = needL(vOn, D, iout, fsw);
        const ip = inductorPeriod(
          vOn,
          (vOn * D) / (1 - D),
          iout,
          L,
          fsw,
          false,
        );
        if (!best || ip.peak > best.ip.peak) best = { ip, vin, L };
      }
      const b = best!;
      return finish({
        kind,
        fsw,
        inductance: b.L,
        turnsRatio: null,
        waves: buildWaves(
          fsw,
          [b.ip.fn],
          'idealised forward output-inductor current',
          false,
        ),
        basis: `Forward output inductor · ${b.ip.mode}${caseLabel(b.vin)}`,
        rows: [
          row('Vin', fV(b.vin), op.sources.vin),
          row('Vout', fV(vout), op.sources.vout),
          row('Pout', fW(op.pout), op.sources.pout),
          row('Duty D = Vout/(n·Vin)', fPct(b.ip.duty)),
          row('I_L average = Iout', fA(iout)),
          row('ΔI_L (p-p)', fA(b.ip.ripplePP)),
        ],
      });
    }
    const Lm = m.magnetizing_inductance ?? m.inductance ?? null;
    const vin = op.vinMin;
    const D = duty(vin);
    const dIL = Lo ? ((nn * vin - vout) * D) / (Lo * fsw) : 0.2 * iout;
    const im = Lm ? (vin * D) / (Lm * fsw) : 0;
    const twoSwitch = /two_switch/.test(id);
    const fn = pwl([
      {
        len: D,
        v: vin,
        i0: nn * (iout - dIL / 2),
        i1: nn * (iout + dIL / 2) + im,
        s0: iout - dIL / 2,
        s1: iout + dIL / 2,
      },
      { len: D, v: -vin, i0: twoSwitch ? im : 0, i1: 0, s0: 0, s1: 0 },
      { len: Math.max(0, 1 - 2 * D), v: 0, i0: 0, i1: 0, s0: 0, s1: 0 },
    ]);
    return finish({
      kind: 'transformer',
      fsw,
      inductance: Lm,
      turnsRatio: nn,
      unipolar: true,
      waves: buildWaves(
        fsw,
        [fn],
        'idealised forward-transformer currents',
        true,
      ),
      basis: `${twoSwitch ? 'Two-switch' : 'Single-switch'} forward transformer · unipolar flux${caseLabel(vin)}`,
      rows: [
        row('Vin', fV(vin), op.sources.vin),
        row('Vout', fV(vout), op.sources.vout),
        row('Pout', fW(op.pout), op.sources.pout),
        row('Duty D = Vout/(n·Vin)', fPct(D)),
        row('Reflected load n·Iout', fA(nn * iout)),
        row('Magnetizing peak', fA(im), 'Vin·D/(Lm·fsw)'),
        row(
          'Volt-seconds',
          `${sig(((vin * D) / fsw) * 1e6)} V·µs`,
          'Vin·D/fsw',
        ),
      ],
    });
  }

  // ---------------------------------------------------------------- Bridge (FB / HB / push-pull / PSFB)
  if (op.family === 'bridge') {
    const xfmr = all.find(isTransformer);
    const nn = (isTransformer(m) ? n : xfmr?.turns_ratio) ?? null;
    if (!nn) return null;
    const halfBridge = /half_bridge/.test(id);
    const pushPull =
      /push_pull/.test(id) || xfmr?.type === 'dual_ct_transformer';
    const psfb = /phase_shifted/.test(id);
    const vp = (vin: number) => (halfBridge ? vin / 2 : vin);
    let vo = vout;
    if (!vo) {
      vo = 0.8 * nn * vp(op.vinMin);
      assumptions.push(
        `Vout not given: ${fV(vo)} assumed (80 % effective duty at Vin min).`,
      );
    }
    const iout = op.pout / vo;
    const deff = (vin: number) => Math.min(0.95, vo / (nn * vp(vin)));
    if (vo / (nn * vp(op.vinMin)) > 0.95)
      assumptions.push(
        `Vout/(n·Vp) at Vin min is ${sig(vo / (nn * vp(op.vinMin)))}: the turns ratio is too low for the output; effective duty clamped at 95 %.`,
      );
    const outL = inductorsOf(isOutputInductor)[0] || null;
    const Lo = outL?.inductance ?? null;
    const fOut = 2 * fsw;
    const label = halfBridge
      ? 'Half-bridge'
      : pushPull
        ? 'Push-pull'
        : psfb
          ? 'Phase-shifted full-bridge'
          : 'Full-bridge';

    if (!isTransformer(m) && outL && m.ref === outL.ref) {
      let best: {
        ip: InductorPeriod;
        vin: number;
        L: number;
        D: number;
      } | null = null;
      for (const vin of vinCases) {
        const D = deff(vin);
        const vOn = Math.max(nn * vp(vin) - vo, 1e-3);
        const L = needL(vOn, D, iout, fOut);
        const ip = inductorPeriod(
          vOn,
          (vOn * D) / (1 - D),
          iout,
          L,
          fOut,
          false,
        );
        if (!best || ip.peak > best.ip.peak) best = { ip, vin, L, D };
      }
      const b = best!;
      return finish({
        kind,
        fsw: fOut,
        inductance: b.L,
        turnsRatio: null,
        waves: buildWaves(
          fOut,
          [b.ip.fn],
          `idealised ${label.toLowerCase()} output-inductor current at 2·fsw`,
          false,
        ),
        basis: `${label} output inductor · ripple at 2·fsw · ${b.ip.mode}${caseLabel(b.vin)}`,
        rows: [
          row('Vin', fV(b.vin), op.sources.vin),
          row('Vout', fV(vo), op.sources.vout),
          row('Pout', fW(op.pout), op.sources.pout),
          row(
            'Effective duty Deff = Vout/(n·Vp)',
            fPct(b.D),
            halfBridge ? 'Vp = Vin/2' : 'Vp = Vin',
          ),
          row('I_L average = Iout', fA(iout)),
          row('ΔI_L (p-p)', fA(b.ip.ripplePP), 'Vout·(1−Deff)/(L·2fsw)'),
        ],
      });
    }

    const vin = op.vinMin;
    const D = deff(vin);
    const Vp = vp(vin);
    const dIL = Lo ? (vo * (1 - D)) / (Lo * fOut) : 0.2 * iout;
    const xLm = xfmr?.magnetizing_inductance ?? xfmr?.inductance ?? null;
    // Dual centre-tapped primaries: each half has a quarter of the full-winding inductance.
    const LmWinding = xLm
      ? pushPull && xfmr?.type === 'dual_ct_transformer'
        ? xLm / 4
        : xLm
      : null;
    const dIm = LmWinding ? (Vp * D) / (2 * LmWinding * fsw) : 0;
    const lo = nn * (iout - dIL / 2),
      hi = nn * (iout + dIL / 2);
    const ctSecondary =
      xfmr?.type === 'ct_transformer' || xfmr?.type === 'dual_ct_transformer';
    const sLo = iout - dIL / 2,
      sHi = iout + dIL / 2;

    if (isResonant(m) && !isTransformer(m)) {
      // PSFB series (ZVS) inductor: carries the primary current; reverses it in t_c = Lr·2·n·Iout/Vin.
      const Lr = m.inductance;
      if (!Lr) return null;
      const ipk = hi + dIm / 2;
      const tc = Math.min(0.2, (Lr * 2 * ipk * fsw) / vin);
      const fn = pwl([
        { len: tc, v: vin, i0: -ipk, i1: ipk },
        { len: 0.5 - tc, v: 0, i0: ipk, i1: ipk },
        { len: tc, v: -vin, i0: ipk, i1: -ipk },
        { len: 0.5 - tc, v: 0, i0: -ipk, i1: -ipk },
      ]);
      return finish({
        kind: 'resonant',
        fsw,
        inductance: Lr,
        turnsRatio: null,
        waves: buildWaves(
          fsw,
          [fn],
          'idealised PSFB series-inductor current',
          false,
        ),
        basis: `${label} ZVS series inductor · carries the primary current${caseLabel(vin)}`,
        rows: [
          row('Vin', fV(vin), op.sources.vin),
          row('Vout', fV(vo), op.sources.vout),
          row('Pout', fW(op.pout), op.sources.pout),
          row('Primary current n·Iout + ΔIm/2', fA(ipk)),
          row('Commutation time', `${sig((tc / fsw) * 1e9)} ns`, 'Lr·2·Ip/Vin'),
        ],
      });
    }
    if (!isTransformer(m)) return null;

    let fn: PeriodFn;
    const h = D / 2,
      fw = (1 - D) / 2;
    if (pushPull) {
      fn = pwl([
        { len: h, v: Vp, i0: lo - dIm / 2, i1: hi + dIm / 2, s0: sLo, s1: sHi },
        { len: fw, v: 0, i0: 0, i1: 0, s0: sHi / 2, s1: sLo / 2 },
        { len: h, v: -Vp, i0: 0, i1: 0, s0: 0, s1: 0 },
        { len: fw, v: 0, i0: 0, i1: 0, s0: sHi / 2, s1: sLo / 2 },
      ]);
    } else if (psfb) {
      fn = pwl([
        { len: h, v: Vp, i0: lo - dIm / 2, i1: hi + dIm / 2, s0: sLo, s1: sHi },
        { len: fw, v: 0, i0: hi + dIm / 2, i1: lo + dIm / 2, s0: sHi, s1: sLo },
        {
          len: h,
          v: -Vp,
          i0: -lo + dIm / 2,
          i1: -hi - dIm / 2,
          s0: -sLo,
          s1: -sHi,
        },
        {
          len: fw,
          v: 0,
          i0: -hi - dIm / 2,
          i1: -lo - dIm / 2,
          s0: -sHi,
          s1: -sLo,
        },
      ]);
    } else {
      fn = pwl([
        { len: h, v: Vp, i0: lo - dIm / 2, i1: hi + dIm / 2, s0: sLo, s1: sHi },
        {
          len: fw,
          v: 0,
          i0: dIm / 2,
          i1: dIm / 2,
          s0: ctSecondary ? sHi / 2 : 0,
          s1: ctSecondary ? sLo / 2 : 0,
        },
        {
          len: h,
          v: -Vp,
          i0: -lo + dIm / 2,
          i1: -hi - dIm / 2,
          s0: ctSecondary ? 0 : -sLo,
          s1: ctSecondary ? 0 : -sHi,
        },
        {
          len: fw,
          v: 0,
          i0: -dIm / 2,
          i1: -dIm / 2,
          s0: ctSecondary ? sHi / 2 : 0,
          s1: ctSecondary ? sLo / 2 : 0,
        },
      ]);
    }
    return finish({
      kind: 'transformer',
      fsw,
      inductance: LmWinding,
      turnsRatio: nn,
      waves: buildWaves(
        fsw,
        [fn],
        `idealised ${label.toLowerCase()} transformer currents`,
        true,
      ),
      basis: `${label} transformer · bipolar flux${pushPull ? ' · per primary half' : ''}${ctSecondary ? ' · secondary current per half (centre tap)' : ''}${caseLabel(vin)}`,
      rows: [
        row('Vin', fV(vin), op.sources.vin),
        row('Vout', fV(vo), op.sources.vout),
        row('Pout', fW(op.pout), op.sources.pout),
        row(
          'Primary voltage Vp',
          fV(Vp),
          halfBridge ? 'Vin/2' : pushPull ? 'Vin per half winding' : 'Vin',
        ),
        row('Effective duty Deff = Vout/(n·Vp)', fPct(D)),
        row('Reflected load n·Iout', fA(nn * iout)),
        row('Magnetizing p-p', fA(dIm), 'Vp·Deff/(2·Lm·fsw)'),
        row(
          'Volt-seconds per half cycle',
          `${sig(((Vp * D) / (2 * fsw)) * 1e6)} V·µs`,
        ),
      ],
    });
  }

  // ---------------------------------------------------------------- LLC / CLLC
  if (op.family === 'llc') {
    const xfmr = all.find(isTransformer);
    const nn = xfmr?.turns_ratio && xfmr.turns_ratio > 0 ? xfmr.turns_ratio : 1;
    const Lm = xfmr?.magnetizing_inductance ?? xfmr?.inductance ?? null;
    const halfBridge = /half_bridge/.test(id);
    const vin = op.vinMin;
    const Vp = halfBridge ? vin / 2 : vin;
    let vo = vout;
    if (!vo) {
      vo = nn * Vp;
      assumptions.push(
        `Vout not given: ${fV(vo)} assumed (gain 1 at resonance).`,
      );
    }
    const vReflected = vo / nn;
    const iout = op.pout / vo;
    const ioReflected = nn * iout;
    const imPk = Lm ? vReflected / (4 * Lm * fsw) : 0;
    const ct = xfmr?.type === 'ct_transformer';
    const w = 2 * Math.PI * fsw;
    const iLoad = (x: number) =>
      (Math.PI / 2) * ioReflected * Math.sin(2 * Math.PI * x);
    const iMag = (x: number) =>
      x < 0.5 ? -imPk + 4 * imPk * x : imPk - 4 * imPk * (x - 0.5);
    const dMag = (x: number) => (x < 0.5 ? 4 * imPk * fsw : -4 * imPk * fsw);
    const iSec = (x: number) =>
      (Math.PI / 2) *
      iout *
      (ct ? Math.max(0, Math.sin(2 * Math.PI * x)) : Math.sin(2 * Math.PI * x));
    const rows = [
      row('Vin', fV(vin), op.sources.vin),
      row('Vout', fV(vo), op.sources.vout),
      row('Pout', fW(op.pout), op.sources.pout),
      row('Bridge voltage Vp', fV(Vp), halfBridge ? 'Vin/2' : 'Vin'),
      row('Reflected output Vout/n', fV(vReflected)),
      row(
        'Load current (RMS, pri)',
        fA((Math.PI / (2 * Math.SQRT2)) * ioReflected),
        'π·n·Iout/(2√2)',
      ),
      row('Magnetizing peak', fA(imPk), 'Vout/(4·n·Lm·fsw)'),
    ];
    const basisTail = ' · at resonance (fsw = fr, FHA)';
    if (isTransformer(m)) {
      const fn: PeriodFn = (x) => [
        x < 0.5 ? vReflected : -vReflected,
        iLoad(x) + iMag(x),
        iSec(x),
      ];
      return finish({
        kind: 'transformer',
        fsw,
        inductance: Lm,
        turnsRatio: nn,
        waves: buildWaves(
          fsw,
          [fn],
          'idealised LLC transformer currents at resonance',
          true,
        ),
        basis: `${/cllc/.test(id) ? 'CLLC' : 'LLC'} transformer${ct ? ' · secondary current per half (centre tap)' : ''}${basisTail}`,
        rows,
      });
    }
    const L = m.inductance;
    if (!L) return null;
    const secondarySide =
      /secondary/i.test(String(m.role || '')) || /^ls$/i.test(m.ref);
    if (secondarySide) {
      const fn: PeriodFn = (x) => [
        L * (Math.PI / 2) * iout * w * Math.cos(2 * Math.PI * x),
        (Math.PI / 2) * iout * Math.sin(2 * Math.PI * x),
      ];
      return finish({
        kind: 'resonant',
        fsw,
        inductance: L,
        turnsRatio: null,
        waves: buildWaves(
          fsw,
          [fn],
          'idealised secondary resonant current',
          false,
        ),
        basis: `CLLC secondary resonant inductor${basisTail}`,
        rows,
      });
    }
    const fn: PeriodFn = (x) => [
      L *
        ((Math.PI / 2) * ioReflected * w * Math.cos(2 * Math.PI * x) + dMag(x)),
      iLoad(x) + iMag(x),
    ];
    return finish({
      kind: 'resonant',
      fsw,
      inductance: L,
      turnsRatio: null,
      waves: buildWaves(fsw, [fn], 'idealised resonant-tank current', false),
      basis: `Resonant inductor (carries the primary current)${basisTail}`,
      rows,
    });
  }

  // ---------------------------------------------------------------- DAB
  if (op.family === 'dab') {
    const xfmr = all.find(isTransformer);
    const series =
      all.find((x) => !isTransformer(x) && isResonant(x)) ||
      all.find((x) => !isTransformer(x));
    const nn = xfmr?.turns_ratio && xfmr.turns_ratio > 0 ? xfmr.turns_ratio : 1;
    const Lk = series?.inductance ?? null;
    if (!Lk) return null;
    const vin = op.vinMin;
    let vo = vout;
    if (!vo) {
      vo = nn * vin;
      assumptions.push(`Vout not given: ${fV(vo)} assumed (voltage gain 1).`);
    }
    const v2 = vo / nn;
    const rhs = (2 * Math.PI * Math.PI * fsw * Lk * op.pout) / (vin * v2);
    let phi: number;
    if (rhs > (Math.PI * Math.PI) / 4) {
      phi = Math.PI / 2;
      assumptions.push(
        `${fW(op.pout)} exceeds the single-phase-shift maximum ${fW((vin * v2) / (8 * fsw * Lk))} for this series inductance: φ clamped at 90°.`,
      );
    } else phi = (Math.PI - Math.sqrt(Math.PI * Math.PI - 4 * rhs)) / 2;
    // Square bridges shifted by φ: the series inductor sees Vin ± Vout/n in four
    // intervals; half-wave symmetry i(t + T/2) = −i(t) fixes the initial current.
    const sh = phi / (2 * Math.PI);
    const T = 1 / fsw;
    const i0 = -(((vin + v2) * sh + (vin - v2) * (0.5 - sh)) * T) / (2 * Lk);
    const i1 = i0 + ((vin + v2) * sh * T) / Lk;
    const seg = (
      len: number,
      vl: number,
      vtr: number,
      a0: number,
      a1: number,
    ) => ({ len, vl, vtr, a0, a1 });
    const segs = [
      seg(sh, vin + v2, -v2, i0, i1),
      seg(0.5 - sh, vin - v2, v2, i1, -i0),
      seg(sh, -vin - v2, v2, -i0, -i1),
      seg(0.5 - sh, -vin + v2, -v2, -i1, i0),
    ];
    const inductorFn = pwl(
      segs.map((x) => ({ len: x.len, v: x.vl, i0: x.a0, i1: x.a1 })),
    );
    const transformerFn = pwl(
      segs.map((x) => ({
        len: x.len,
        v: x.vtr,
        i0: x.a0,
        i1: x.a1,
        s0: x.a0 / nn,
        s1: x.a1 / nn,
      })),
    );
    const rows = [
      row('Vin', fV(vin), op.sources.vin),
      row('Vout', fV(vo), op.sources.vout),
      row('Pout', fW(op.pout), op.sources.pout),
      row(
        'Phase shift φ',
        `${sig((phi * 180) / Math.PI)}°`,
        'P = Vin·(Vout/n)·φ(π−φ)/(2π²·fsw·L)',
      ),
      row('Series inductance', fH(Lk), series?.ref),
    ];
    const basis =
      'Dual active bridge · single phase shift, square-wave bridges';
    if (isTransformer(m)) {
      const waves = buildWaves(
        fsw,
        [transformerFn],
        'idealised DAB currents',
        true,
      );
      return finish({
        kind: 'transformer',
        fsw,
        inductance: m.magnetizing_inductance ?? m.inductance ?? null,
        turnsRatio: nn,
        waves,
        basis: `${basis} · transformer`,
        rows,
      });
    }
    if (m.ref !== series?.ref) return null;
    const waves = buildWaves(
      fsw,
      [inductorFn],
      'idealised DAB series-inductor current',
      false,
    );
    return finish({
      kind: 'resonant',
      fsw,
      inductance: Lk,
      turnsRatio: null,
      waves,
      basis: `${basis} · series inductor`,
      rows,
    });
  }

  // ---------------------------------------------------------------- Line-frequency converters
  if (
    (op.family === 'pfc' || op.family === 'afe' || op.family === 'inverter') &&
    !isTransformer(m)
  ) {
    const L = m.inductance;
    if (!L) return null;
    const emi = isEmi(m);
    const threePhase = op.phases === 3;
    let vdc: number, vph: number, iphPk: number, label: string;
    const rows: MagneticInputRow[] = [];
    if (op.family === 'inverter') {
      vdc = op.vinMax;
      let vo = vout;
      const fullBridge = /h_bridge|full_bridge/.test(id);
      if (!vo) {
        const vphPk = 0.85 * (fullBridge ? vdc : vdc / 2);
        vo = threePhase
          ? (vphPk / Math.SQRT2) * Math.sqrt(3)
          : vphPk / Math.SQRT2;
        assumptions.push(
          `Vout not given: ${fV(vo)} RMS assumed (modulation index 0.85).`,
        );
      }
      vph = threePhase ? vo / Math.sqrt(3) : vo;
      iphPk = (Math.SQRT2 * op.pout) / ((threePhase ? 3 : 1) * vph);
      label = `${threePhase ? 'Three-phase' : 'Single-phase'} inverter output inductor`;
      rows.push(
        row('DC link', fV(vdc), op.sources.vin),
        row(
          threePhase ? 'Vout (RMS, line-line)' : 'Vout (RMS)',
          fV(vo),
          op.sources.vout,
        ),
        row('Pout', fW(op.pout), op.sources.pout),
      );
    } else {
      const vin = op.vinMin;
      vph = threePhase ? vin / Math.sqrt(3) : vin;
      let vo = vout;
      if (!vo) {
        vo =
          op.family === 'pfc'
            ? Math.max(400, 1.1 * Math.SQRT2 * vin)
            : 1.15 * Math.SQRT2 * (threePhase ? vin : vin);
        assumptions.push(`DC output voltage not given: ${fV(vo)} assumed.`);
      }
      vdc = vo;
      iphPk = (Math.SQRT2 * pin) / ((threePhase ? 3 : 1) * vph);
      label =
        op.family === 'pfc'
          ? 'PFC boost inductor'
          : `${threePhase ? 'Three-phase' : 'Single-phase'} ${/vienna/.test(id) ? 'Vienna' : 'active front-end'} boost inductor`;
      rows.push(
        row(
          threePhase ? 'Vin (RMS, line-line)' : 'Vin (RMS)',
          fV(vin),
          `${op.sources.vin} · worst case Vin min`,
        ),
        row('Vout (DC)', fV(vo), op.sources.vout),
        row('Pout', fW(op.pout), op.sources.pout),
      );
    }
    const vphPk = Math.SQRT2 * vph;
    const channels =
      op.family === 'pfc'
        ? Math.max(1, inductorsOf((x) => !isEmi(x)).length)
        : 1;
    const iPk = emi ? iphPk : iphPk / channels;
    if (
      vphPk >=
        (op.family === 'pfc'
          ? vdc
          : op.family === 'inverter' && /h_bridge|full_bridge/.test(id)
            ? vdc
            : vdc / 2) &&
      !emi
    ) {
      assumptions.push(
        `Peak line voltage ${fV(vphPk)} is not below the bridge's DC voltage ${fV(vdc)}: the converter cannot regulate at this operating point.`,
      );
    }
    rows.push(
      row('Line frequency', fHz(op.fLine), op.sources.fLine),
      row(
        'Line current peak',
        fA(iphPk),
        op.family === 'inverter'
          ? '√2·Pout/(phases·Vph)'
          : '√2·Pin/(phases·Vph)',
      ),
    );
    if (channels > 1 && !emi)
      rows.push(
        row('Interleaved channels', String(channels), 'current shared equally'),
      );

    const threeLevel = /vienna|neutral_point|npc|t_type/.test(id);
    const hBridge = /h_bridge|single_phase_active_front_end/.test(id);
    const synchronous = op.family !== 'pfc' || /totem/.test(id);
    let peakRipple = 0,
      modeText = 'CCM';
    const periods = lineAngles().map((th) => {
      const e = vphPk * Math.sin(th);
      const i = iPk * Math.sin(th);
      if (emi) {
        // Residual switching ripple on a line-frequency filter choke: 1 % of the line peak assumed.
        const dI = 0.01 * iphPk;
        const vR = 2 * L * dI * fsw;
        return pwl([
          { len: 0.5, v: vR, i0: i - dI / 2, i1: i + dI / 2 },
          { len: 0.5, v: -vR, i0: i + dI / 2, i1: i - dI / 2 },
        ]);
      }
      let vOn: number, vOff: number;
      if (op.family === 'pfc') {
        vOn = e;
        vOff = vdc - e;
      } else if (threeLevel) {
        vOn = vdc / 2 - e;
        vOff = e;
      } else if (hBridge) {
        vOn = vdc - e;
        vOff = vdc + e;
      } else {
        vOn = vdc / 2 - e;
        vOff = vdc / 2 + e;
      }
      const ip = inductorPeriod(vOn, vOff, i, L, fsw, synchronous);
      if (ip.mode === 'DCM') modeText = 'CCM / DCM near the zero crossings';
      peakRipple = Math.max(peakRipple, ip.ripplePP);
      return ip.fn;
    });
    if (emi) {
      rows.push(
        row(
          'Switching ripple (p-p)',
          fA(0.01 * iphPk),
          'assumed 1 % of the line peak',
        ),
      );
      return finish({
        kind,
        fsw,
        inductance: L,
        turnsRatio: null,
        waves: buildWaves(
          fsw,
          periods,
          'idealised line current over a half line cycle',
          false,
        ),
        basis: `EMI / line filter inductor · line current with residual ripple · half line cycle`,
        rows,
      });
    }
    rows.push(
      row(
        'Leg type',
        op.family === 'pfc'
          ? 'boost (V_L on = |v_ac|, off = Vout − |v_ac|)'
          : threeLevel
            ? '3-level (0 ↔ ±Vdc/2)'
            : hBridge
              ? 'H-bridge, bipolar (±Vdc)'
              : '2-level (±Vdc/2)',
      ),
      row('Max ΔI_L (p-p)', fA(peakRipple), 'over the line cycle'),
    );
    return finish({
      kind,
      fsw,
      inductance: L,
      turnsRatio: null,
      waves: buildWaves(
        fsw,
        periods,
        'idealised inductor current over a half line cycle',
        false,
      ),
      basis: `${label}${channels > 1 ? ` (1 of ${channels} interleaved)` : ''} · ${modeText} · half line cycle`,
      rows,
    });
  }

  // ---------------------------------------------------------------- Line-frequency rectifier transformer
  if (op.family === 'rectifier' && isTransformer(m)) {
    const vac = op.vinMin;
    const nn = n ?? 1;
    const f = op.fLine;
    const pf = 0.65;
    const irms = pin / (vac * pf);
    const vpk = vac * Math.SQRT2;
    const fn: PeriodFn = (x) => [
      vpk * Math.sin(2 * Math.PI * x),
      Math.SQRT2 * irms * Math.sin(2 * Math.PI * x),
      (Math.SQRT2 * irms * Math.sin(2 * Math.PI * x)) / nn,
    ];
    assumptions.push(
      'Capacitor-input rectifier current approximated by a sine with power factor 0.65.',
    );
    return finish({
      kind: 'transformer',
      fsw: f,
      inductance: m.magnetizing_inductance ?? m.inductance ?? null,
      turnsRatio: nn,
      waves: buildWaves(
        f,
        [fn],
        'idealised line-frequency transformer waveforms',
        true,
      ),
      basis: 'Line-frequency rectifier transformer',
      rows: [
        row('Vin (RMS)', fV(vac), op.sources.vin),
        row('Pout', fW(op.pout), op.sources.pout),
        row('Primary RMS', fA(irms), 'Pin/(Vac·PF)'),
      ],
    });
  }

  return null;
}

/** Scales an estimate's currents to a measured RMS (plot-trace fallback). */
export function scaleToRms(
  est: PartEstimate,
  measuredRms: number,
  source: string,
): PartEstimate {
  const st = currentStats(est.waves);
  if (!(st.rms > 0) || !(measuredRms > 0)) return est;
  const k = measuredRms / st.rms;
  const waves: MagneticWaveforms = {
    ...est.waves,
    iPri: est.waves.iPri.map((x) => x * k),
    iSec: est.waves.iSec ? est.waves.iSec.map((x) => x * k) : null,
    basis: `${est.waves.basis} scaled to the ${source} RMS`,
  };
  const scaled = currentStats(waves);
  const relabel: Record<string, string> = {
    'I peak': fA(scaled.peak),
    'I RMS': fA(scaled.rms),
    'I avg': fA(scaled.avg),
    'I sec peak': fA(scaled.secPeak),
    'I sec RMS': fA(scaled.secRms),
  };
  return {
    ...est,
    waves,
    inputs: {
      ...est.inputs,
      basis: `${est.inputs.basis} · currents scaled ×${sig(k)} to the simulated RMS`,
      rows: est.inputs.rows.map((r) =>
        relabel[r.label]
          ? { ...r, value: relabel[r.label], note: `${source}` }
          : r,
      ),
    },
  };
}
