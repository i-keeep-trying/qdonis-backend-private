import { specsOf } from '../design/studio-specs.logic';
import type { MagneticDesign } from '../engines/magnetics/magnetics-engine';
import {
  analyzeThermal,
  type CoolingRecommendation,
  type LossItem,
  type ThermalDeviceInput,
  type ThermalMagneticInput,
  type ThermalResult,
  type ThermalSettings,
} from '../engines/thermal/thermal-engine';
import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import type {
  CircuitDataProvider,
  ComponentWaveStats,
  LossComponent,
  WaveformStats,
} from './circuit-data.provider';
import type { StagePlan } from './magnetics.stage';
import { fmtW, num, round, specTemperatures, specValue } from './stage-math';

/**
 * Thermal stage (port of `runThermal` from the old frontend). Entered losses
 * and Devices-stage losses are analysed entirely here; the simulation path
 * reads waveform statistics and re-evaluated losses through the
 * {@link CircuitDataProvider}.
 */

export type Technology = 'SiC' | 'GaN' | 'Si' | 'IGBT';

export interface ThermalInputs {
  devices?: Array<{
    ref: string;
    kind?: 'switch' | 'diode';
    loss_w?: number;
    conduction_loss_w?: number;
    switching_loss_w?: number;
    technology?: Technology;
    method?: string;
  }>;
  magnetics?: Array<{ ref: string; loss_w: number; temp_rise_c?: number }>;
  other_losses?: Array<{
    ref: string;
    category: 'capacitor' | 'resistor' | 'gate_drive';
    loss_w: number;
    method?: string;
  }>;
  output_power_w?: number;
}

export interface ThermalOptions {
  ambientC?: number;
  maxJunctionC?: number;
  strategy?: 'auto' | 'none' | 'shared';
  rthCs?: number;
  marginC?: number;
  inputs?: ThermalInputs;
  fromSimulation?: boolean;
  /** Output power set by the user, W (overrides the load / specs). */
  outputPowerW?: number;
}

interface DeviceChoice {
  ref: string;
  selected: null | { type: string; family: string };
}
interface DeviceSelection {
  selections?: DeviceChoice[];
  component_models?: Record<string, string>;
}
interface RecalculatedRow {
  ref: string;
  param: string;
  after: unknown;
}

const MAGNETIC_TYPE = /inductor|transformer/;
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

const fail = (
  summary: string,
  payload?: Record<string, unknown>,
): StagePlan => ({
  ok: false,
  result: { ok: false, summary, ...(payload ? { payload } : {}) },
});

function hasThermalInputs(
  inputs?: ThermalInputs | null,
): inputs is ThermalInputs {
  return Boolean(
    inputs &&
    (inputs.devices?.length ||
      inputs.magnetics?.length ||
      inputs.other_losses?.length),
  );
}

export function deviceTechnology(
  ref: string,
  rows: RecalculatedRow[] | undefined,
  selection?: DeviceSelection,
): Technology {
  const chosen = selection?.selections?.find(
    (d) => d.ref.toLowerCase() === ref.toLowerCase(),
  )?.selected;
  if (chosen) {
    if (chosen.type === 'IGBT') return 'IGBT';
    return /sic/i.test(chosen.family) ? 'SiC' : 'Si';
  }
  const mine = (rows || []).filter(
    (r) => String(r.ref).toLowerCase() === ref.toLowerCase(),
  );
  const text = mine
    .map(
      (r) =>
        `${r.param}=${typeof r.after === 'string' || typeof r.after === 'number' ? r.after : ''}`,
    )
    .join(' ')
    .toLowerCase();
  if (/gan/.test(text)) return 'GaN';
  if (/igbt/.test(text)) return 'IGBT';
  if (/sic|c3m|c2m|c3d|c4d|c6d|scs|sct/.test(text)) return 'SiC';
  return 'Si';
}

const lossRows = (value: unknown): LossComponent[] =>
  (Array.isArray(rec(value).components)
    ? (rec(value).components as unknown[])
    : []
  )
    .map(rec)
    .filter(
      (c) => typeof c.component === 'string' || typeof c.component === 'number',
    )
    .map((c) => c as unknown as LossComponent);

