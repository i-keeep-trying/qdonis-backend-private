// Ported verbatim from the old frontend; keep numerically identical (see specs).
/**
 * Deterministic magnetics designer used by the Studio's Magnetics stage.
 *
 * Input is one window of the component's steady-state waveforms (winding
 * voltage and currents, whole switching periods) — taken from the raw
 * simulation telemetry, or synthesised from the specs when there is no run.
 *
 * Method (all ferrite, gapped where an inductance is required):
 *   1. Flux from the waveform itself: λ(t) = ∫(v − v̄)dt per switching period,
 *      ΔB = Δλ/(N·Ae). Peak flux for saturation is L·|i|max/(N·Ae) for
 *      energy-storage parts (inductors, flyback, resonant), ΔB/2 for bipolar
 *      transformers and ΔB for unipolar (forward) ones.
 *   2. Core loss with the improved generalised Steinmetz equation (iGSE),
 *      which is exact for the Steinmetz fit at any waveform shape:
 *        Pv = ki·(1/T)∫|dB/dt|^α·ΔB^(β−α) dt,
 *        ki = k / ((2π)^(α−1) · ∫₀^2π|cos θ|^α dθ · 2^(β−α)),
 *      with the manufacturer's (Ferroxcube) temperature-dependent fit.
 *      DC bias is not in the Steinmetz data, so gapped-inductor core loss is
 *      slightly optimistic.
 *   3. Copper loss split into the low-frequency part (DC + line-frequency
 *      envelope, at Rdc) and every switching harmonic at its own Dowell
 *      AC-resistance factor (skin + proximity, layer count from the bobbin
 *      breadth). Litz is treated with Dowell on the strand diameter and an
 *      effective layer count m·√strands.
 *   4. Air gap from the target inductance with McLyman's fringing factor
 *      F = 1 + (lg/√Ae)·ln(2G/lg), solved by fixed-point iteration.
 *   5. Temperature rise from the McLyman surface-area relation
 *      ΔT = 450·(P/At)^0.826, At = Kt·√Ap; losses re-evaluated at the
 *      resulting temperature until it converges.
 *   6. Search: cores in ascending area product (1–3 stacked), a short list of
 *      suitable materials, and the turns count that minimises total loss
 *      (core loss falls as N^−β, copper rises ~N²), subject to saturation,
 *      window fill, layer height, temperature rise and hotspot limits. The
 *      first (smallest) core that meets every limit wins.
 *
 * Everything is explicit so the chat agent can explain each number and the
 * user can override material, flux limit, current density or the core.
 */
import {
  CORE_GEOMETRY_DATA,
  type CoreGeometry,
} from './data/core-geometry.data';
import { MATERIAL_PROPERTIES } from './data/material-properties.data';
import { STEINMETZ_DATA, type SteinmetzDataRow } from './data/steinmetz.data';

const MU0 = 4 * Math.PI * 1e-7;
const RHO_CU_20 = 1.72e-8; // Ω·m
const ALPHA_CU = 0.00393;
const HOTSPOT_LIMIT_C = 120;

export type MagneticKind = 'inductor' | 'flyback' | 'transformer' | 'resonant';

/** Uniformly sampled steady-state window: whole switching periods. */
export interface MagneticWaveforms {
  /** Sample spacing, s. */
  dt: number;
  /** Samples per switching period. */
  spp: number;
  /** Winding (primary) voltage, V. */
  v: number[];
  /** Primary / inductor current, A. */
  iPri: number[];
  /** Secondary current, A (transformers). */
  iSec?: number[] | null;
  source: 'simulation' | 'estimate';
  /** How the window was chosen (e.g. "20 switching periods", "half line cycle"). */
  basis?: string;
}

export interface MagneticRequirement {
  ref: string;
  role?: string | null;
  kind: MagneticKind;
  /** Inductance (inductors) or magnetizing inductance (transformers), H. */
  inductance?: number | null;
  /** Ns / Np (the netlist convention). */
  turnsRatio?: number | null;
  fsw: number;
  waves: MagneticWaveforms;
  /** Transformer driven one way only (forward converter): flux 0 → ΔB. */
  unipolar?: boolean;
  /** The electrical operating point the waveforms were built from (shown with the design). */
  inputs?: MagneticInputs;
}

/** One electrical input of a part's design, e.g. { label: 'Vin (min)', value: '36 V', note: 'specs' }. */
export interface MagneticInputRow {
  label: string;
  value: string;
  note?: string;
}

export interface MagneticInputs {
  /** Operating mode / case the waveforms describe, e.g. "Buck output inductor · CCM · at Vin max". */
  basis: string;
  rows: MagneticInputRow[];
  /** Values that were not given and were assumed. */
  assumptions?: string[];
}

export interface MagneticsSettings {
  material?: string; // e.g. '3C95'; best of a frequency short list when omitted
  maxFluxDensity?: number; // T, absolute peak-flux limit (default 80 % of Bsat at temperature)
  currentDensity?: number; // A/mm² (default 5)
  windowUtilization?: number; // Ku, copper area / window area
  maxTempRiseC?: number; // default 40 °C
  ambientC: number;
  coreOverrides?: Record<string, string>; // ref -> core name
}

