import {
  specsSignature,
  type ConstraintItem,
  type SpecRow,
  type TopologyOption,
} from '../../design/studio-specs.logic';
import {
  AVAILABLE_CORES,
  AVAILABLE_MATERIALS,
  type MagneticDesign,
} from '../../engines/magnetics/magnetics-engine';
import type {
  LossItem,
  ThermalResult,
} from '../../engines/thermal/thermal-engine';
import type { MagneticPartInput } from '../../studio-stages/magnetics.stage';
import type { ThermalInputs } from '../../studio-stages/thermal.stage';
import type { JsonObject, StageKind } from './studio-graph';

/**
 * Stage data as the Studio client reads it. Specs, magnetics and thermal
 * are stored in the shapes the Studio agent and the stage planners use
 * (`studio-specs.logic`, `magnetics.stage`, `thermal.stage`); this maps
 * them to the qdonis-web contract. Other stages are stored in that shape.
 */
export function stageDataView(stage: StageKind, data: JsonObject): JsonObject {
  if (stage === 'specs') return specsView(data);
  if (stage === 'magnetics') return magneticsView(data);
  if (stage === 'thermal') return thermalView(data);
  return data;
}

const rec = (v: unknown): JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as JsonObject)
    : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const records = (v: unknown): JsonObject[] =>
  list(v).filter(
    (x): x is JsonObject =>
      typeof x === 'object' && x !== null && !Array.isArray(x),
  );
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strings = (v: unknown): string[] =>
  list(v).filter((x): x is string => typeof x === 'string');

// --- specs -----------------------------------------------------------------------

const SPEC_CATEGORIES = new Set([
  'electrical',
  'performance',
  'thermal',
  'mechanical',
  'compliance',
  'other',
]);
const SPEC_SOURCES = new Set(['user', 'assumed', 'derived']);

function specsView(data: JsonObject): JsonObject {
  const rows = records(data.rows) as unknown as SpecRow[];
  const constraints = rec(data.constraints);
  const hasConstraints =
    data.constraints !== undefined && data.constraints !== null;
  const basis = typeof constraints.basis === 'string' ? constraints.basis : '';
  const status = constraints.status;
  return {
    application: str(data.application),
    rows: rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      value: String(r.value ?? ''),
      unit: str(r.unit),
      category: SPEC_CATEGORIES.has(String(r.category)) ? r.category : 'other',
      required: r.required === true,
      source: SPEC_SOURCES.has(String(r.source)) ? r.source : 'user',
      note: str(r.note),
    })),
    approved: data.approved === true,
    notes: str(data.notes),
    topologyOptions: (
      records(data.topologyOptions) as unknown as Array<
        TopologyOption & { topologyId?: string }
      >
    ).map((o) => ({
      topologyId: String(o.topology_id ?? o.topologyId ?? ''),
      title: String(o.title ?? ''),
      summary: String(o.summary ?? ''),
      pros: strings(o.pros),
      cons: strings(o.cons),
      recommended: o.recommended === true,
    })),
    constraints: hasConstraints
      ? {
          status: status === 'running' || status === 'error' ? status : 'ready',
          error: str(constraints.error),
          items: (
            records(constraints.items) as unknown as ConstraintItem[]
          ).map((c) => ({
            id: String(c.id),
            name: String(c.name),
            value: String(c.value ?? ''),
            category: String(c.category ?? ''),
            reasoning: str(c.reasoning),
            source: c.source === 'user' ? 'user' : 'ai',
          })),
          assumptions: strings(constraints.assumptions),
          citations: records(constraints.citations).map((c) => ({
            title: str(c.title) ?? '',
            uri: str(c.uri) ?? '',
          })),
          generatedAt: str(constraints.generatedAt),
          // Built from other key specs than the current ones.
          stale: basis !== '' && basis !== specsSignature(rows),
        }
      : null,
  };
}

// --- magnetics ---------------------------------------------------------------------