/** Losses of every passive part from the simulated waveforms (old `passiveLosses`). */
export function passiveLosses(
  stats: WaveformStats,
  designedMagnetics: Set<string>,
  fsw: number | null,
): {
  passives: LossItem[];
  magnetics: ThermalMagneticInput[];
  notEvaluated: Array<{ ref: string; reason: string }>;
  /** Simulation-only parts left out of the budget (R_ISO ground anchors). */
  excluded: string[];
  loadW: number | null;
} {
  const passives: LossItem[] = [];
  const magnetics: ThermalMagneticInput[] = [];
  const notEvaluated: Array<{ ref: string; reason: string }> = [];
  const excluded: string[] = [];
  let loadW: number | null = null;
  const entries = Object.entries(stats.components);

  for (const [ref, c] of entries) {
    const type = String(c.type || '').toLowerCase();
    const role = String(c.role || '').toLowerCase();
    const p = c.params || {};

    if (MAGNETIC_TYPE.test(type)) {
      if (designedMagnetics.has(ref.toLowerCase())) continue;
      const iw = c.i_pri || c.i;
      const R = p.series_resistance;
      if (iw && R) {
        const loss =
          iw.rms * iw.rms * R + (c.i_sec ? c.i_sec.rms * c.i_sec.rms * R : 0);
        magnetics.push({
          ref,
          lossW: loss,
          copperW: loss,
          tempRiseC: null,
          source: 'winding resistance',
        });
      } else {
        notEvaluated.push({
          ref,
          reason:
            'magnetics not designed and no winding resistance in the netlist',
        });
      }
      continue;
    }

    if (type === 'resistor') {
      const R = p.resistance;
      // Ground anchors (R_ISO, ~100 MΩ from an isolated side to the input return) only
      // give ngspice a DC reference for the floating secondary; not a physical part.
      if (/anchor/.test(role) || /^R_?ISO/i.test(ref)) {
        excluded.push(
          `${ref} (${R ? `${(R / 1e6).toPrecision(3)} MΩ ` : ''}simulation-only ground anchor for the isolated side, not a real part)`,
        );
        continue;
      }
      let loss: number | null = null;
      let method = '';
      if (c.v && c.i && c.p_avg !== undefined) {
        loss = Math.abs(c.p_avg);
        method = 'time-averaged v·i of the simulated waveforms';
      } else if (c.v && R) {
        loss = (c.v.rms * c.v.rms) / R;
        method = 'V_rms²/R from the simulated voltage';
      } else if (c.i && R) {
        loss = c.i.rms * c.i.rms * R;
        method = 'I_rms²·R from the simulated current';
      } else if (c.parent && fsw) {
        const estimate = nestedResistorEstimate(ref, c, entries, stats, fsw);
        if (estimate) ({ loss, method } = estimate);
      }
      if (loss === null) {
        notEvaluated.push({
          ref,
          reason: c.parent
            ? 'no waveform for this nested part — re-run the design and simulation to export it'
            : 'no simulated voltage or current',
        });
        continue;
      }
      if (/load/.test(role)) {
        loadW = (loadW ?? 0) + loss;
        continue;
      }
      const rating = p.power_rating;
      passives.push({
        ref,
        category: /gate|drive/.test(`${role} ${ref.toLowerCase()}`)
          ? 'gate_drive'
          : 'resistor',
        lossW: loss,
        method,
        detail:
          [
            R
              ? `${R >= 1e3 ? `${(R / 1e3).toPrecision(3)} kΩ` : `${R.toPrecision(3)} Ω`}`
              : null,
            role || null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
        ratingW: rating,
        status: rating
          ? loss > rating
            ? 'over'
            : loss > 0.5 * rating
              ? 'warm'
              : 'ok'
          : undefined,
      });
      continue;
    }

    if (type === 'capacitor') {
      const esr = p.esr;
      if (c.parent && !c.i) continue;
      if (!c.i) {
        notEvaluated.push({ ref, reason: 'no simulated current' });
        continue;
      }
      if (!esr) {
        notEvaluated.push({
          ref,
          reason: `ESR not specified (I_rms ${c.i.rms.toFixed(2)} A)`,
        });
        continue;
      }
      const loss = c.i.rms * c.i.rms * esr;
      const rating = p.ripple_current_rating;
      passives.push({
        ref,
        category: 'capacitor',
        lossW: loss,
        method: `I_rms²·ESR (${c.i_derived ? 'current from C·dv/dt' : 'simulated current'})`,
        detail: `I_rms ${c.i.rms.toFixed(2)} A · ESR ${(esr * 1e3).toPrecision(3)} mΩ`,
        status: rating ? (c.i.rms > rating ? 'over' : 'ok') : undefined,
      });
    }
  }
  return { passives, magnetics, notEvaluated, excluded, loadW };
}

/** The cooling recommendation as the agent reads it (`cooling_recommendation`). */
function coolingPayload(c: CoolingRecommendation | undefined) {
  if (!c) return undefined;
  return {
    method: c.method,
    why: c.rationale,
    ...(c.heatsink
      ? {
          heatsink: {
            rsa_max_c_per_w: round(c.heatsink.rsaMaxCW, 2),
            heat_w: round(c.heatsink.heatW, 2),
            sink_temp_c: Math.round(c.heatsink.sinkTempC),
            approx_volume_cm3: c.heatsink.volumeCm3 || undefined,
            approx_size: c.heatsink.sizeHint,
            airflow: c.heatsink.airflow,
          },
        }
      : {}),
    mounting: c.mounting,
    alternatives: c.alternatives,
    notes: c.notes,
  };
}

/**
 * Loss of a nested resistor (RC snubber, damping) from a run without its own
 * telemetry (decks generated before nested parts were probed). The branch sits
 * across two pins of its parent; a square-wave step ΔV across a series RC
 * dissipates C·ΔV²·fsw·tanh(T/4RC) in R (→ C·ΔV²·fsw when RC ≪ T, i.e. ½CΔV²
 * per edge). A transformer secondary's swing is n·ΔV_pri (only the primary
 * voltage is probed). Null when the branch cannot be resolved.
 */
function nestedResistorEstimate(
  ref: string,
  c: ComponentWaveStats,
  entries: Array<[string, ComponentWaveStats]>,
  stats: WaveformStats,
  fsw: number,
): { loss: number; method: string } | null {
  const host = c.parent ? stats.components[c.parent] : undefined;
  const links = c.links;
  if (!host?.v || !links) return null;
  const R = c.params?.resistance;
  // The capacitor in series with this resistor (linked to it, same parent).
  const cap = entries.find(
    ([oref, o]) =>
      o.parent === c.parent &&
      String(o.type).toLowerCase() === 'capacitor' &&
      o.params?.capacitance &&
      ((o.links ?? []).some(([r]) => r === ref) ||
        links.some(([r]) => r === oref)),
  );
  const pins = [...links, ...(cap?.[1].links ?? [])]
    .filter(([r]) => r === c.parent)
    .map(([, pin]) => pin.toUpperCase());
  if (pins.length !== 2) return null;
  const magnetic = MAGNETIC_TYPE.test(String(host.type || '').toLowerCase());
  let dv = host.v.pp;
  let across = `${c.parent}`;
  let vrms = magnetic ? host.v.ac_rms : host.v.rms;
  if (magnetic) {
    const side = pins.every((x) => x.startsWith('P'))
      ? 'P'
      : pins.every((x) => x.startsWith('S'))
        ? 'S'
        : null;
    if (!side) return null;
    if (side === 'S') {
      const n = host.params?.turns_ratio;
      if (!n) return null;
      dv *= n;
      vrms *= n;
      across = `${c.parent} secondary (n·ΔV_pri, n = ${n})`;
    } else {
      across = `${c.parent} primary`;
    }
  }
  if (!cap) {
    if (!R) return null;
    return {
      loss: (vrms * vrms) / R,
      method: `V²/R with the AC voltage across ${across} (${vrms.toFixed(0)} V rms)`,
    };
  }
  const C = cap[1].params.capacitance;
  const factor = R ? Math.tanh(1 / (4 * fsw * R * C)) : 1;
  const cText =
    C >= 1e-6
      ? `${(C * 1e6).toPrecision(3)} µF`
      : C >= 1e-9
        ? `${(C * 1e9).toPrecision(3)} nF`
        : `${(C * 1e12).toPrecision(3)} pF`;
  return {
    loss: C * dv * dv * fsw * factor,
    method: `RC snubber estimate C·ΔV²·fsw·tanh(T/4RC) (${cap[0]} = ${cText}, ΔV = ${dv.toFixed(0)} V across ${across})`,
  };
}

export async function planThermal(
  project: StudioProject,
  options: ThermalOptions,
  provider: CircuitDataProvider,
): Promise<StagePlan> {
  const {
    inputs: inputsIn,
    fromSimulation,
    outputPowerW: userPout,
    ...settingOptions
  } = options;
  const sim = stageNodeOnBranch(project, 'simulation');
  const design = stageNodeOnBranch(project, 'design');
  const vis = stageNodeOnBranch(project, 'visualization');
  const magneticsNode = stageNodeOnBranch(project, 'magnetics');
  const specs = specsOf(stageNodeOnBranch(project, 'specs'));
  const temps = specTemperatures(specs);
  const previous = stageNodeOnBranch(project, 'thermal');
  const previousData = rec(previous?.data);
  const prevSettings = rec(previousData.settings) as Partial<ThermalSettings>;
  const previousInputs = rec(previousData.inputs) as ThermalInputs;

  const entered: ThermalInputs | null = hasThermalInputs(inputsIn)
    ? inputsIn
    : !fromSimulation &&
        previousData.origin === 'input' &&
        hasThermalInputs(previousInputs)
      ? previousInputs
      : null;

  const simReady = sim?.status === 'ready' ? sim : null;
  const inputs = entered;
  if (!inputs && !simReady) {
    return fail(
      'There is no simulation on this branch, so give the heat sources directly: call run_thermal with `devices` ' +
        '(ref, kind, loss_w or conduction/switching loss, technology) and optionally `magnetics_losses`, `other_losses` ' +
        'and `output_power_w`. No design or simulation is needed for that.',
      {
        missing: 'devices',
        example: {
          devices: [
            { ref: 'Q1', kind: 'switch', loss_w: 4.2, technology: 'SiC' },
            { ref: 'D1', kind: 'diode', loss_w: 1.1 },
          ],
        },
      },
    );
  }

  const ambientC =
    settingOptions.ambientC ?? temps.ambientC ?? prevSettings.ambientC ?? 40;
  const ambientAssumed =
    settingOptions.ambientC === undefined &&
    temps.ambientC === null &&
    !previous;
  const designed = (
    Array.isArray(rec(magneticsNode?.data).designs)
      ? (rec(magneticsNode?.data).designs as MagneticDesign[])
      : []
  ).filter((d) => d && typeof d.ref === 'string');
  const designedMags: ThermalMagneticInput[] = designed.map((d) => ({
    ref: d.ref,
    lossW: d.totalLoss_W,
    coreW: d.coreLoss_W,
    copperW: d.copperLoss_W,
    tempRiseC: d.tempRise_C,
    source: 'magnetics design',
  }));
  const specPout = specValue(specs, /output power|^power/i, 'max');

  let result: ThermalResult;
  let settings: ThermalSettings;
  let electroThermal: {
    iterations: number;
    junctionC: number;
    lossBeforeW: number;
    lossAfterW: number;
  } | null = null;
  let waveformWindow: string | undefined;

  if (inputs) {
    const devices: ThermalDeviceInput[] = (inputs.devices || []).map((d) => {
      const conduction = num(d.conduction_loss_w);
      const switching = num(d.switching_loss_w);
      const loss =
        num(d.loss_w) ??
        (conduction !== undefined || switching !== undefined
          ? (conduction ?? 0) + (switching ?? 0)
          : undefined);
      return {
        ref: String(d.ref),
        kind: d.kind === 'diode' ? 'diode' : 'switch',
        lossW: loss ?? NaN,
        technology: d.technology,
        breakdown:
          conduction !== undefined && switching !== undefined
            ? { conductionW: conduction, switchingW: switching, leakageW: 0 }
            : undefined,
        method: d.method || 'Entered value',
      };
    });
    const noLoss = devices
      .filter((d) => !Number.isFinite(d.lossW))
      .map((d) => d.ref);
    if (noLoss.length) {
      return fail('Some devices have no loss value.', {
        missing_inputs: Object.fromEntries(
          noLoss.map((ref) => [
            ref,
            ['loss_w (or conduction_loss_w + switching_loss_w)'],
          ]),
        ),
        note: 'Ask the user for these (or estimate them if they asked you to assume values) and call run_thermal again.',
      });
    }
    const enteredMags: ThermalMagneticInput[] = (inputs.magnetics || []).map(
      (m) => ({
        ref: String(m.ref),
        lossW: num(m.loss_w) ?? 0,
        tempRiseC: num(m.temp_rise_c) ?? null,
        source: 'user input',
      }),
    );
    const enteredRefs = new Set(enteredMags.map((m) => m.ref.toLowerCase()));
    const mags = [
      ...enteredMags,
      ...designedMags.filter((m) => !enteredRefs.has(m.ref.toLowerCase())),
    ];
    const others: LossItem[] = (inputs.other_losses || []).map((o) => ({
      ref: String(o.ref),
      category:
        o.category === 'capacitor' || o.category === 'gate_drive'
          ? o.category
          : 'resistor',
      lossW: num(o.loss_w) ?? 0,
      method: o.method || 'Entered value',
    }));
    const pout = num(inputs.output_power_w);
    settings = {
      ...prevSettings,
      ...settingOptions,
      ambientC,
      maxJunctionC:
        settingOptions.maxJunctionC ??
        temps.maxJunctionC ??
        prevSettings.maxJunctionC,
      outputPowerW: pout ?? userPout ?? specPout,
      outputPowerSource:
        pout !== undefined || userPout !== undefined ? 'input' : 'specs',
    };
    result = analyzeThermal(devices, mags, others, [], settings);
  } else {
    const simNode = simReady!;
    const comps = lossRows(simNode.data.loss_analysis);
    const topologyId =
      str(rec(simNode.data.metadata).topology) ??
      str(design?.data.topologyId) ??
      str(vis?.data.topologyId);
    const fsw =
      num(rec(magneticsNode?.data).fsw) ||
      specValue(specs, /switching freq|fsw/i) ||
      null;
    const recalculated = Array.isArray(design?.data.recalculated_parameters)
      ? (design.data.recalculated_parameters as RecalculatedRow[])
      : undefined;
    const zip = simNode.data.raw_time_series_zip;

    const stats = zip
      ? await provider.waveformStats({
          rawTimeSeriesZip: zip,
          topologyId,
          circuit: vis?.data.customCircuit,
          recalculated,
          fsw,
        })
      : null;
    if (!comps.length && !stats) {
      return fail(
        'Thermal analysis needs device losses or the raw simulation waveforms — re-run the simulation, or give the device losses directly (run_thermal with `devices`).',
        { missing: 'simulation_losses' },
      );
    }
    waveformWindow = stats?.window.basis;
    const passive = stats
      ? passiveLosses(
          stats,
          new Set(designed.map((d) => d.ref.toLowerCase())),
          stats.fsw || fsw,
        )
      : {
          passives: [] as LossItem[],
          magnetics: [] as ThermalMagneticInput[],
          notEvaluated: [
            {
              ref: 'passives',
              reason:
                'raw waveforms of this run are not available — re-run the simulation',
            },
          ],
          excluded: [] as string[],
          loadW: null,
        };
    const simSettings: ThermalSettings = {
      ...prevSettings,
      ...settingOptions,
      ambientC,
      maxJunctionC:
        settingOptions.maxJunctionC ??
        temps.maxJunctionC ??
        prevSettings.maxJunctionC,
      outputPowerW: userPout ?? passive.loadW ?? specPout,
      outputPowerSource:
        userPout !== undefined
          ? 'input'
          : passive.loadW !== null
            ? 'simulation'
            : 'specs',
    };
    settings = simSettings;
    const selection = rec(simNode.data.device_selection) as DeviceSelection;

    const evaluate = (list: LossComponent[]) => {
      const devices: ThermalDeviceInput[] = list.map((c) => {
        const gate = Number(c.gate_drive_loss_w) || 0;
        return {
          ref: String(c.component),
          kind: c.device_type === 'diode' ? 'diode' : 'switch',
          lossW: Math.max(0, (Number(c.total_loss_w) || 0) - gate),
          technology: deviceTechnology(
            String(c.component),
            recalculated,
            selection,
          ),
          breakdown: {
            conductionW: Number(c.conduction_loss_w) || 0,
            switchingW: Number(c.switching_loss_w) || 0,
            leakageW: Number(c.leakage_loss_w) || 0,
          },
          model: c.model,
        };
      });
      const gateItems: LossItem[] = list
        .filter((c) => Number(c.gate_drive_loss_w) > 0)
        .map((c) => ({
          ref: `${c.component} gate drive`,
          category: 'gate_drive',
          lossW: Number(c.gate_drive_loss_w),
          method: 'Qg·Vdrv·fsw from the device model',
        }));
      const out = analyzeThermal(
        devices,
        [...designedMags, ...passive.magnetics],
        [...passive.passives, ...gateItems],
        passive.notEvaluated,
        simSettings,
      );
      if (passive.excluded.length) {
        out.assumptions.push(
          `Excluded from the budget: ${passive.excluded.join('; ')}.`,
        );
      }
      return out;
    };

    result = evaluate(comps);

    // Electro-thermal loop: device losses depend on Tj; re-evaluate at the
    // hottest junction until it settles (conservative: one Tj for all).
    if (zip && result.devices.length) {
      try {
        const before = result.totals.semiconductorW;
        let evaluatedAt: number | null = null;
        let iterations = 0;
        for (let k = 0; k < 4; k += 1) {
          const hottest = Math.round(
            Math.max(...result.devices.map((d) => d.tjC)),
          );
          if (evaluatedAt !== null && Math.abs(hottest - evaluatedAt) < 2)
            break;
          const updated = await provider.recalculateLosses({
            topologyId: topologyId || '',
            circuit: vis?.data.customCircuit,
            componentModels: selection.component_models || {},
            rawTimeSeriesZip: zip,
            junctionC: hottest,
          });
          if (!updated?.components?.length) break;
          evaluatedAt = hottest;
          iterations += 1;
          result = evaluate(updated.components);
        }
        if (iterations && evaluatedAt !== null) {
          electroThermal = {
            iterations,
            junctionC: evaluatedAt,
            lossBeforeW: before,
            lossAfterW: result.totals.semiconductorW,
          };
        }
      } catch {
        electroThermal = null;
      }
    }
  }

  if (!result.budget.length && !result.devices.length) {
    return fail('No heat sources to analyse.', { missing: 'devices' });
  }

  const finalResult = result;
  const t = finalResult.totals;
  const data = JSON.parse(
    JSON.stringify({
      result: finalResult,
      settings,
      electroThermal,
      origin: entered ? 'input' : 'simulation',
      ...(entered
        ? {
            inputs: {
              devices: entered.devices || [],
              magnetics: entered.magnetics || [],
              other_losses: entered.other_losses || [],
              output_power_w: entered.output_power_w,
            },
          }
        : {}),
    }),
  ) as Record<string, unknown>;

  return {
    ok: true,
    data,
    summary: finalResult.heatsink
      ? `Heatsink ≤ ${finalResult.heatsink.rsaRequired.toFixed(2)} °C/W · ${t.totalW.toFixed(1)} W`
      : `No heatsink · ${t.totalW.toFixed(1)} W`,
    result: (fork) => ({
      ok: true,
      summary: `Thermal · ${t.totalW.toFixed(2)} W total${t.efficiencyPct !== undefined ? ` · η ${t.efficiencyPct.toFixed(1)} %` : ''}${finalResult.heatsink ? ` · heatsink ≤ ${finalResult.heatsink.rsaRequired.toFixed(2)} °C/W` : ''}`,
      payload: {
        mode: !inputs
          ? 'simulation on the active branch'
          : 'standalone (entered losses; no electro-thermal re-evaluation)',
        ambient_c: ambientC,
        ...(ambientAssumed
          ? {
              note: 'Ambient temperature is not in the specs, so 40 °C was used. Ask the user for it (estimate only if they do not know).',
            }
          : {}),
        loss_budget_w: {
          semiconductors: round(t.semiconductorW),
          magnetics: round(t.magneticsW),
          capacitors: round(t.capacitorW),
          resistors: round(t.resistorW),
          gate_drive: round(t.gateDriveW),
          total: round(t.totalW),
        },
        output_power_w: round(t.outputPowerW ?? undefined, 2),
        output_power_from: t.outputPowerSource,
        efficiency_pct: round(t.efficiencyPct, 2),
        heat_sources: finalResult.budget.slice(0, 25).map((b) => ({
          ref: b.ref,
          category: b.category,
          loss: fmtW(b.lossW),
          method: b.method,
          ...(b.detail ? { detail: b.detail } : {}),
        })),
        not_evaluated: finalResult.notEvaluated,
        waveform_window: waveformWindow,
        strategy: finalResult.strategy,
        heatsink: finalResult.heatsink,
        cooling_recommendation: coolingPayload(finalResult.cooling),
        devices: finalResult.devices.map((d) => ({
          ref: d.ref,
          tech: d.technology,
          loss_w: round(d.lossW),
          tj_c: Math.round(d.tjC),
          tj_max_c: d.tjMaxC,
          tj_without_heatsink_c: Math.round(d.tjNoHeatsinkC),
          status: d.status,
        })),
        magnetics: finalResult.magnetics.map((m) => ({
          ref: m.ref,
          loss_w: round(m.lossW),
          hotspot_c:
            m.hotspotC === null
              ? 'unknown (not designed)'
              : Math.round(m.hotspotC),
          status: m.status,
          from: m.source,
        })),
        electro_thermal: electroThermal,
        magnetics_designed: designed.length > 0,
        warnings: finalResult.warnings,
        ...fork,
      },
    }),
  };
}
