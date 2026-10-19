import { specsOf, type StageResult } from '../design/studio-specs.logic';
import {
  designMagnetic,
  findCurrentTrace,
  type MagneticDesign,
  type MagneticInputRow,
  type MagneticInputs,
  type MagneticKind,
  type MagneticRequirement,
  type MagneticsSettings,
  type MagneticWaveforms,
  type PlotPayload,
  synthesizeWaveforms,
  waveStats,
} from '../engines/magnetics/magnetics-engine';
import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import type { CircuitDataProvider } from './circuit-data.provider';
import {
  buildOperatingPoint,
  estimatePart,
  operatingPointRows,
  scaleToRms,
  type OperatingPoint,
} from './magnetics-operating-point';
import {
  estimateDuty,
  num,
  round,
  specTemperatures,
  specValue,
} from './stage-math';

/**
 * Magnetics stage (port of `runMagnetics` from the old frontend). Entered
 * parts are designed entirely here; the circuit path reads the circuit
 * inventory and simulation waveforms through the {@link CircuitDataProvider}.
 */

export interface MagneticPartInput {
  ref: string;
  kind: MagneticKind;
  role?: string;
  inductance_uh?: number;
  turns_ratio?: number;
  fsw_khz?: number;
  duty?: number;
  i_dc_a?: number;
  i_ripple_pp_a?: number;
  i_peak_a?: number;
  i_rms_a?: number;
  v_primary_v?: number;
  power_w?: number;
  unipolar?: boolean;
}

export interface MagneticsOptions {
  material?: string;
  maxFluxDensity?: number;
  currentDensity?: number;
  windowUtilization?: number;
  maxTempRiseC?: number;
  ambientC?: number;
  coreOverrides?: Record<string, string>;
  parts?: MagneticPartInput[];
  fromCircuit?: boolean;
  /**
   * Values entered in the workspace for single parts (by ref): replace that
   * part's simulated / estimated waveforms with idealised ones built from
   * these values. Merged into the previous overrides, which persist across
   * re-designs.
   */
  partOverrides?: MagneticPartInput[];
  /** Refs whose override is dropped (back to the simulated waveforms); true = all. */
  clearOverrides?: string[] | true;
}

const formatHenry = (h: number) =>
  h >= 1e-3
    ? `${Number((h * 1e3).toPrecision(3))} mH`
    : `${Number((h * 1e6).toPrecision(3))} µH`;

export type StagePlan =
  | { ok: false; result: StageResult }
  | {
      ok: true;
      data: Record<string, unknown>;
      summary: string;
      result: (fork: Record<string, unknown>) => StageResult;
    };

const fail = (
  summary: string,
  payload?: Record<string, unknown>,
): StagePlan => ({
  ok: false,
  result: { ok: false, summary, ...(payload ? { payload } : {}) },
});