function magneticDesignView(d: MagneticDesign): JsonObject {
  return {
    ref: d.ref,
    role: d.role ?? null,
    kind: d.kind,
    core: d.core,
    stacked: d.stacked,
    material: d.material,
    areaProductRequiredMm4: d.areaProductRequired_mm4,
    areaProductCoreMm4: d.areaProductCore_mm4,
    turnsPrimary: d.turnsPrimary,
    turnsSecondary: d.turnsSecondary ?? null,
    turnsRatio: d.turnsRatio ?? null,
    airGapMm: d.airGap_mm,
    inductanceTargetUh: d.inductanceTarget_uH ?? null,
    inductanceUngappedUh: d.inductanceUngapped_uH,
    bPeakT: d.bPeak_T,
    bAcPeakT: d.bAcPeak_T,
    bSatT: d.bSat_T,
    bLimitT: d.bLimit_T,
    wirePrimary: d.wirePrimary,
    wireSecondary: d.wireSecondary ?? null,
    layersPrimary: d.layersPrimary,
    layersSecondary: d.layersSecondary ?? null,
    rdcPrimaryMohm: d.rdcPrimary_mOhm,
    rdcSecondaryMohm: d.rdcSecondary_mOhm ?? null,
    frPrimary: d.frPrimary,
    frSecondary: d.frSecondary ?? null,
    fill: d.fill,
    coreLossW: d.coreLoss_W,
    copperLossDcW: d.copperLossDc_W,
    copperLossAcW: d.copperLossAc_W,
    copperLossW: d.copperLoss_W,
    totalLossW: d.totalLoss_W,
    tempRiseC: d.tempRise_C,
    hotspotC: d.hotspot_C,
    surfaceAreaCm2: d.surfaceArea_cm2,
    currents: {
      peakA: d.currents.peak,
      rmsA: d.currents.rms,
      dcA: d.currents.dc,
      ripplePpA: d.currents.ripplePP,
      source: d.currents.source,
      basis: d.currents.basis ?? null,
    },
    voltSecondsUvs: d.voltSeconds_uVs,
    fswHz: d.fsw,
    warnings: d.warnings ?? [],
  };
}

function magneticPartView(p: MagneticPartInput, fswHz: number): JsonObject {
  return {
    ref: p.ref,
    kind: p.kind,
    role: p.role ?? null,
    inductanceUh: num(p.inductance_uh),
    turnsRatio: num(p.turns_ratio),
    fswKhz: num(p.fsw_khz) ?? fswHz / 1e3,
    duty: num(p.duty),
    iDcA: num(p.i_dc_a),
    iRipplePpA: num(p.i_ripple_pp_a),
    iPeakA: num(p.i_peak_a),
    iRmsA: num(p.i_rms_a),
    vPrimaryV: num(p.v_primary_v),
    powerW: num(p.power_w),
    unipolar: p.unipolar === true,
  };
}

function magneticsView(data: JsonObject): JsonObject {
  const settings = rec(data.settings);
  const designs = records(data.designs) as unknown as MagneticDesign[];
  const fswHz = num(data.fsw) ?? 0;
  const hottest = designs.reduce<MagneticDesign | null>(
    (best, d) => (best === null || d.hotspot_C > best.hotspot_C ? d : best),
    null,
  );
  return {
    settings: {
      material: str(settings.material),
      maxFluxDensityT: num(settings.maxFluxDensity),
      currentDensity: num(settings.currentDensity),
      windowUtilization: num(settings.windowUtilization),
      maxTempRiseC: num(settings.maxTempRiseC),
      ambientC: num(settings.ambientC) ?? 40,
    },
    designs: designs.map(magneticDesignView),
    totals: {
      lossW: designs.reduce((sum, d) => sum + d.totalLoss_W, 0),
      warningCount: designs.reduce(
        (sum, d) => sum + (d.warnings?.length ?? 0),
        0,
      ),
      hottest: hottest
        ? { ref: hottest.ref, hotspotC: hottest.hotspot_C }
        : null,
    },
    catalog: { cores: AVAILABLE_CORES, materials: AVAILABLE_MATERIALS },
    fswHz,
    basedOnSimulation: data.basedOnSimulation === true,
    origin: data.origin === 'input' ? 'input' : 'circuit',
    inputs: (records(data.inputs) as unknown as MagneticPartInput[]).map((p) =>
      magneticPartView(p, fswHz),
    ),
  };
}

// --- thermal -----------------------------------------------------------------------

