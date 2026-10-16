import { bomRows, type BomSourcePart, bomSummary } from '../engines/bom/bom';
import { runVoltageScan } from '../engines/emc/emc-calculations';
import type { EMCInputParameters } from '../engines/emc/emc.types';
import {
  calculateMTBFComponents,
  calculateSystemMTBF,
  ENVIRONMENT_FACTORS,
} from '../engines/reliability/mtbf-calculations';
import type {
  SelectedPart,
  ThermalComponent,
} from '../engines/reliability/reliability.types';
import {
  type JsonObject,
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { isMeaningfulParam } from '../studio-chat/agent-results';
import type { MTBF_METHODS } from './dto/stages.dto';
import type { StagePlan } from './magnetics.stage';

/**
 * Planners of the stages added with entry steps (EMC, Components, BOM,
 * MTBF). Like the magnetics / thermal planners they are pure: they read the
 * branch, run the engine and return the node data, or the missing inputs.
 */

const rec = (v: unknown): JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as JsonObject)
    : {};
const records = (v: unknown): JsonObject[] =>
  Array.isArray(v) ? v.filter((x): x is JsonObject => rec(x) === x) : [];
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v.trim()
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : '';
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const fail = (summary: string, payload?: JsonObject): StagePlan => ({
  ok: false,
  result: { ok: false, summary, ...(payload ? { payload } : {}) },
});

/** Inputs the user did not give and Q assumed (stored for the "Assumed" badge). */
const provenance = (assumed: string[] | undefined) =>
  assumed?.length ? { assumedInputs: [...new Set(assumed)].slice(0, 50) } : {};

// --- EMC ------------------------------------------------------------------------

export type EmcInput = Partial<EMCInputParameters>;

const EMC_REQUIRED: Array<[keyof EMCInputParameters, string]> = [
  ['pfcInductorMH', 'pfc_inductor_mh'],
  ['htRailVoltage', 'ht_rail_voltage_v'],
  ['inputPower', 'input_power_w'],
  ['inputRMSVoltage', 'input_rms_voltage_v'],
  ['firstInputCapNF', 'first_input_cap_nf'],
  ['secondInputCapNF', 'second_input_cap_nf'],
  ['inputFilterInductorMH', 'input_filter_inductor_mh'],
];

export function planEmc(input: EmcInput, assumed?: string[]): StagePlan {
  const missing = EMC_REQUIRED.filter(
    ([key]) => !finite(input[key]) || input[key] <= 0,
  ).map(([, name]) => name);
  if (missing.length) {
    return fail(`Missing EMC inputs: ${missing.join(', ')}`, {
      missing_inputs: missing,
    });
  }
  const params: EMCInputParameters = {
    pfcInductorMH: input.pfcInductorMH!,
    htRailVoltage: input.htRailVoltage!,
    inputPower: input.inputPower!,
    inputRMSVoltage: input.inputRMSVoltage!,
    firstInputCapNF: input.firstInputCapNF!,
    secondInputCapNF: input.secondInputCapNF!,
    inputFilterInductorMH: input.inputFilterInductorMH!,
    passMarginDB: finite(input.passMarginDB) ? input.passMarginDB : 6,
    lisnResistanceOhm: finite(input.lisnResistanceOhm)
      ? input.lisnResistanceOhm
      : 50,
  };
  const scan = runVoltageScan(params);
  const verdict = scan.overallPass ? 'PASS' : 'FAIL';
  const worst = scan.scanResults.reduce<
    (typeof scan.scanResults)[number] | null
  >((w, r) => (!w || r.minMarginDB < w.minMarginDB ? r : w), null);
  return {
    ok: true,
    data: { inputs: params, result: scan, ...provenance(assumed) },
    summary: `${verdict} · worst margin ${scan.worstMarginDB.toFixed(1)} dB`,
    result: (fork) => ({
      ok: true,
      summary: `EMC ${verdict} · worst margin ${scan.worstMarginDB.toFixed(1)} dB (${scan.passCount} pass / ${scan.failCount} fail)`,
      payload: {
        verdict,
        worst_margin_db: Number(scan.worstMarginDB.toFixed(2)),
        worst_case: worst
          ? {
              input_voltage_v: worst.inputVoltage,
              frequency_khz: Number(worst.frequencyOfMinMarginKHz.toFixed(1)),
              detector: worst.detectorType,
            }
          : null,
        pass_count: scan.passCount,
        fail_count: scan.failCount,
        inputs: params,
        note: 'Margins are over the EN 55015 limit minus the pass margin; negative fails. A larger X capacitor or filter inductor raises the margin.',
        ...fork,
      },
    }),
  };
}