export interface MagneticDesign {
  ref: string;
  role?: string | null;
  kind: MagneticKind;
  core: string;
  stacked: number;
  material: string;
  areaProductRequired_mm4: number;
  areaProductCore_mm4: number;
  turnsPrimary: number;
  turnsSecondary?: number;
  /** Ns/Np actually wound vs requested. */
  turnsRatio?: { target: number; actual: number };
  airGap_mm: number;
  fringingFactor?: number;
  inductanceTarget_uH?: number;
  /** Inductance the ungapped core would give with these turns. */
  inductanceUngapped_uH: number;
  bPeak_T: number;
  /** Largest half flux swing ΔB/2 over the window. */
  bAcPeak_T: number;
  bSat_T: number;
  bLimit_T: number;
  wirePrimary: string;
  wireSecondary?: string;
  layersPrimary: number;
  layersSecondary?: number;
  rdcPrimary_mOhm: number;
  rdcSecondary_mOhm?: number;
  /** Effective AC/DC resistance ratio of the switching-frequency current. */
  frPrimary: number;
  frSecondary?: number;
  /** Copper area / window area. */
  fill: number;
  coreLoss_W: number;
  copperLossDc_W: number;
  copperLossAc_W: number;
  copperLoss_W: number;
  totalLoss_W: number;
  tempRise_C: number;
  hotspot_C: number;
  surfaceArea_cm2: number;
  currents: {
    peak: number;
    rms: number;
    dc: number;
    ripplePP: number;
    rmsSecondary?: number;
    peakSecondary?: number;
    source: 'simulation' | 'estimate';
    basis?: string;
  };
  /** Volt-seconds per switching period (max over the window), V·µs. */
  voltSeconds_uVs: number;
  fsw: number;
  inputs?: MagneticInputs;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

interface CoreEntry extends CoreGeometry {
  name: string;
  ap: number; // mm⁴
  windowArea: number; // mm²
  meanLengthPerTurn: number; // mm
  breadth: number; // winding breadth (bobbin width), mm
  kt: number; // McLyman surface-area coefficient
}

/** Pot-like cores (RM, PQ, EP) have short, wide windows; E/EF/ETD long, narrow ones. */
const potLike = (name: string) => /^(RM|PQ|EP|P\d)/i.test(name);

const CORES: CoreEntry[] = Object.entries(CORE_GEOMETRY_DATA)
  .map(([name, g]) => {
    const windowArea = g.windowArea ?? g.effectiveArea * 1.2;
    const meanLengthPerTurn =
      g.meanLengthPerTurn ?? 4 * Math.sqrt(g.effectiveArea) * 1.3;
    // Bobbin breadth/height ≈ 3 for E-type, ≈ 1.6 for pot-like cores.
    const breadth = Math.sqrt((potLike(name) ? 1.6 : 3) * windowArea);
    return {
      ...g,
      name,
      windowArea,
      meanLengthPerTurn,
      breadth,
      kt: potLike(name) ? 33.8 : 41.3,
      ap: g.effectiveArea * windowArea,
    };
  })
  .sort((a, b) => a.ap - b.ap);

export const AVAILABLE_CORES = CORES.map((c) => c.name);
export const AVAILABLE_MATERIALS = Array.from(
  new Set(STEINMETZ_DATA.map((r) => r.material)),
);

function materialShortList(fsw: number): string[] {
  const list =
    fsw > 400e3
      ? ['3F36', '4F1']
      : fsw > 150e3
        ? ['3C95', '3C98', '3F36']
        : ['3C95', '3C97', '3C90', '3C94'];
  const found = list.filter((m) => AVAILABLE_MATERIALS.includes(m));
  return found.length ? found : [AVAILABLE_MATERIALS[0] || '3C90'];
}

export function defaultMaterial(fsw: number): string {
  return materialShortList(fsw)[0];
}

function steinmetzRow(material: string, f: number): SteinmetzDataRow | null {
  const rows = STEINMETZ_DATA.filter((r) => r.material === material);
  if (!rows.length) return null;
  return (
    rows.find((r) => f >= r.frequencyMin && f <= r.frequencyMax) ||
    rows.reduce((best, r) =>
      Math.abs((r.frequencyMin + r.frequencyMax) / 2 - f) <
      Math.abs((best.frequencyMin + best.frequencyMax) / 2 - f)
        ? r
        : best,
    )
  );
}

/** Steinmetz k with the temperature polynomial applied (Pv in mW/cm³ for f in Hz, B in T). */
function steinmetzK(row: SteinmetzDataRow, tempC: number): number {
  return (
    row.cm *
    Math.max(
      0.0002,
      (row.ct - row.ct1 * tempC + row.ct2 * tempC * tempC) / 1000,
    )
  );
}

/** ∫₀^2π |cos θ|^α dθ (numerical, cached). */
const cosIntegralCache = new Map<number, number>();
function cosIntegral(alpha: number): number {
  const key = Math.round(alpha * 1e4);
  const hit = cosIntegralCache.get(key);
  if (hit !== undefined) return hit;
  const n = 4000;
  let sum = 0;
  for (let k = 0; k < n; k++)
    sum += Math.pow(Math.abs(Math.cos(((k + 0.5) / n) * 2 * Math.PI)), alpha);
  const value = (sum / n) * 2 * Math.PI;
  cosIntegralCache.set(key, value);
  return value;
}

function bSat(material: string, tempC: number): number {
  const b25 = MATERIAL_PROPERTIES[material]?.saturationB ?? 0.45;
  // Mn-Zn ferrite saturation falls ≈ 20–25 % between 25 °C and 100 °C.
  return b25 * (1 - 0.003 * Math.max(0, tempC - 25));
}

function permeability(material: string): number {
  return MATERIAL_PROPERTIES[material]?.initialPermeability ?? 2000;
}

const awgDiameter = (awg: number) => 0.127 * Math.pow(92, (36 - awg) / 39); // mm
const awgArea = (awg: number) => Math.PI * Math.pow(awgDiameter(awg) / 2, 2); // mm²
/** Grade-2 enamel build. */
const insulated = (d: number) => d * 1.07 + 0.02;

function skinDepth(f: number, tempC: number): number {
  const rho = RHO_CU_20 * (1 + ALPHA_CU * (tempC - 20));
  return Math.sqrt(rho / (Math.PI * f * MU0)) * 1e3; // mm
}

/**
 * Dowell's AC-resistance factor for m layers of round wire (diameter d) at
 * skin depth δ, with the round → square-foil equivalence and layer porosity η.
 */
function dowell(d: number, delta: number, m: number, eta: number): number {
  const x = Math.max(
    1e-3,
    Math.pow(Math.PI / 4, 0.75) * (d / delta) * Math.sqrt(eta),
  );
  const p = (2 * (m * m - 1)) / 3;
  if (x > 15) return x * (1 + p);
  const skin =
    (Math.sinh(2 * x) + Math.sin(2 * x)) / (Math.cosh(2 * x) - Math.cos(2 * x));
  const prox = (Math.sinh(x) - Math.sin(x)) / (Math.cosh(x) + Math.cos(x));
  return Math.max(1, x * (skin + p * prox));
}

// ---------------------------------------------------------------------------
// Waveform analysis (done once per part)
// ---------------------------------------------------------------------------

interface CurrentSpectrum {
  rms: number;
  dc: number;
  peak: number;
  pp: number;
  /** Mean square of the low-frequency part (DC + line envelope), A². */
  lfMs: number;
  /** Mean-square current per switching harmonic h = 1..H, A². */
  harmonics: number[];
}

interface WaveAnalysis {
  periods: number;
  spp: number;
  T: number;
  /** v with each period's mean removed (resistive drop / slow envelope). */
  vAc: Float64Array;
  /** Flux-linkage swing Δλ of every period, V·s. */
  dLambda: number[];
  dLambdaMax: number;
  pri: CurrentSpectrum;
  sec: CurrentSpectrum | null;
  igseCache: Map<string, number>;
}

function spectrum(i: number[], spp: number, periods: number): CurrentSpectrum {
  const n = periods * spp;
  const H = Math.max(1, Math.min(25, Math.floor(spp / 2) - 1));
  const harmonics = new Array<number>(H).fill(0);
  let sum = 0,
    sq = 0,
    peak = 0,
    max = -Infinity,
    min = Infinity,
    lfMs = 0,
    hfMs = 0;
  const cos: number[][] = [],
    sin: number[][] = [];
  for (let h = 1; h <= H; h++) {
    cos.push(
      Array.from({ length: spp }, (_, k) =>
        Math.cos((2 * Math.PI * h * k) / spp),
      ),
    );
    sin.push(
      Array.from({ length: spp }, (_, k) =>
        Math.sin((2 * Math.PI * h * k) / spp),
      ),
    );
  }
  for (let p = 0; p < periods; p++) {
    const off = p * spp;
    let mean = 0;
    for (let k = 0; k < spp; k++) {
      const x = i[off + k];
      mean += x;
      sq += x * x;
      peak = Math.max(peak, Math.abs(x));
      max = Math.max(max, x);
      min = Math.min(min, x);
    }
    mean /= spp;
    sum += mean * spp;
    lfMs += mean * mean;
    let periodHf = 0;
    for (let k = 0; k < spp; k++) periodHf += (i[off + k] - mean) ** 2;
    hfMs += periodHf / spp;
    for (let h = 0; h < H; h++) {
      let re = 0,
        im = 0;
      for (let k = 0; k < spp; k++) {
        const x = i[off + k] - mean;
        re += x * cos[h][k];
        im -= x * sin[h][k];
      }
      // RMS² of harmonic h: (2|X|/N)² / 2
      harmonics[h] += (2 * (re * re + im * im)) / (spp * spp);
    }
  }
  for (let h = 0; h < H; h++) harmonics[h] /= periods;
  lfMs /= periods;
  hfMs /= periods;
  // Energy above the highest resolved harmonic is booked at that harmonic.
  const resolved = harmonics.reduce((a, b) => a + b, 0);
  if (hfMs > resolved) harmonics[H - 1] += hfMs - resolved;
  return {
    rms: Math.sqrt(sq / n),
    dc: sum / n,
    peak,
    pp: max - min,
    lfMs,
    harmonics,
  };
}

function analyzeWaves(w: MagneticWaveforms, fsw: number): WaveAnalysis {
  const spp = Math.max(8, Math.round(w.spp || w.v.length));
  const periods = Math.max(
    1,
    Math.floor(Math.min(w.v.length, w.iPri.length) / spp),
  );
  const vAc = new Float64Array(periods * spp);
  const dLambda: number[] = [];
  for (let p = 0; p < periods; p++) {
    const off = p * spp;
    let mean = 0;
    for (let k = 0; k < spp; k++) mean += w.v[off + k];
    mean /= spp;
    let lambda = 0,
      lo = 0,
      hi = 0;
    for (let k = 0; k < spp; k++) {
      const x = w.v[off + k] - mean;
      vAc[off + k] = x;
      lambda += x * w.dt;
      lo = Math.min(lo, lambda);
      hi = Math.max(hi, lambda);
    }
    dLambda.push(hi - lo);
  }
  return {
    periods,
    spp,
    // The slicing period itself (equals 1/fsw for simulation windows).
    T: spp * w.dt || 1 / fsw,
    vAc,
    dLambda,
    dLambdaMax: Math.max(...dLambda),
    pri: spectrum(w.iPri, spp, periods),
    sec:
      w.iSec && w.iSec.length >= periods * spp
        ? spectrum(w.iSec, spp, periods)
        : null,
    igseCache: new Map(),
  };
}

/**
 * Core-loss density by iGSE for N turns on area Ae (m²), mW/cm³.
 * Pv = ki/(N·Ae)^β · mean over periods of [Δλ^(β−α) · (1/T)∫|v|^α dt].
 */
function igseDensity(
  a: WaveAnalysis,
  row: SteinmetzDataRow,
  tempC: number,
  N: number,
  Ae: number,
  dt: number,
): number {
  const alpha = row.x,
    beta = row.y;
  const ki =
    steinmetzK(row, tempC) /
    (Math.pow(2 * Math.PI, alpha - 1) *
      cosIntegral(alpha) *
      Math.pow(2, beta - alpha));
  // dB/dt = v/(N·Ae) and ΔB = Δλ/(N·Ae), so N·Ae factors out as (N·Ae)^−β:
  // the waveform sum S(α, β) is computed once per Steinmetz fit.
  const key = `${alpha}|${beta}`;
  let S = a.igseCache.get(key);
  if (S === undefined) {
    let acc = 0;
    for (let p = 0; p < a.periods; p++) {
      const off = p * a.spp;
      let integral = 0;
      for (let k = 0; k < a.spp; k++)
        integral += Math.pow(Math.abs(a.vAc[off + k]), alpha);
      integral *= dt / a.T;
      acc += Math.pow(a.dLambda[p], beta - alpha) * integral;
    }
    S = acc / a.periods;
    a.igseCache.set(key, S);
  }
  return ki * S * Math.pow(N * Ae, -beta);
}

// ---------------------------------------------------------------------------
// Windings
// ---------------------------------------------------------------------------

interface Winding {
  label: string;
  copperArea: number; // mm²
  footprint: number; // window area taken per turn, mm²
  outerDia: number; // mm (wire or bundle)
  stripDia: number; // conductor diameter Dowell sees, mm
  layerFactor: number; // layers seen by Dowell per physical layer
  eta: number; // porosity
}

function windingOptions(
  iRms: number,
  J: number,
  f: number,
  tempC: number,
): Winding[] {
  const required = Math.max(iRms / J, 0.02);
  const delta = skinDepth(f, tempC);
  const options: Winding[] = [];
  for (let awg = 44; awg >= 8; awg--) {
    if (awgArea(awg) >= required) {
      const d = awgDiameter(awg);
      const od = insulated(d);
      options.push({
        label: `AWG ${awg} solid`,
        copperArea: awgArea(awg),
        footprint: od * od,
        outerDia: od,
        stripDia: d,
        layerFactor: 1,
        eta: d / od,
      });
      break;
    }
  }
  // Litz: thickest strand with d ≤ δ, and a finer one (d ≤ δ/2) for proximity-dominated windings.
  for (const limit of [delta, delta / 2]) {
    let strandAwg = 46;
    for (let awg = 28; awg <= 46; awg++) {
      if (awgDiameter(awg) <= limit) {
        strandAwg = awg;
        break;
      }
    }
    const strands = Math.max(3, Math.ceil(required / awgArea(strandAwg)));
    const copper = strands * awgArea(strandAwg);
    const bundle = Math.sqrt((4 * copper) / (Math.PI * 0.55)) + 0.05; // ~55 % copper in the bundle + serving
    if (options.some((o) => o.label === `Litz ${strands}×AWG ${strandAwg}`))
      continue;
    options.push({
      label: `Litz ${strands}×AWG ${strandAwg}`,
      copperArea: copper,
      footprint: bundle * bundle,
      outerDia: bundle,
      stripDia: awgDiameter(strandAwg),
      layerFactor: Math.sqrt(strands),
      eta: 0.55,
    });
  }
  return options;
}

interface WindingResult {
  wire: Winding;
  layers: number;
  rdc: number;
  fr: number;
  pDc: number;
  pAc: number;
}

function windingLoss(
  spec: CurrentSpectrum,
  turns: number,
  wire: Winding,
  mlt: number,
  breadth: number,
  fsw: number,
  tempC: number,
): WindingResult {
  const perLayer = Math.max(1, Math.floor(breadth / wire.outerDia));
  const layers = Math.ceil(turns / perLayer);
  const rho = RHO_CU_20 * (1 + ALPHA_CU * (tempC - 20));
  const rdc = (rho * turns * mlt) / (wire.copperArea * 1e-6);
  const delta = skinDepth(fsw, tempC);
  const m = layers * wire.layerFactor;
  let hfMs = 0,
    pAc = 0;
  spec.harmonics.forEach((ms, idx) => {
    if (ms <= 0) return;
    hfMs += ms;
    pAc +=
      ms * rdc * dowell(wire.stripDia, delta / Math.sqrt(idx + 1), m, wire.eta);
  });
  return {
    wire,
    layers,
    rdc,
    fr: hfMs > 0 ? pAc / (hfMs * rdc) : 1,
    pDc: spec.lfMs * rdc,
    pAc,
  };
}

function bestWinding(
  spec: CurrentSpectrum,
  turns: number,
  J: number,
  mlt: number,
  breadth: number,
  fsw: number,
  tempC: number,
): WindingResult {
  const results = windingOptions(spec.rms, J, fsw, tempC).map((w) =>
    windingLoss(spec, turns, w, mlt, breadth, fsw, tempC),
  );
  // Prefer lower loss; litz only when it saves more than 10 % (cost / fill).
  results.sort((a, b) => a.pDc + a.pAc - (b.pDc + b.pAc));
  const solid = results.find((r) => r.wire.label.includes('solid'));
  if (
    solid &&
    results[0] !== solid &&
    solid.pDc + solid.pAc < 1.1 * (results[0].pDc + results[0].pAc)
  )
    return solid;
  return results[0];
}

// ---------------------------------------------------------------------------
// Designer
// ---------------------------------------------------------------------------

interface Candidate {
  core: CoreEntry;
  stacked: number;
  material: string;
  N: number;
  Ns?: number;
  gap: number;
  fringing?: number;
  lUngapped: number;
  bPeak: number;
  bAc: number;
  bsat: number;
  bLimit: number;
  pri: WindingResult;
  sec?: WindingResult;
  fill: number;
  height: number;
  pCore: number;
  tempRise: number;
  hotspot: number;
  surface: number;
  feasible: boolean;
  reasons: string[];
}

function evaluate(
  req: MagneticRequirement,
  a: WaveAnalysis,
  settings: MagneticsSettings,
  core: CoreEntry,
  stacked: number,
  material: string,
  N: number,
): Candidate | null {
  const f = req.fsw;
  const J = settings.currentDensity ?? 5;
  const Ku =
    settings.windowUtilization ??
    (req.kind === 'transformer' || req.kind === 'flyback' ? 0.3 : 0.4);
  const n = req.turnsRatio && req.turnsRatio > 0 ? req.turnsRatio : 1;
  const hasSecondary = req.kind === 'transformer' || req.kind === 'flyback';
  const Ns = hasSecondary ? Math.max(1, Math.round(N * n)) : undefined;

  const Ae = core.effectiveArea * stacked * 1e-6; // m²
  const le = core.effectiveLength * 1e-3; // m
  const Ve = core.effectiveVolume * stacked * 1e-3; // cm³
  const mlt =
    core.meanLengthPerTurn *
    (stacked > 1 ? 1 + 0.35 * (stacked - 1) : 1) *
    1e-3; // m
  const mu = permeability(material);
  const row = steinmetzRow(material, f);
  if (!row) return null;

  const lUngapped = (MU0 * mu * N * N * Ae) / le;
  const L = req.inductance && req.inductance > 0 ? req.inductance : null;
  const storesEnergy = req.kind !== 'transformer';
  const reasons: string[] = [];

  // Air gap with fringing (McLyman): L = μ0·N²·Ae·F / (lg + le/μr).
  let gap = 0;
  let fringing: number | undefined;
  if (L && L < lUngapped * 0.97) {
    const G = core.breadth * 1e-3;
    gap = Math.max(1e-6, (MU0 * N * N * Ae) / L - le / mu);
    for (let k = 0; k < 30; k++) {
      fringing = 1 + (gap / Math.sqrt(Ae)) * Math.log((2 * G) / gap);
      gap = Math.max(1e-6, (MU0 * N * N * Ae * fringing) / L - le / mu);
    }
  } else if (L && storesEnergy && L > lUngapped * 1.03) {
    reasons.push('turns too low for the inductance even without a gap');
  }

  const bAc = a.dLambdaMax / (2 * N * Ae);
  const bPeak =
    storesEnergy && L
      ? (L * a.pri.peak) / (N * Ae)
      : req.unipolar
        ? 2 * bAc
        : bAc;

  const pri0 = bestWinding(
    a.pri,
    N,
    J,
    mlt,
    core.breadth,
    f,
    settings.ambientC + 40,
  );
  const sec0 =
    Ns && a.sec
      ? bestWinding(a.sec, Ns, J, mlt, core.breadth, f, settings.ambientC + 40)
      : undefined;
  const window = core.windowArea; // stacking lengthens the core, not the window
  const fill =
    (N * pri0.wire.copperArea + (Ns && sec0 ? Ns * sec0.wire.copperArea : 0)) /
    window;
  const height =
    pri0.layers * pri0.wire.outerDia +
    (sec0 ? sec0.layers * sec0.wire.outerDia + 0.1 : 0);
  if (fill > Ku)
    reasons.push(
      `copper fill ${(fill * 100).toFixed(0)} % > Ku ${(Ku * 100).toFixed(0)} %`,
    );
  if (height > window / core.breadth)
    reasons.push('winding layers taller than the window');

  // Losses at temperature, iterated to convergence.
  const apCm4 = (core.ap * stacked) / 1e4;
  const surface = core.kt * Math.sqrt(apCm4); // cm²
  let temp = settings.ambientC + 40;
  let pri = pri0,
    sec = sec0,
    pCore = 0,
    rise = 0;
  for (let it = 0; it < 6; it++) {
    pCore = (igseDensity(a, row, temp, N, Ae, req.waves.dt) * Ve) / 1000;
    pri = windingLoss(a.pri, N, pri0.wire, mlt, core.breadth, f, temp);
    sec =
      Ns && a.sec && sec0
        ? windingLoss(a.sec, Ns, sec0.wire, mlt, core.breadth, f, temp)
        : undefined;
    const total = pCore + pri.pDc + pri.pAc + (sec ? sec.pDc + sec.pAc : 0);
    rise = 450 * Math.pow(Math.max(total, 1e-9) / surface, 0.826);
    const next = settings.ambientC + rise;
    if (Math.abs(next - temp) < 0.5) {
      temp = next;
      break;
    }
    temp = next;
  }

  const bsat = bSat(material, temp);
  const bLimit = settings.maxFluxDensity ?? 0.8 * bsat;
  if (bPeak > bLimit)
    reasons.push(
      `peak flux ${bPeak.toFixed(3)} T > ${bLimit.toFixed(2)} T limit`,
    );
  const maxRise = settings.maxTempRiseC ?? 40;
  if (rise > maxRise)
    reasons.push(`temperature rise ${rise.toFixed(0)} °C > ${maxRise} °C`);
  if (temp > HOTSPOT_LIMIT_C)
    reasons.push(`hotspot ${temp.toFixed(0)} °C > ${HOTSPOT_LIMIT_C} °C`);
  if (Ns && n > 0 && Math.abs(Ns / N - n) / n > 0.05)
    reasons.push('turns ratio off by more than 5 %');

  return {
    core,
    stacked,
    material,
    N,
    Ns,
    gap,
    fringing,
    lUngapped,
    bPeak,
    bAc,
    bsat,
    bLimit,
    pri,
    sec,
    fill,
    height,
    pCore,
    tempRise: rise,
    hotspot: temp,
    surface,
    feasible: reasons.length === 0,
    reasons,
  };
}

const lossOf = (c: Candidate) =>
  c.pCore + c.pri.pDc + c.pri.pAc + (c.sec ? c.sec.pDc + c.sec.pAc : 0);

/** Loss-optimal turns on one core / material (loss is convex in N). */
function bestOnCore(
  req: MagneticRequirement,
  a: WaveAnalysis,
  settings: MagneticsSettings,
  core: CoreEntry,
  stacked: number,
  material: string,
): Candidate | null {
  const Ae = core.effectiveArea * stacked * 1e-6;
  const L = req.inductance && req.inductance > 0 ? req.inductance : null;
  const bsatHot = bSat(material, 100);
  const bLimit = settings.maxFluxDensity ?? 0.8 * bsatHot;
  // Lower bound on N from saturation.
  let nMin = 1;
  if (req.kind !== 'transformer' && L)
    nMin = Math.ceil((L * a.pri.peak) / (bLimit * Ae));
  else nMin = Math.ceil(a.dLambdaMax / ((req.unipolar ? 1 : 2) * bLimit * Ae));
  if (L && req.kind !== 'transformer') {
    // The ungapped core must be able to reach L.
    const le = core.effectiveLength * 1e-3;
    nMin = Math.max(
      nMin,
      Math.ceil(Math.sqrt((L * le) / (MU0 * permeability(material) * Ae))),
    );
  }
  nMin = Math.max(
    nMin,
    req.kind === 'transformer' || req.kind === 'flyback' ? 2 : 1,
  );

  let best: Candidate | null = null;
  let bestFeasible: Candidate | null = null;
  let worse = 0;
  for (let N = nMin; N <= Math.min(nMin * 6 + 10, 600); N++) {
    const c = evaluate(req, a, settings, core, stacked, material, N);
    if (!c) return null;
    // Past the window limit fill only gets worse with more turns (keep the first
    // over-full candidate so an impossible part still gets a "closest" design).
    if (c.fill > 1.5 * (settings.windowUtilization ?? 0.4) && best) break;
    if (!best || lossOf(c) < lossOf(best)) {
      best = c;
      worse = 0;
    } else worse++;
    if (c.fill > 1.5 * (settings.windowUtilization ?? 0.4)) break;
    if (c.feasible && (!bestFeasible || lossOf(c) < lossOf(bestFeasible)))
      bestFeasible = c;
    if (worse >= 4 && bestFeasible) break;
  }
  return bestFeasible || best;
}

export function designMagnetic(
  req: MagneticRequirement,
  settings: MagneticsSettings,
): MagneticDesign {
  const warnings: string[] = [];
  const f = Math.max(req.fsw || 100e3, 1e3);
  req = { ...req, fsw: f };
  const a = analyzeWaves(req.waves, f);
  if ((req.kind === 'transformer' || req.kind === 'flyback') && !a.sec) {
    // No secondary probe: ideal-transformer current Ipri·Np/Ns.
    const k = 1 / (req.turnsRatio && req.turnsRatio > 0 ? req.turnsRatio : 1);
    const p = a.pri;
    a.sec = {
      rms: p.rms * k,
      dc: p.dc * k,
      peak: p.peak * k,
      pp: p.pp * k,
      lfMs: p.lfMs * k * k,
      harmonics: p.harmonics.map((h) => h * k * k),
    };
    warnings.push(
      req.kind === 'flyback'
        ? 'No secondary current in the simulation: secondary copper loss uses Ipri·Np/Ns, which is only approximate for a flyback (the windings conduct in turn).'
        : 'No secondary current in the simulation: secondary current taken as Ipri·Np/Ns (ideal transformer).',
    );
  }
  const materials =
    settings.material && AVAILABLE_MATERIALS.includes(settings.material)
      ? [settings.material]
      : materialShortList(f);
  if (settings.material && !AVAILABLE_MATERIALS.includes(settings.material))
    warnings.push(
      `Material ${settings.material} has no loss data; chose from ${materials.join(', ')} instead.`,
    );

  // Area product (McLyman) — reported for reference and used to start the search.
  const J = (settings.currentDensity ?? 5) * 1e6;
  const Ku =
    settings.windowUtilization ??
    (req.kind === 'transformer' || req.kind === 'flyback' ? 0.3 : 0.4);
  const L = req.inductance && req.inductance > 0 ? req.inductance : null;
  const bRef = Math.min(0.25, 0.8 * bSat(materials[0], 100));
  const secRms = a.sec?.rms ?? 0;
  const n = req.turnsRatio && req.turnsRatio > 0 ? req.turnsRatio : 1;
  // Ae from the flux limit, Aw from the ampere-turns at J and Ku:
  //   energy storage: Ae = L·Ipk/(N·B),  Aw = N·(Ipri + n·Isec)/(Ku·J)
  //   transformer:    Ae = Δλ/(2·N·B),   same Aw  → N cancels in Ap = Ae·Aw.
  const apReq =
    (req.kind !== 'transformer' && L
      ? (L * a.pri.peak * (a.pri.rms + n * secRms)) / (bRef * J * Ku)
      : (a.dLambdaMax * (a.pri.rms + n * secRms)) /
        (2 * Ku * Math.min(bRef, 0.1) * J)) * 1e12;

  const forced = settings.coreOverrides?.[req.ref];
  let pool: Array<{ core: CoreEntry; stacked: number }> = [];
  if (forced) {
    const core = CORES.find((c) => c.name === forced);
    if (core) pool = [1, 2, 3].map((s) => ({ core, stacked: s }));
    else
      warnings.push(
        `Core ${forced} is not in the library; picked automatically instead.`,
      );
  }
  if (!pool.length) {
    pool = [1, 2, 3]
      .flatMap((s) => CORES.map((core) => ({ core, stacked: s })))
      .filter((p) => p.core.ap * p.stacked >= 0.2 * apReq)
      .sort((x, y) => x.core.ap * x.stacked - y.core.ap * y.stacked);
    if (!pool.length)
      pool = CORES.slice(-3).map((core) => ({ core, stacked: 3 }));
  }

  let chosen: Candidate | null = null;
  let fallback: Candidate | null = null;
  for (const option of pool) {
    let bestHere: Candidate | null = null;
    for (const material of materials) {
      const c = bestOnCore(
        req,
        a,
        settings,
        option.core,
        option.stacked,
        material,
      );
      if (!c) continue;
      if (
        !bestHere ||
        (c.feasible && !bestHere.feasible) ||
        (c.feasible === bestHere.feasible && lossOf(c) < lossOf(bestHere))
      )
        bestHere = c;
    }
    if (!bestHere) continue;
    if (bestHere.feasible) {
      chosen = bestHere;
      break;
    }
    if (
      !fallback ||
      bestHere.reasons.length < fallback.reasons.length ||
      (bestHere.reasons.length === fallback.reasons.length &&
        bestHere.hotspot < fallback.hotspot)
    )
      fallback = bestHere;
  }
  const largest = CORES[CORES.length - 1];
  if (!forced && apReq > largest.ap * 3) {
    warnings.push(
      `Needs Ae·Aw ≈ ${(apReq / 1e4).toFixed(0)} cm⁴, more than three stacked ${largest.name} (${((largest.ap * 3) / 1e4).toFixed(0)} cm⁴) — beyond the ferrite library. Use a powder (Sendust / High Flux) or amorphous / nanocrystalline core, split the inductance, or lower it (e.g. higher switching frequency).`,
    );
  }
  const c = chosen || fallback;
  if (!c)
    throw new Error(`No core in the library can be evaluated for ${req.ref}.`);
  if (!chosen)
    warnings.push(
      `No library core meets every limit (${c.reasons.join('; ')}). Showing the closest design — consider a larger core family, a powder / nanocrystalline core, forced cooling or splitting the part.`,
    );
  if (c.stacked > 1)
    warnings.push(
      `${c.stacked} × ${c.core.name} stacked to reach the required area product.`,
    );

  const Ae = c.core.effectiveArea * c.stacked * 1e-6;
  if (c.gap * 1000 > 0.2 * Math.sqrt(Ae) * 1000 && c.gap > 2e-3)
    warnings.push(
      `Large air gap (${(c.gap * 1000).toFixed(2)} mm): fringing flux will add eddy loss in nearby turns — keep windings away from the gap, split it across legs or use a distributed-gap powder core.`,
    );
  if (c.fill > Ku)
    warnings.push(
      `Copper fill ${(c.fill * 100).toFixed(0)} % exceeds Ku ${(Ku * 100).toFixed(0)} %; hard to wind with insulation and creepage margins.`,
    );
  if (L && req.kind === 'transformer' && L > c.lUngapped * 1.03)
    warnings.push(
      `Ungapped magnetizing inductance is ${(c.lUngapped * 1e6).toFixed(0)} µH, below the ${(L * 1e6).toFixed(0)} µH in the circuit — magnetizing current will be higher than simulated.`,
    );
  const acHeavy = (w: WindingResult | undefined, name: string) => {
    if (w && w.fr > 2 && w.pAc > 0.5 * w.pDc && w.pAc > 0.1 * lossOf(c)) {
      warnings.push(
        `${name} AC copper loss is ${w.pAc.toFixed(2)} W (Rac/Rdc ≈ ${w.fr.toFixed(1)} on the switching ripple): interleave primary and secondary, use fewer layers or finer litz.`,
      );
    }
  };
  acHeavy(
    c.pri,
    req.kind === 'inductor' || req.kind === 'resonant' ? 'Winding' : 'Primary',
  );
  acHeavy(c.sec, 'Secondary');
  if (req.kind === 'flyback')
    warnings.push(
      "Flyback windings do not conduct at the same time, so Dowell's proximity term (which assumes opposing MMFs) is approximate.",
    );
  if (req.kind !== 'transformer' && L)
    warnings.push(
      'Core loss excludes the DC-bias effect (not in the Steinmetz data); expect it somewhat higher in heavily biased inductors.',
    );
  if (req.waves.source === 'estimate')
    warnings.push(
      'Waveforms synthesised from the specs — run the simulation for waveform-accurate flux and currents.',
    );

  const pCu = c.pri.pDc + c.pri.pAc + (c.sec ? c.sec.pDc + c.sec.pAc : 0);
  const total = c.pCore + pCu;
  return {
    ref: req.ref,
    role: req.role,
    kind: req.kind,
    core: c.core.name,
    stacked: c.stacked,
    material: c.material,
    areaProductRequired_mm4: apReq,
    areaProductCore_mm4: c.core.ap * c.stacked,
    turnsPrimary: c.N,
    turnsSecondary: c.Ns,
    turnsRatio:
      c.Ns && req.turnsRatio
        ? { target: req.turnsRatio, actual: c.Ns / c.N }
        : undefined,
    airGap_mm: c.gap * 1000,
    fringingFactor: c.fringing,
    inductanceTarget_uH: L ? L * 1e6 : undefined,
    inductanceUngapped_uH: c.lUngapped * 1e6,
    bPeak_T: c.bPeak,
    bAcPeak_T: c.bAc,
    bSat_T: c.bsat,
    bLimit_T: c.bLimit,
    wirePrimary: c.pri.wire.label,
    wireSecondary: c.sec?.wire.label,
    layersPrimary: c.pri.layers,
    layersSecondary: c.sec?.layers,
    rdcPrimary_mOhm: c.pri.rdc * 1e3,
    rdcSecondary_mOhm: c.sec ? c.sec.rdc * 1e3 : undefined,
    frPrimary: c.pri.fr,
    frSecondary: c.sec?.fr,
    fill: c.fill,
    coreLoss_W: c.pCore,
    copperLossDc_W: c.pri.pDc + (c.sec?.pDc ?? 0),
    copperLossAc_W: c.pri.pAc + (c.sec?.pAc ?? 0),
    copperLoss_W: pCu,
    totalLoss_W: total,
    tempRise_C: c.tempRise,
    hotspot_C: c.hotspot,
    surfaceArea_cm2: c.surface,
    currents: {
      peak: a.pri.peak,
      rms: a.pri.rms,
      dc: a.pri.dc,
      ripplePP: a.pri.pp,
      rmsSecondary: a.sec?.rms,
      peakSecondary: a.sec?.peak,
      source: req.waves.source,
      basis: req.waves.basis,
    },
    voltSeconds_uVs: a.dLambdaMax * 1e6,
    fsw: f,
    ...(req.inputs ? { inputs: req.inputs } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Synthetic waveforms (no simulation yet)
// ---------------------------------------------------------------------------

export interface WaveEstimate {
  kind: MagneticKind;
  fsw: number;
  inductance?: number | null;
  turnsRatio?: number | null;
  /** Duty of the energising interval (0..1). */
  duty: number;
  /** Inductor: DC current and peak-to-peak ripple. */
  iDc?: number;
  iRipplePP?: number;
  /** Flyback: primary peak current; transformer / resonant: RMS current. */
  iPeak?: number;
  iRms?: number;
  /** Transformer: primary voltage amplitude. Flyback: input voltage. */
  vPrimary?: number;
}

/** One switching period of idealised waveforms for the given converter type. */
export function synthesizeWaveforms(e: WaveEstimate): MagneticWaveforms {
  const spp = 128;
  const T = 1 / e.fsw;
  const dt = T / spp;
  const D = Math.min(0.9, Math.max(0.1, e.duty));
  const n = e.turnsRatio && e.turnsRatio > 0 ? e.turnsRatio : 1;
  const v: number[] = [],
    iPri: number[] = [],
    iSec: number[] = [];
  for (let k = 0; k < spp; k++) {
    const x = (k + 0.5) / spp;
    if (e.kind === 'inductor') {
      const L = e.inductance || 10e-6;
      const dI = e.iRipplePP ?? 0.3 * (e.iDc ?? 1);
      const von = (L * dI) / (D * T);
      v.push(x < D ? von : -(von * D) / (1 - D));
      iPri.push(
        (e.iDc ?? 0) +
          (x < D ? -dI / 2 + (dI * x) / D : dI / 2 - (dI * (x - D)) / (1 - D)),
      );
    } else if (e.kind === 'flyback') {
      const vin = e.vPrimary ?? 100;
      const ipk = e.iPeak ?? 1;
      // Boundary conduction: primary ramps 0 → Ipk during D, secondary Ipk/n → 0 after.
      v.push(x < D ? vin : -(vin * D) / (1 - D));
      iPri.push(x < D ? (ipk * x) / D : 0);
      iSec.push(x < D ? 0 : (ipk / n) * (1 - (x - D) / (1 - D)));
    } else if (e.kind === 'transformer') {
      const vp = e.vPrimary ?? 100;
      const sign = x < 0.5 ? 1 : -1;
      v.push(sign * vp);
      // Trapezoidal current (leakage inductance limits di/dt): it reverses over
      // 5 % of the period at each edge; amplitude scaled so the RMS is iRms
      // (mean square = A²·(1 − 4·edge/3)).
      const edge = 0.05;
      const half = x < 0.5 ? x : x - 0.5;
      const amp = (e.iRms ?? 1) / Math.sqrt(1 - (4 * edge) / 3);
      const i = sign * amp * (half < edge ? -1 + (2 * half) / edge : 1);
      iPri.push(i);
      iSec.push(i / n);
    } else {
      const L = e.inductance || 10e-6;
      const ipk = e.iPeak ?? (e.iRms ?? 1) * Math.SQRT2;
      const w = 2 * Math.PI * e.fsw;
      iPri.push(ipk * Math.sin(2 * Math.PI * x));
      v.push(L * ipk * w * Math.cos(2 * Math.PI * x));
    }
  }
  return {
    dt,
    spp,
    v,
    iPri,
    iSec: iSec.length ? iSec : null,
    source: 'estimate',
    basis: 'idealised waveform from the specs',
  };
}

// ---------------------------------------------------------------------------
// Plot-trace helpers (fallback when the raw telemetry is unavailable)
// ---------------------------------------------------------------------------

export interface WaveStats {
  peak: number;
  rms: number;
  avg: number;
  pp: number;
}

const X_SCALE: Record<string, number> = {
  s: 1,
  ms: 1e-3,
  μs: 1e-6,
  us: 1e-6,
  ns: 1e-9,
};
const Y_SCALE: Record<string, number> = {
  a: 1,
  ma: 1e-3,
  μa: 1e-6,
  ua: 1e-6,
  v: 1,
};

/** Time-weighted steady-state statistics over the last `fraction` of a trace. */
export function waveStats(
  trace: { x?: number[]; y: number[] } | number[] | null,
  fraction = 0.25,
): WaveStats | null {
  if (!trace) return null;
  const y = Array.isArray(trace) ? trace : trace.y;
  const xRaw = Array.isArray(trace) ? null : trace.x;
  const x = xRaw && xRaw.length === y.length ? xRaw : null;
  const n = y.length;
  if (n < 8) return null;
  const start = Math.floor(n * (1 - fraction));
  let max = -Infinity,
    min = Infinity,
    sum = 0,
    sq = 0,
    span = 0;
  for (let k = start; k < n; k++) {
    if (Number.isFinite(y[k])) {
      max = Math.max(max, y[k]);
      min = Math.min(min, y[k]);
    }
    if (k + 1 >= n || !Number.isFinite(y[k]) || !Number.isFinite(y[k + 1]))
      continue;
    // Trapezoid weights when time is known (traces have a variable time step).
    const w = x ? Math.max(0, x[k + 1] - x[k]) : 1;
    sum += ((y[k] + y[k + 1]) / 2) * w;
    sq += ((y[k] * y[k] + y[k + 1] * y[k + 1]) / 2) * w;
    span += w;
  }
  if (!span) return null;
  return {
    peak: Math.max(Math.abs(max), Math.abs(min)),
    rms: Math.sqrt(sq / span),
    avg: sum / span,
    pp: max - min,
  };
}

/** Finds a current trace for `ref` (winding: 'pri' | 'sec') in the plots payload, in A vs s. */
/** One entry of a simulation `plots` payload (Plotly figure + units). */
export interface PlotPayload {
  signal?: string;
  xUnit?: string;
  yUnit?: string;
  figure?: { data?: Array<{ x?: unknown[]; y?: unknown[] }> };
}

export function findCurrentTrace(
  plots: Record<string, PlotPayload | undefined> | undefined,
  ref: string,
  winding?: 'pri' | 'sec',
): { x: number[]; y: number[] } | null {
  if (!plots) return null;
  const R = ref.toUpperCase();
  const names = winding
    ? [`${R}_${winding.toUpperCase()}_I`, `I_${R}_${winding.toUpperCase()}`]
    : [`${R}_I`, `I_${R}`];
  for (const [key, payload] of Object.entries(plots)) {
    const signal = String(payload?.signal || key)
      .toUpperCase()
      .replace(/\s*\(.*\)$/, '');
    if (!names.includes(signal) && !names.includes(key.toUpperCase())) continue;
    const trace = payload?.figure?.data?.[0];
    if (!Array.isArray(trace?.y)) continue;
    const ys = Y_SCALE[String(payload?.yUnit || 'A').toLowerCase()] ?? 1;
    const xs = X_SCALE[String(payload?.xUnit || 's')] ?? 1;
    return {
      x: Array.isArray(trace.x) ? trace.x.map((v) => Number(v) * xs) : [],
      y: trace.y.map((v) => Number(v) * ys),
    };
  }
  return null;
}