const BUDGET_CATEGORIES = new Set([
  'semiconductor',
  'magnetic',
  'capacitor',
  'resistor',
  'gate_drive',
]);

function thermalResultView(r: ThermalResult): JsonObject {
  const t = r.totals;
  const hottest = r.devices.reduce<ThermalResult['devices'][number] | null>(
    (best, d) => (best === null || d.tjC > best.tjC ? d : best),
    null,
  );
  return {
    ambientC: r.ambientC,
    strategy: r.strategy,
    heatsink: r.heatsink ?? null,
    devices: r.devices.map((d) => ({
      ref: d.ref,
      kind: d.kind,
      technology: d.technology,
      lossW: d.lossW,
      rthJc: d.rthJc,
      rthCs: d.rthCs,
      rthJa: d.rthJa,
      tjMaxC: d.tjMaxC,
      tjNoHeatsinkC: d.tjNoHeatsinkC,
      tjC: d.tjC,
      marginC: d.marginC,
      status: d.status,
    })),
    magnetics: r.magnetics.map((m) => ({
      ref: m.ref,
      lossW: m.lossW,
      hotspotC: m.hotspotC,
      limitC: m.limitC,
      status: m.status,
      source: m.source,
    })),
    budget: (r.budget ?? [])
      .filter((b: LossItem) => BUDGET_CATEGORIES.has(b.category))
      .map((b) => ({
        ref: b.ref,
        category: b.category,
        lossW: b.lossW,
        method: b.method,
      })),
    hottest: hottest
      ? { ref: hottest.ref, tjC: hottest.tjC, status: hottest.status }
      : null,
    notEvaluated: r.notEvaluated ?? [],
    totals: {
      semiconductorW: t.semiconductorW,
      magneticsW: t.magneticsW,
      otherW: t.capacitorW + t.resistorW + t.gateDriveW,
      totalW: t.totalW,
      outputPowerW: num(t.outputPowerW),
      efficiencyPct: num(t.efficiencyPct),
    },
    assumptions: r.assumptions ?? [],
    warnings: r.warnings ?? [],
  };
}

const TECHNOLOGIES = new Set(['SiC', 'GaN', 'Si', 'IGBT']);
const OTHER_CATEGORIES = new Set(['capacitor', 'resistor', 'gate_drive']);

function thermalInputsView(inputs: ThermalInputs): JsonObject {
  return {
    devices: (inputs.devices ?? []).map((d) => ({
      ref: d.ref,
      kind: d.kind === 'diode' ? 'diode' : 'switch',
      lossW:
        num(d.loss_w) ??
        (num(d.conduction_loss_w) ?? 0) + (num(d.switching_loss_w) ?? 0),
      technology: TECHNOLOGIES.has(String(d.technology)) ? d.technology : 'Si',
    })),
    magnetics: (inputs.magnetics ?? []).map((m) => ({
      ref: m.ref,
      lossW: num(m.loss_w) ?? 0,
      tempRiseC: num(m.temp_rise_c),
    })),
    otherLosses: (inputs.other_losses ?? []).map((o) => ({
      ref: o.ref,
      category: OTHER_CATEGORIES.has(o.category) ? o.category : 'resistor',
      lossW: num(o.loss_w) ?? 0,
    })),
    outputPowerW: num(inputs.output_power_w),
  };
}

function thermalView(data: JsonObject): JsonObject {
  const settings = rec(data.settings);
  const strategy = settings.strategy;
  const origin = data.origin;
  if (!Array.isArray(rec(data.result).devices)) return data;
  return {
    result: thermalResultView(data.result as ThermalResult),
    settings: {
      ambientC: num(settings.ambientC) ?? 40,
      marginC: num(settings.marginC),
      maxJunctionC: num(settings.maxJunctionC),
      rthCs: num(settings.rthCs),
      strategy:
        strategy === 'none' || strategy === 'shared' ? strategy : 'auto',
      // The user's value; the computed one is in result.totals.
      outputPowerW: num(data.userOutputPowerW),
    },
    electroThermal: data.electroThermal ?? null,
    origin: origin === 'input' || origin === 'devices' ? origin : 'simulation',
    inputs:
      data.inputs === undefined || data.inputs === null
        ? null
        : thermalInputsView(data.inputs),
  };
}