// --- components -------------------------------------------------------------------

export interface ComponentPart {
  ref: string;
  type: string;
  value: string;
  rating: string;
  manufacturer: string;
  partNumber: string;
  mouserPartNumber?: string;
  description: string;
  quantity: number;
  source: 'entered' | 'design' | 'devices' | 'magnetics' | 'supplier';
  unitPrice?: number;
  availability?: string;
  datasheetUrl?: string;
}

/** Parts the model entered (`parts` of the tools). */
export function enteredParts(value: unknown): ComponentPart[] {
  return records(value)
    .filter((p) => text(p.ref) && text(p.type))
    .slice(0, 500)
    .map((p) => ({
      ref: text(p.ref).slice(0, 60),
      type: text(p.type).toLowerCase().slice(0, 40),
      value: text(p.value).slice(0, 80),
      rating: text(p.rating).slice(0, 80),
      manufacturer: text(p.manufacturer).slice(0, 80),
      partNumber: text(p.part_number).slice(0, 80),
      description: text(p.description).slice(0, 200),
      quantity:
        finite(p.quantity) && p.quantity >= 1
          ? Math.min(Math.floor(p.quantity), 100_000)
          : 1,
      source: 'entered' as const,
    }));
}

const TYPE_OF_REF: Array<[RegExp, string]> = [
  [/^C/i, 'capacitor'],
  [/^R/i, 'resistor'],
  [/^L/i, 'inductor'],
  [/^(T|TX|XFMR)/i, 'transformer'],
  [/^D/i, 'diode'],
  [/^(Q|M|S)/i, 'mosfet'],
];

/** The components of the branch: design values, chosen devices, designed magnetics. */
export function branchParts(project: StudioProject): ComponentPart[] {
  const parts = new Map<string, ComponentPart>();
  const design = stageNodeOnBranch(project, 'design');
  for (const row of records(design?.data.recalculatedParameters)) {
    if (!isMeaningfulParam(row)) continue;
    const ref = text(row.ref);
    if (!ref || parts.has(ref)) continue;
    const value = text(row.after) || text(row.before);
    if (!value) continue;
    parts.set(ref, {
      ref,
      type: TYPE_OF_REF.find(([re]) => re.test(ref))?.[1] ?? 'component',
      value,
      rating: '',
      manufacturer: '',
      partNumber: '',
      description: text(row.description),
      quantity: 1,
      source: 'design',
    });
  }
  const devices = stageNodeOnBranch(project, 'devices');
  const simulation = stageNodeOnBranch(project, 'simulation');
  const selection = rec(
    devices?.data.selection ??
      simulation?.data.deviceSelection ??
      simulation?.data.device_selection,
  );
  for (const choice of records(selection.selections)) {
    const selected = rec(choice.selected);
    const part = text(selected.part);
    if (!part) continue;
    const ref = text(choice.ref);
    parts.set(ref, {
      ref,
      type:
        choice.kind === 'diode' ? 'diode' : text(selected.family) || 'mosfet',
      value: part,
      rating: finite(selected.vRatingV) ? `${selected.vRatingV} V` : '',
      manufacturer: text(selected.manufacturer),
      partNumber: part,
      description: `${text(selected.family)} power device`.trim(),
      quantity: 1,
      source: 'devices',
    });
  }
  const magnetics = stageNodeOnBranch(project, 'magnetics');
  for (const d of records(magnetics?.data.designs)) {
    const ref = text(d.ref);
    if (!ref) continue;
    parts.set(ref, {
      ref,
      type: text(d.kind) === 'inductor' ? 'inductor' : 'transformer',
      value: `${text(d.core)} ${text(d.material)}`.trim(),
      rating: '',
      manufacturer: '',
      partNumber: '',
      description: `Custom wound ${text(d.kind) || 'magnetic'} on ${text(d.core)}`,
      quantity: 1,
      source: 'magnetics',
    });
  }
  return [...parts.values()];
}