/** Requirement for a part described directly, or the values it still needs. */
export function partRequirement(
  p: MagneticPartInput,
  fallbackFsw: number | null,
): { req: MagneticRequirement; assumed: string[] } | { missing: string[] } {
  const missing: string[] = [];
  const assumed: string[] = [];
  const fswKhz = num(p.fsw_khz);
  const fsw = fswKhz ? fswKhz * 1e3 : fallbackFsw;
  if (!fsw) missing.push('fsw_khz');
  const L = num(p.inductance_uh) ? num(p.inductance_uh)! * 1e-6 : null;
  const n = num(p.turns_ratio) ?? null;
  const vp = num(p.v_primary_v);
  const power = num(p.power_w);
  const iRms = num(p.i_rms_a);
  const iPeakIn = num(p.i_peak_a);
  let duty = num(p.duty);

  let estimate: Parameters<typeof synthesizeWaveforms>[0] | null = null;
  if (p.kind === 'inductor') {
    const iDc = num(p.i_dc_a) ?? iRms;
    if (!L) missing.push('inductance_uh');
    if (iDc === undefined) missing.push('i_dc_a');
    if (iDc !== undefined) {
      if (duty === undefined) {
        duty = 0.5;
        assumed.push('duty 0.5');
      }
      let ripple = num(p.i_ripple_pp_a);
      if (ripple === undefined) {
        ripple = 0.3 * iDc;
        assumed.push('ripple 30 % of I_dc');
      }
      estimate = {
        kind: 'inductor',
        fsw: fsw || 1,
        inductance: L,
        duty,
        iDc,
        iRipplePP: ripple,
      };
    }
  } else if (p.kind === 'flyback') {
    if (!L) missing.push('inductance_uh');
    if (!n) missing.push('turns_ratio');
    if (!vp) missing.push('v_primary_v');
    if (duty === undefined) {
      duty = 0.45;
      assumed.push('duty 0.45');
    }
    const iPeak =
      iPeakIn ?? (power && vp ? (2 * (power / 0.9)) / (vp * duty) : undefined);
    if (iPeak === undefined) missing.push('i_peak_a or power_w');
    else if (iPeakIn === undefined)
      assumed.push('peak current from power_w at 90 % efficiency');
    if (iPeak !== undefined && vp) {
      estimate = {
        kind: 'flyback',
        fsw: fsw || 1,
        inductance: L,
        turnsRatio: n,
        duty,
        vPrimary: vp,
        iPeak,
      };
    }
  } else if (p.kind === 'transformer') {
    if (!n) missing.push('turns_ratio');
    if (!vp) missing.push('v_primary_v');
    if (duty === undefined) duty = 0.5;
    const rms = iRms ?? (power && vp ? power / (0.9 * vp) : undefined);
    if (rms === undefined) missing.push('i_rms_a or power_w');
    else if (iRms === undefined)
      assumed.push('primary RMS current from power_w at 90 % efficiency');
    if (rms !== undefined && vp) {
      estimate = {
        kind: 'transformer',
        fsw: fsw || 1,
        turnsRatio: n,
        duty,
        vPrimary: vp,
        iRms: rms,
      };
    }
  } else if (p.kind === 'resonant') {
    if (!L) missing.push('inductance_uh');
    const iPeak =
      iPeakIn ??
      (iRms !== undefined
        ? Math.SQRT2 * iRms
        : power && vp
          ? (Math.SQRT2 * power) / (0.9 * vp * 0.7)
          : undefined);
    if (iPeak === undefined)
      missing.push('i_peak_a, i_rms_a or power_w + v_primary_v');
    if (iPeak !== undefined)
      estimate = {
        kind: 'resonant',
        fsw: fsw || 1,
        inductance: L,
        duty: 0.5,
        iPeak,
      };
  } else {
    missing.push("kind ('inductor' | 'flyback' | 'transformer' | 'resonant')");
  }

  if (missing.length || !estimate || !fsw) return { missing };
  const waves = {
    ...synthesizeWaveforms(estimate),
    basis: 'idealised waveforms from the entered values',
  };
  return {
    req: {
      ref: p.ref,
      role: p.role || null,
      kind: p.kind,
      inductance: L,
      turnsRatio: n,
      fsw,
      waves,
      unipolar: p.kind === 'transformer' && !!p.unipolar,
    },
    assumed,
  };
}