export function planComponents(
  parts: ComponentPart[],
  origin: 'input' | 'branch',
  notes: string[],
  assumed?: string[],
): StagePlan {
  if (!parts.length) {
    return fail(
      origin === 'branch'
        ? 'No components on this branch yet. Enter the parts (designator, type, value, rating).'
        : 'Enter at least one part (designator and type).',
      { missing_inputs: ['parts'] },
    );
  }
  const unresolved = parts.filter((p) => !p.partNumber).map((p) => p.ref);
  return {
    ok: true,
    data: { parts, origin, notes, ...provenance(assumed) },
    summary: `${parts.length} parts · ${parts.length - unresolved.length} with part numbers`,
    result: (fork) => ({
      ok: true,
      summary: `${parts.length} parts listed · ${parts.length - unresolved.length} with a part number`,
      payload: {
        origin:
          origin === 'branch'
            ? 'components of the branch (design, devices, magnetics)'
            : 'entered parts',
        parts: parts.slice(0, 80).map((p) => ({
          ref: p.ref,
          type: p.type,
          value: p.value,
          rating: p.rating || undefined,
          part: p.partNumber
            ? `${p.manufacturer ? `${p.manufacturer} ` : ''}${p.partNumber}`
            : 'not chosen',
          source: p.source,
        })),
        without_part_number: unresolved,
        notes,
        ...fork,
      },
    }),
  };
}

// --- BOM --------------------------------------------------------------------------

export function partsOfStage(project: StudioProject): ComponentPart[] {
  const node = stageNodeOnBranch(project, 'components');
  return records(node?.data.parts) as unknown as ComponentPart[];
}

const bomSource = (p: ComponentPart, multiplier: number): BomSourcePart => ({
  componentName: p.ref,
  manufacturer: p.manufacturer || undefined,
  partNumber: p.partNumber || undefined,
  mouserPartNumber: p.mouserPartNumber,
  description:
    p.description ||
    [p.type, p.value, p.rating].filter(Boolean).join(' ') ||
    undefined,
  quantity: p.quantity * multiplier,
  availability: p.availability,
  datasheetLink: p.datasheetUrl,
  pricingTiers:
    p.unitPrice !== undefined ? [{ quantity: 1, price: p.unitPrice }] : [],
});

export function planBom(
  parts: ComponentPart[],
  buildQuantity: number,
  assumed?: string[],
): StagePlan {
  if (!parts.length) {
    return fail(
      'No parts for a bill of materials. Select the components first, or enter the parts.',
      { missing_inputs: ['parts'] },
    );
  }
  const multiplier = Math.min(Math.max(Math.floor(buildQuantity), 1), 100_000);
  const rows = bomRows(parts.map((p) => bomSource(p, multiplier)));
  const summary = bomSummary(rows);
  return {
    ok: true,
    data: { rows, summary, buildQuantity: multiplier, ...provenance(assumed) },
    summary: `${summary.totalItems} lines · ${summary.totalQuantity} parts`,
    result: (fork) => ({
      ok: true,
      summary: `BOM · ${summary.totalItems} lines, ${summary.totalQuantity} parts${summary.totalCost > 0 ? `, ${summary.totalCost.toFixed(2)} total` : ''}`,
      payload: {
        build_quantity: multiplier,
        summary,
        lines: rows.slice(0, 60).map((r) => ({
          line: r.lineNumber,
          designator: r.designator,
          part: `${r.manufacturer} ${r.manufacturerPartNumber}`,
          quantity: r.quantity,
          unit_price: r.unitPrice || undefined,
        })),
        note: 'Prices and stock are only known for parts found through supplier search.',
        ...fork,
      },
    }),
  };
}

// --- MTBF -------------------------------------------------------------------------

export type MtbfMethod = (typeof MTBF_METHODS)[number];

/** The environment key of a method that a loose name ("ground benign", "GB") refers to. */
export function matchEnvironment(
  method: MtbfMethod,
  name: string,
): string | null {
  const keys = Object.keys(ENVIRONMENT_FACTORS[method] ?? {});
  const n = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!n) return null;
  const clean = (k: string) =>
    k
      .replace(/\(.*\)/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return (
    keys.find((k) => clean(k) === n) ??
    keys.find((k) => clean(k).startsWith(n)) ??
    keys.find((k) => clean(k).split(' ')[0] === n) ??
    keys.find((k) => clean(k).includes(n)) ??
    null
  );
}