/** Generic idealised waveforms of a circuit part the operating-point model does not cover. */
function genericWaves(a: {
  kind: MagneticKind;
  fsw: number;
  inductance: number | null;
  turnsRatio: number | null;
  /** Statistics of the part's plot trace, when there is one. */
  trace: ReturnType<typeof waveStats>;
  pout: number;
  vin: number;
  vinMax: number | null;
  vout: number | null;
  role: string;
  topology: string;
}): MagneticWaveforms {
  const { kind, fsw, inductance: L, turnsRatio: n, trace: pri, pout: p } = a;
  const { vin, vinMax, vout, role, topology } = a;
  if (kind === 'flyback') {
    const D = 0.45;
    return synthesizeWaveforms({
      kind,
      fsw,
      inductance: L,
      turnsRatio: n,
      duty: D,
      vPrimary: vin,
      iPeak: pri?.peak ?? (2 * (p / 0.9)) / (vin * D),
    });
  }
  if (kind === 'transformer') {
    const vp = vinMax
      ? /half_bridge/.test(topology)
        ? vinMax / 2
        : vinMax
      : 100;
    return synthesizeWaveforms({
      kind,
      fsw,
      turnsRatio: n,
      duty: 0.5,
      vPrimary: vp,
      iRms: pri?.rms ?? p / (0.9 * vp),
    });
  }
  if (kind === 'resonant') {
    return synthesizeWaveforms({
      kind,
      fsw,
      inductance: L,
      duty: 0.5,
      iPeak: pri?.peak ?? (Math.SQRT2 * p) / (0.9 * vin * 0.7),
    });
  }
  const inputSide =
    /input|boost|pfc|emi/.test(role) ||
    topology.startsWith('acdc') ||
    /boost/.test(topology);
  const iDc = pri
    ? Math.abs(pri.avg)
    : inputSide
      ? p / (0.95 * vin)
      : p / (vout || 12);
  return synthesizeWaveforms({
    kind,
    fsw,
    inductance: L,
    duty: estimateDuty(topology, vin, vout),
    iDc,
    iRipplePP: pri?.pp ?? 0.3 * iDc,
  });
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

export async function planMagnetics(
  project: StudioProject,
  options: MagneticsOptions,
  provider: CircuitDataProvider,
): Promise<StagePlan> {
  const {
    parts: partsIn,
    fromCircuit,
    partOverrides,
    clearOverrides,
    ...settingOptions
  } = options;
  const design = stageNodeOnBranch(project, 'design');
  const vis = stageNodeOnBranch(project, 'visualization');
  const sim = stageNodeOnBranch(project, 'simulation');
  const specs = specsOf(stageNodeOnBranch(project, 'specs'));
  const previous = stageNodeOnBranch(project, 'magnetics');
  const previousData = rec(previous?.data);
  const topologyId = str(design?.data.topologyId) ?? str(vis?.data.topologyId);

  const previousInputs = Array.isArray(previousData.inputs)
    ? (previousData.inputs as MagneticPartInput[])
    : [];
  const partsBase = partsIn?.length
    ? partsIn
    : !fromCircuit && previousData.origin === 'input'
      ? previousInputs
      : null;
  // Entered parts take workspace edits in place; circuit parts keep them as overrides.
  const parts =
    partsBase && partOverrides?.length
      ? partsBase.map((p) => ({
          ...p,
          ...(partOverrides.find((o) => o.ref === p.ref) ?? {}),
        }))
      : partsBase;
  const overrides: Record<string, MagneticPartInput> =
    parts || clearOverrides === true
      ? {}
      : {
          ...(rec(previousData.overrides) as Record<string, MagneticPartInput>),
        };
  if (Array.isArray(clearOverrides)) {
    for (const ref of clearOverrides) delete overrides[ref];
  }
  if (!parts) {
    for (const o of partOverrides ?? []) {
      overrides[o.ref] = { ...(overrides[o.ref] ?? {}), ...o };
    }
  }

  if (!parts && !topologyId) {
    return fail(
      'There is no circuit on this branch, so describe the magnetic parts directly: call design_magnetics with `parts` ' +
        '(e.g. inductor: inductance_uh, i_dc_a, i_ripple_pp_a, fsw_khz; transformer: turns_ratio, v_primary_v, i_rms_a or power_w, fsw_khz). ' +
        'No design or simulation is needed for that.',
      {
        missing: 'parts',
        example: {
          parts: [
            {
              ref: 'L1',
              kind: 'inductor',
              inductance_uh: 47,
              i_dc_a: 10,
              i_ripple_pp_a: 3,
              fsw_khz: 100,
            },
          ],
        },
      },
    );
  }

  const prevSettings = rec(previousData.settings) as Partial<MagneticsSettings>;
  const temps = specTemperatures(specs);
  const ambientC =
    settingOptions.ambientC ?? prevSettings.ambientC ?? temps.ambientC ?? 40;
  const ambientAssumed =
    settingOptions.ambientC === undefined &&
    temps.ambientC === null &&
    !previous;
  const settings: MagneticsSettings = {
    ...prevSettings,
    ...settingOptions,
    ambientC,
    coreOverrides: {
      ...(prevSettings.coreOverrides ?? {}),
      ...(settingOptions.coreOverrides ?? {}),
    },
  };

  const requirements: MagneticRequirement[] = [];
  const assumptions: Record<string, string[]> = {};
  let fsw: number;
  let waveformsFrom: string;
  let operatingPoint: OperatingPoint | null = null;

  if (parts) {
    const specFsw = specValue(specs, /switching freq|fsw/i);
    const missing: Record<string, string[]> = {};
    parts.forEach((p, i) => {
      const part = { ...p, ref: p.ref || `L${i + 1}` };
      const r = partRequirement(part, specFsw);
      if ('missing' in r) missing[part.ref] = r.missing;
      else {
        requirements.push(r.req);
        if (r.assumed.length) assumptions[part.ref] = r.assumed;
      }
    });
    if (Object.keys(missing).length) {
      return fail(
        'Some magnetic parts are missing values needed to design them.',
        {
          missing_inputs: missing,
          note: 'Ask the user for these (or use typical values if they asked you to assume them) and call design_magnetics again with the complete parts list. No upstream stage is needed.',
        },
      );
    }
    if (!requirements.length)
      return fail('No magnetic parts were given.', { missing: 'parts' });
    fsw = requirements[0].fsw;
    waveformsFrom = 'idealised waveforms from the entered values';
  } else {
    const topology = topologyId!;
    const inventory = await provider.inventory({
      topologyId: topology,
      circuit: vis?.data.customCircuit,
      recalculated: Array.isArray(design?.data.recalculated_parameters)
        ? design.data.recalculated_parameters
        : undefined,
    });
    if (!inventory) return fail('Could not read the circuit from the backend.');
    if (!inventory.magnetics.length) {
      return fail('This circuit has no inductors or transformers to design.', {
        components: inventory.components.length,
      });
    }
    const specFsw = specValue(specs, /switching freq|fsw/i);
    fsw = inventory.switching_frequency || specFsw || 100e3;
    const fswSource = inventory.switching_frequency
      ? 'circuit'
      : specFsw
        ? 'specs'
        : 'assumed 100 kHz';
    const pout = specValue(specs, /output power|^power/i, 'max');
    const vout = specValue(specs, /output voltage/i, 'max');
    const vinMax =
      specValue(specs, /input voltage/i, 'max') ||
      inventory.input_voltage ||
      null;
    const vinMin =
      specValue(specs, /input voltage/i, 'min') ||
      inventory.input_voltage ||
      null;
    const simReady = sim?.status === 'ready' ? sim : null;
    const plots = rec(simReady?.data.plots) as Record<
      string,
      PlotPayload | undefined
    >;
    const stats =
      simReady && simReady.data.raw_time_series_zip
        ? await provider.waveformStats({
            rawTimeSeriesZip: simReady.data.raw_time_series_zip,
            topologyId: topology,
            circuit: vis?.data.customCircuit,
            recalculated: Array.isArray(design?.data.recalculated_parameters)
              ? design.data.recalculated_parameters
              : undefined,
            fsw,
          })
        : null;
    const op = buildOperatingPoint({
      topologyId: topology,
      specs,
      inventory,
      design: design?.data,
      sim: simReady,
      fsw,
      fswSource,
    });
    operatingPoint = op;

    const overrideFailures: Record<string, string[]> = {};
    for (const m of inventory.magnetics) {
      const override = overrides[m.ref];
      if (override) {
        const r = partRequirement({ ...override, ref: m.ref }, fsw);
        if ('missing' in r) {
          overrideFailures[m.ref] = r.missing;
          continue;
        }
        requirements.push({
          ...r.req,
          role: m.role,
          inputs: {
            basis:
              'Values entered in the workspace (idealised waveforms replace the simulated ones)',
            rows: operatingPointRows(op),
            ...(r.assumed.length
              ? { assumptions: [`Assumed ${r.assumed.join(', ')}.`] }
              : {}),
          },
        });
        continue;
      }
      const role = String(m.role || '').toLowerCase();
      const isTransformer = /transformer/.test(m.type);
      const kind: MagneticKind = isTransformer
        ? /flyback/.test(role) || /flyback/.test(topology)
          ? 'flyback'
          : 'transformer'
        : /resonant|leakage/.test(role)
          ? 'resonant'
          : 'inductor';
      let L = m.inductance ?? m.magnetizing_inductance ?? null;
      let n = m.turns_ratio ?? null;
      let partKind = kind;
      let partFsw = fsw;
      let unipolar =
        kind === 'transformer' &&
        /forward/.test(topology) &&
        !/active_clamp/.test(topology);
      let inputs: MagneticInputs;

      let waves: MagneticWaveforms;
      const measured = stats?.components[m.ref];
      if (measured?.wave && stats?.samples_per_period) {
        // A dual centre-tapped primary is probed end to end (both halves) while
        // its current is one half's: design the half winding.
        const halfPrimary = m.type === 'dual_ct_transformer';
        waves = {
          dt: stats.dt,
          spp: stats.samples_per_period,
          v: halfPrimary ? measured.wave.v.map((x) => x / 2) : measured.wave.v,
          iPri: measured.wave.i_pri || measured.wave.i,
          iSec: measured.wave.i_sec || null,
          source: 'simulation',
          basis: stats.window.basis,
        };
        if (halfPrimary && L) L /= 4;
        inputs = {
          basis: `Simulated winding voltage and current${halfPrimary ? ' (per primary half)' : ''} over ${stats.window.basis}`,
          rows: [
            ...operatingPointRows(op),
            ...(L
              ? [
                  {
                    label: isTransformer ? 'Lm' : 'L',
                    value: formatHenry(L),
                    note: 'circuit',
                  },
                ]
              : []),
            ...(n
              ? [
                  {
                    label: 'Ns/Np',
                    value: String(Number(n.toPrecision(4))),
                    note: 'circuit',
                  },
                ]
              : []),
          ],
        };
      } else {
        const est = estimatePart(m, inventory.magnetics, op, topology, kind);
        // Plot traces are min/max decimated but still give a usable RMS to scale the estimate to.
        const trace = waveStats(
          findCurrentTrace(plots, m.ref, isTransformer ? 'pri' : undefined) ||
            findCurrentTrace(plots, m.ref),
        );
        if (est) {
          const scaled =
            trace && trace.rms > 0
              ? scaleToRms(est, trace.rms, 'simulated plot trace')
              : est;
          waves = scaled.waves;
          inputs = scaled.inputs;
          partKind = scaled.kind;
          partFsw = scaled.fsw;
          L = scaled.inductance;
          n = scaled.turnsRatio;
          unipolar = !!scaled.unipolar;
        } else {
          // No operating-point model for this part: generic idealised waveforms.
          const pri = trace;
          const p = pout ?? op.pout;
          const vin = vinMin || vinMax || op.vinMin || 100;
          const vo = vout ?? op.vout;
          waves = genericWaves({
            kind,
            fsw,
            inductance: L,
            turnsRatio: n,
            trace: pri,
            pout: p,
            vin,
            vinMax: vinMax || op.vinMax,
            vout: vo,
            role,
            topology,
          });
          inputs = {
            basis:
              'Generic idealised waveform (no operating-point model for this part)',
            rows: operatingPointRows(op),
            assumptions: [
              'Currents estimated from the output power only — simulate for accurate waveforms.',
              ...op.assumptions,
            ],
          };
        }
      }
      requirements.push({
        ref: m.ref,
        role: m.role,
        kind: partKind,
        inductance: L,
        turnsRatio: n,
        fsw: partFsw,
        waves,
        unipolar,
        inputs,
      });
    }
    if (Object.keys(overrideFailures).length) {
      return fail('Some entered magnetic values are incomplete.', {
        missing_inputs: overrideFailures,
      });
    }
    waveformsFrom = requirements.some((r) => r.waves.source === 'simulation')
      ? `raw simulation telemetry (${stats?.window.basis})`
      : simReady && !simReady.data.raw_time_series_zip
        ? 'idealised waveforms scaled to the plot traces (raw telemetry of this run is not available — re-run the simulation for exact flux and harmonics)'
        : 'idealised waveforms from the specs (run the simulation for exact flux and harmonics)';
  }

  const designs: MagneticDesign[] = [];
  const failures: string[] = [];
  for (const req of requirements) {
    try {
      designs.push(designMagnetic(req, settings));
    } catch (error) {
      failures.push(
        `${req.ref}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!designs.length)
    return fail(`Magnetics design failed — ${failures.join('; ')}`);

  const fromSim = designs.some((d) => d.currents.source === 'simulation');
  const total = designs.reduce((a, d) => a + d.totalLoss_W, 0);
  const data: Record<string, unknown> = JSON.parse(
    JSON.stringify({
      settings,
      designs,
      fsw,
      basedOnSimulation: fromSim,
      origin: parts ? 'input' : 'circuit',
      ...(parts ? { inputs: parts } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(operatingPoint
        ? {
            operatingPoint: {
              rows: operatingPointRows(operatingPoint),
              notes: operatingPoint.assumptions,
            },
          }
        : {}),
    }),
  ) as Record<string, unknown>;
  const rowText = (x: MagneticInputRow) =>
    x.note ? `${x.value} (${x.note})` : x.value;

  return {
    ok: true,
    data,
    summary: designs
      .map((d) => `${d.ref}: ${d.stacked > 1 ? `${d.stacked}×` : ''}${d.core}`)
      .join(', '),
    result: (fork) => ({
      ok: true,
      summary: `${designs.length} magnetic part${designs.length > 1 ? 's' : ''} designed · ${total.toFixed(2)} W`,
      payload: {
        mode: parts
          ? 'standalone (entered part values)'
          : 'circuit on the active branch',
        fsw_hz: fsw,
        ambient_c: ambientC,
        ...(ambientAssumed
          ? {
              note: 'Ambient temperature is not in the specs, so 40 °C was used. Ask the user for it (estimate only if they do not know).',
            }
          : {}),
        ...(Object.keys(assumptions).length
          ? { assumed_values: assumptions }
          : {}),
        waveforms_from: waveformsFrom,
        ...(Object.keys(overrides).length
          ? { entered_in_workspace: overrides }
          : {}),
        ...(operatingPoint
          ? {
              operating_point: Object.fromEntries(
                operatingPointRows(operatingPoint).map((x) => [
                  x.label,
                  rowText(x),
                ]),
              ),
            }
          : {}),
        method:
          "Flux from ∫v·dt of the winding voltage; core loss by iGSE with the material's Steinmetz fit at the hotspot temperature; copper loss = Rdc·I_lf² + Σ Rdc·Fr(h)·I_h² (Dowell per switching harmonic); gap with fringing; turns chosen for minimum loss on the smallest core meeting flux, fill and temperature limits.",
        designs: designs.map((d) => ({
          ref: d.ref,
          kind: d.kind,
          core: `${d.stacked > 1 ? `${d.stacked}x ` : ''}${d.core} ${d.material}`,
          turns: d.turnsSecondary
            ? `${d.turnsPrimary}:${d.turnsSecondary}`
            : d.turnsPrimary,
          turns_ratio_ns_np: d.turnsRatio
            ? {
                target: round(d.turnsRatio.target, 4),
                wound: round(d.turnsRatio.actual, 4),
              }
            : undefined,
          air_gap_mm: round(d.airGap_mm, 2),
          fringing_factor: round(d.fringingFactor, 2),
          inductance_target_uh: round(d.inductanceTarget_uH, 2),
          b_peak_t: round(d.bPeak_T),
          b_limit_t: round(d.bLimit_T),
          delta_b_half_t: round(d.bAcPeak_T),
          volt_seconds_uvs: round(d.voltSeconds_uVs, 1),
          wire: d.wireSecondary
            ? `${d.wirePrimary} (${d.layersPrimary} layers) / ${d.wireSecondary} (${d.layersSecondary} layers)`
            : `${d.wirePrimary} (${d.layersPrimary} layers)`,
          copper_fill_pct: Math.round(d.fill * 100),
          rac_rdc_primary: round(d.frPrimary, 2),
          core_loss_w: round(d.coreLoss_W),
          copper_loss_dc_w: round(d.copperLossDc_W),
          copper_loss_ac_w: round(d.copperLossAc_W),
          total_loss_w: round(d.totalLoss_W),
          temp_rise_c: round(d.tempRise_C, 1),
          hotspot_c: round(d.hotspot_C, 1),
          currents: {
            i_rms: round(d.currents.rms),
            i_peak: round(d.currents.peak),
            i_avg: round(d.currents.dc),
            i_ripple_pp: round(d.currents.ripplePP),
            i_sec_rms: round(d.currents.rmsSecondary),
            from: d.currents.source,
          },
          design_inputs: d.inputs
            ? {
                basis: d.inputs.basis,
                values: Object.fromEntries(
                  d.inputs.rows.map((x) => [x.label, rowText(x)]),
                ),
                ...(d.inputs.assumptions?.length
                  ? { assumptions: d.inputs.assumptions }
                  : {}),
              }
            : undefined,
          warnings: d.warnings,
        })),
        ...(failures.length ? { failed: failures } : {}),
        total_loss_w: Number(total.toFixed(3)),
        ...fork,
      },
    }),
  };
}