/** Junction / hotspot temperature per part from the branch's thermal result. */
function thermalTemperatures(project: StudioProject): Map<string, number> {
  const out = new Map<string, number>();
  const result = rec(stageNodeOnBranch(project, 'thermal')?.data.result);
  for (const d of records(result.devices)) {
    if (text(d.ref) && finite(d.tjC)) out.set(text(d.ref), d.tjC);
  }
  for (const m of records(result.magnetics)) {
    if (text(m.ref) && finite(m.hotspotC)) out.set(text(m.ref), m.hotspotC);
  }
  return out;
}

export function planMtbf(
  project: StudioProject,
  options: {
    method: MtbfMethod;
    environment: string;
    parts: ComponentPart[];
    temperatureC?: number;
  },
  assumed?: string[],
): StagePlan {
  const environment = matchEnvironment(options.method, options.environment);
  if (!environment) {
    return fail(`Unknown environment for ${options.method}.`, {
      missing_inputs: ['environment'],
      environments: Object.keys(ENVIRONMENT_FACTORS[options.method] ?? {}),
    });
  }
  if (!options.parts.length) {
    return fail(
      'No parts for the MTBF estimate. Select the components first, or enter the parts.',
      { missing_inputs: ['parts'] },
    );
  }
  const temps = thermalTemperatures(project);
  const selectedParts: SelectedPart[] = options.parts.map((p) => ({
    id: p.ref,
    manufacturer: p.manufacturer,
    partNumber: p.partNumber,
    description: p.description,
    mountingType: '',
    availability: p.availability ?? '',
    pricingTiers: [],
    datasheetLink: p.datasheetUrl ?? '',
    electricalSpecs: {},
    isSelected: true,
    componentName: p.ref,
    componentType: p.type.toLowerCase(),
    componentId: p.ref,
    isCircuitComponent: true,
    selectionSource: 'suggested',
  }));
  const thermalComponents: ThermalComponent[] = options.parts.map((p) => {
    const t = options.temperatureC ?? temps.get(p.ref);
    return {
      id: p.ref,
      name: p.ref,
      type: 'ic',
      position: { x: 0, y: 0 },
      isSelected: true,
      thermalProperties: {
        thermalResistance: '',
        temperature: finite(t) ? String(Math.round(t)) : '40',
        powerLoss: '',
        voltageStress: '',
        currentStress: '',
        efficiency: '',
        thermalTimeConstant: '',
        maxOperatingTemp: '',
        derating: '',
        coolingRequirement: '',
      },
    };
  });
  const components = calculateMTBFComponents({
    selectedParts,
    thermalComponents,
    predictionMethod: options.method,
    environment,
  });
  const system = calculateSystemMTBF(components);
  const mtbf = Number.isFinite(system.mtbf) ? system.mtbf : null;
  const worst = [...system.componentsWithContributions]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 5);
  return {
    ok: true,
    data: {
      method: options.method,
      environment,
      components: system.componentsWithContributions,
      mtbfHours: mtbf,
      totalFailureRate: system.totalFailureRate,
      temperatureSource:
        options.temperatureC !== undefined
          ? 'entered'
          : temps.size
            ? 'thermal'
            : 'default 40 °C',
      ...provenance(assumed),
    },
    summary: mtbf
      ? `MTBF ${Math.round(mtbf).toLocaleString('en-US')} h`
      : 'MTBF unavailable',
    result: (fork) => ({
      ok: true,
      summary: mtbf
        ? `MTBF ${Math.round(mtbf).toLocaleString('en-US')} h · ${options.method}`
        : 'MTBF could not be computed',
      payload: {
        method: options.method,
        environment,
        mtbf_hours: mtbf,
        mtbf_years: mtbf ? Number((mtbf / 8760).toFixed(1)) : null,
        total_failure_rate: system.totalFailureRate,
        top_contributors: worst.map((c) => ({
          ref: c.designator,
          category: c.category,
          contribution_pct: Number(c.contribution.toFixed(1)),
        })),
        temperatures_from:
          options.temperatureC !== undefined
            ? 'entered temperature'
            : temps.size
              ? 'thermal stage'
              : 'default 40 °C (no thermal result)',
        ...fork,
      },
    }),
  };
}
