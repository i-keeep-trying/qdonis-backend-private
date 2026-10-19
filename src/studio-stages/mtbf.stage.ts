import { specsOf } from '../design/studio-specs.logic';
import {
  calculateMTBFComponents,
  calculateSystemMTBF,
  ENVIRONMENT_FACTORS,
} from '../engines/reliability/mtbf-calculations';
import type {
  MTBFComponent,
  SelectedPart,
  ThermalComponent,
  ThermalStatus,
} from '../engines/reliability/reliability.types';
import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import {
  byRef,
  circuitParts,
  customWound,
  magneticDesigns,
  PART_TYPES,
  type PartType,
  refKey,
  selectedDevices,
} from './branch-parts';
import type { CircuitDataProvider } from './circuit-data.provider';
import type { StagePlan } from './magnetics.stage';
import { round, specTemperatures, specValue } from './stage-math';

/**
 * MTBF stage (port of the old `MTBFEstimationScreen`). The old screen needed
 * parts picked in Component Selection; here the parts come from the branch
 * circuit, with part numbers from the Simulation device selection and the
 * magnetics designs, and temperatures from the Thermal stage. Parts can also
 * be entered directly (standalone, like magnetics and thermal).
 */

export const MTBF_METHODS = [
  'MIL-HDBK-217F',
  'Telcordia SR-332',
  'IEC TR 62380',
  'FIDES 2022',
] as const;
export type MtbfMethod = (typeof MTBF_METHODS)[number];

/** Part classes of the reliability engine. */
export const MTBF_PART_TYPES = PART_TYPES;
export type MtbfPartType = PartType;

/** A part entered by the user (standalone mode). */
export interface MtbfPartInput {
  ref: string;
  type: MtbfPartType;
  partNumber?: string | null;
  temperatureC?: number | null;
  voltageV?: number | null;
  ratedVoltageV?: number | null;
}

export interface MtbfSettings {
  predictionMethod: MtbfMethod;
  environment: string;
  /** Per-part include (true) / exclude (false), over the default choice. */
  overrides: Record<string, boolean>;
}

export interface MtbfOptions {
  predictionMethod?: MtbfMethod;
  environment?: string;
  /** Merged into the previous overrides; `null` removes one. */
  overrides?: Record<string, boolean | null>;
  /** Entered parts (standalone). */
  parts?: MtbfPartInput[];
  /** Use the branch circuit instead of previously entered parts. */
  fromCircuit?: boolean;
}

type TemperatureSource =
  'thermal' | 'magnetics' | 'ambient' | 'input' | 'assumed';

/** One part as evaluated (the stage's input table). */
export interface MtbfPart {
  ref: string;
  type: MtbfPartType;
  role: string | null;
  partNumber: string | null;
  value: string | null;
  temperatureC: number;
  temperatureSource: TemperatureSource;
  voltageV: number | null;
  ratedVoltageV: number | null;
  /** Simulated RMS current and the current rating, A (devices with a selection). */
  currentA: number | null;
  ratedCurrentA: number | null;
  status: ThermalStatus | null;
  included: boolean;
  /** Why the part is left out by default (load, line model, helper). */
  excludedReason: string | null;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const records = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.map(rec) : [];
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const fin = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const key = refKey;

const fail = (
  summary: string,
  payload?: Record<string, unknown>,
): StagePlan => ({
  ok: false,
  result: { ok: false, summary, ...(payload ? { payload } : {}) },
});

export const environmentsOf = (method: MtbfMethod): string[] =>
  Object.keys(ENVIRONMENT_FACTORS[method]);

const THERMAL_STATUS: Record<string, ThermalStatus> = {
  ok: 'safe',
  warm: 'warning',
  over: 'critical',
};

interface PartContext {
  ambientC: number;
  ambientSource: 'thermal' | 'specs' | 'assumed';
  devices: Map<string, { tjC: number; status: ThermalStatus | null }>;
  magnetics: Map<
    string,
    { hotspotC: number; status: ThermalStatus | null; from: string }
  >;
  stresses: Map<
    string,
    {
      part: string | null;
      vPeakV: number | null;
      vRatingV: number | null;
      iRmsA: number | null;
      iRatingA: number | null;
    }
  >;
  designs: ReturnType<typeof magneticDesigns>;
}

/** Temperatures, stresses and part numbers the branch already has. */
function branchContext(project: StudioProject): PartContext {
  const thermal = rec(stageNodeOnBranch(project, 'thermal')?.data);
  const result = rec(thermal.result);
  const specs = specsOf(stageNodeOnBranch(project, 'specs'));

  const thermalAmbient = Array.isArray(result.devices)
    ? fin(result.ambientC)
    : undefined;
  const specAmbient = specTemperatures(specs).ambientC;
  const ambientC = thermalAmbient ?? specAmbient ?? 40;

  const devices = new Map<
    string,
    { tjC: number; status: ThermalStatus | null }
  >();
  for (const d of records(result.devices)) {
    const ref = str(d.ref);
    const tj = fin(d.tjC);
    if (ref && tj !== undefined) {
      devices.set(key(ref), {
        tjC: tj,
        status: THERMAL_STATUS[String(d.status)] ?? null,
      });
    }
  }
  const magnetics = new Map<
    string,
    { hotspotC: number; status: ThermalStatus | null; from: string }
  >();
  const designs = magneticDesigns(project);
  for (const [k, d] of designs) {
    const hotspot = fin(d.hotspot_C);
    if (hotspot !== undefined) {
      magnetics.set(k, { hotspotC: hotspot, status: null, from: 'magnetics' });
    }
  }
  // The thermal stage's hotspots include its own ambient and status.
  for (const m of records(result.magnetics)) {
    const ref = str(m.ref);
    const hotspot = fin(m.hotspotC);
    if (ref && hotspot !== undefined) {
      magnetics.set(key(ref), {
        hotspotC: hotspot,
        status: THERMAL_STATUS[String(m.status)] ?? null,
        from: 'thermal',
      });
    }
  }
  const stresses = new Map(
    [...selectedDevices(project)].map(([k, d]) => [
      k,
      {
        part: d.part,
        vPeakV: d.vPeakV,
        vRatingV: d.vRatingV,
        iRmsA: d.iRmsA,
        iRatingA: d.iRatingA,
      },
    ]),
  );
  return {
    ambientC,
    ambientSource:
      thermalAmbient !== undefined
        ? 'thermal'
        : specAmbient !== null
          ? 'specs'
          : 'assumed',
    devices,
    magnetics,
    stresses,
    designs,
  };
}

/** Temperature and stress of one part from the branch results. */
function operatingPoint(
  ctx: PartContext,
  ref: string,
  type: MtbfPartType,
): Pick<
  MtbfPart,
  | 'temperatureC'
  | 'temperatureSource'
  | 'status'
  | 'voltageV'
  | 'ratedVoltageV'
  | 'currentA'
  | 'ratedCurrentA'
  | 'partNumber'
> {
  const ambient = {
    temperatureC: ctx.ambientC,
    temperatureSource:
      ctx.ambientSource === 'assumed'
        ? ('assumed' as const)
        : ('ambient' as const),
    status: null,
  };
  const stress = byRef(ctx.stresses, ref);
  const electrical = {
    voltageV: stress?.vPeakV ?? null,
    ratedVoltageV: stress?.vRatingV ?? null,
    currentA: stress?.iRmsA ?? null,
    ratedCurrentA: stress?.iRatingA ?? null,
  };
  if (type === 'mosfet' || type === 'diode') {
    const device = byRef(ctx.devices, ref);
    return {
      ...(device
        ? {
            temperatureC: device.tjC,
            temperatureSource: 'thermal' as const,
            status: device.status,
          }
        : ambient),
      ...electrical,
      partNumber: stress?.part ?? null,
    };
  }
  if (type === 'inductor' || type === 'transformer') {
    const mag = byRef(ctx.magnetics, ref);
    const design = byRef(ctx.designs, ref);
    return {
      ...(mag
        ? {
            temperatureC: mag.hotspotC,
            temperatureSource:
              mag.from === 'thermal'
                ? ('thermal' as const)
                : ('magnetics' as const),
            status: mag.status,
          }
        : ambient),
      voltageV: null,
      ratedVoltageV: null,
      currentA: null,
      ratedCurrentA: null,
      partNumber: design ? customWound(design) : null,
    };
  }
  return {
    ...ambient,
    voltageV: null,
    ratedVoltageV: null,
    currentA: null,
    ratedCurrentA: null,
    partNumber: null,
  };
}

/** Parts of the branch circuit with their operating points. */
async function circuitPartsAt(
  project: StudioProject,
  ctx: PartContext,
  provider: CircuitDataProvider,
): Promise<{
  parts: Array<Omit<MtbfPart, 'included'>>;
  fswHz: number | null;
} | null> {
  const circuit = await circuitParts(project, provider);
  if (!circuit) return null;
  return {
    parts: circuit.parts.map((p) => ({
      ...p,
      ...operatingPoint(ctx, p.ref, p.type),
    })),
    fswHz: circuit.fswHz,
  };
}

function enteredParts(
  inputs: MtbfPartInput[],
  ctx: PartContext,
): Array<Omit<MtbfPart, 'included'>> {
  return inputs.map((p) => {
    const branch = operatingPoint(ctx, p.ref, p.type);
    const temperature = fin(p.temperatureC);
    return {
      ref: p.ref,
      type: p.type,
      role: null,
      value: null,
      ...branch,
      ...(temperature !== undefined
        ? {
            temperatureC: temperature,
            temperatureSource: 'input' as const,
            status: null,
          }
        : {}),
      partNumber: str(p.partNumber) ?? branch.partNumber,
      voltageV: fin(p.voltageV) ?? branch.voltageV,
      ratedVoltageV: fin(p.ratedVoltageV) ?? branch.ratedVoltageV,
      excludedReason: null,
    };
  });
}

/** Runs the reliability engine on the included parts. */
export function evaluateMtbf(
  parts: MtbfPart[],
  method: MtbfMethod,
  environment: string,
  fswHz: number | null,
): {
  components: MTBFComponent[];
  mtbfHours: number | null;
  failureRateFit: number;
} {
  const included = parts.filter((p) => p.included);
  const selectedParts: SelectedPart[] = included.map((p) => ({
    id: p.ref,
    manufacturer: '',
    partNumber: p.partNumber ?? p.value ?? '',
    description: '',
    mountingType: '',
    availability: '',
    pricingTiers: [],
    datasheetLink: '',
    electricalSpecs: {},
    isSelected: true,
    componentName: p.ref,
    componentType: p.type,
    componentId: p.ref,
    isCircuitComponent: true,
    selectionSource: 'suggested',
  }));
  const thermalComponents: ThermalComponent[] = included.map((p) => ({
    id: p.ref,
    name: p.ref,
    type: p.type,
    position: { x: 0, y: 0 },
    isSelected: true,
    thermalProperties: {
      thermalResistance: '',
      temperature: String(p.temperatureC),
      powerLoss: '',
      voltageStress: '',
      currentStress: '',
      efficiency: '',
      thermalTimeConstant: '',
      maxOperatingTemp: '',
      derating: '',
      coolingRequirement: '',
      ...(p.voltageV !== null ? { peakVoltage: String(p.voltageV) } : {}),
      ...(p.ratedVoltageV !== null
        ? { ratedVoltage: String(p.ratedVoltageV) }
        : {}),
      ...(p.currentA != null && p.ratedCurrentA != null
        ? {
            rmsCurrent: String(p.currentA),
            ratedCurrent: String(p.ratedCurrentA),
          }
        : {}),
      ...(p.status ? { thermalStatus: p.status } : {}),
    },
  }));
  const components = calculateMTBFComponents({
    selectedParts,
    thermalComponents,
    predictionMethod: method,
    environment,
    switchingFrequency: fswHz ?? undefined,
  });
  const system = calculateSystemMTBF(components);
  return {
    components: system.componentsWithContributions,
    mtbfHours: system.mtbf > 0 ? system.mtbf : null,
    failureRateFit: system.totalFailureRate,
  };
}

const hours = (h: number | null): string =>
  h === null
    ? '—'
    : h >= 1e6
      ? `${(h / 1e6).toPrecision(3)} M h`
      : `${Math.round(h).toLocaleString('en-US')} h`;

export async function planMtbf(
  project: StudioProject,
  options: MtbfOptions,
  provider: CircuitDataProvider,
): Promise<StagePlan> {
  const previous = rec(stageNodeOnBranch(project, 'mtbf')?.data);
  const prevSettings = rec(previous.settings);
  const prevInputs = Array.isArray(previous.inputs)
    ? (previous.inputs as MtbfPartInput[])
    : null;

  const method: MtbfMethod =
    options.predictionMethod ??
    (MTBF_METHODS.includes(prevSettings.predictionMethod as MtbfMethod)
      ? (prevSettings.predictionMethod as MtbfMethod)
      : 'MIL-HDBK-217F');
  const environments = environmentsOf(method);
  const environment =
    options.environment ??
    (method === prevSettings.predictionMethod &&
    environments.includes(String(prevSettings.environment))
      ? String(prevSettings.environment)
      : environments[0]);
  if (!environments.includes(environment)) {
    return fail(`"${environment}" is not an environment of ${method}.`, {
      environments,
    });
  }
  const overrides: Record<string, boolean> = Object.fromEntries(
    Object.entries(rec(prevSettings.overrides)).filter(
      (e): e is [string, boolean] => typeof e[1] === 'boolean',
    ),
  );
  for (const [ref, include] of Object.entries(options.overrides ?? {})) {
    if (include === null) delete overrides[ref];
    else overrides[ref] = include;
  }

  const entered: MtbfPartInput[] | null = options.parts?.length
    ? options.parts
    : !options.fromCircuit && previous.origin === 'input' && prevInputs?.length
      ? prevInputs
      : null;

  const ctx = branchContext(project);
  const specs = specsOf(stageNodeOnBranch(project, 'specs'));
  const specFsw = specValue(specs, /switching freq|fsw/i);
  let rawParts: Array<Omit<MtbfPart, 'included'>>;
  let fswHz: number | null;
  if (entered) {
    rawParts = enteredParts(entered, ctx);
    fswHz = specFsw;
  } else {
    const circuit = await circuitPartsAt(project, ctx, provider);
    if (!circuit) {
      return fail(
        'There is no circuit on this branch, so give the parts directly: call run_mtbf with `parts` (ref, type, and optionally part_number, temperature_c, voltage_v, rated_voltage_v). No design or simulation is needed for that.',
        {
          missing: 'parts',
          example: {
            parts: [
              { ref: 'Q1', type: 'mosfet', temperature_c: 95 },
              { ref: 'D1', type: 'diode' },
              { ref: 'L1', type: 'inductor' },
              { ref: 'C1', type: 'capacitor' },
            ],
          },
        },
      );
    }
    rawParts = circuit.parts;
    fswHz = circuit.fswHz ?? specFsw;
  }

  const refs = new Set(rawParts.map((p) => p.ref));
  const parts: MtbfPart[] = rawParts.map((p) => ({
    ...p,
    included: overrides[p.ref] ?? p.excludedReason === null,
  }));
  // Overrides of parts that are no longer in the circuit are dropped.
  for (const ref of Object.keys(overrides)) {
    if (!refs.has(ref)) delete overrides[ref];
  }
  if (!parts.some((p) => p.included)) {
    return fail('No parts are included in the MTBF estimate.', {
      missing: 'parts',
      excluded: parts.map((p) => p.ref),
    });
  }

  const primary = evaluateMtbf(parts, method, environment, fswHz);
  const byMethod = MTBF_METHODS.map((m) => {
    const env = m === method ? environment : environmentsOf(m)[0];
    return {
      method: m,
      environment: env,
      mtbfHours:
        m === method
          ? primary.mtbfHours
          : evaluateMtbf(parts, m, env, fswHz).mtbfHours,
    };
  });
  const issues = primary.components
    .filter((c) => c.status === 'warning' || c.status === 'critical')
    .map((c) => ({
      ref: c.designator,
      severity: c.status,
      issue:
        c.status === 'critical'
          ? 'operating at critical temperature or stress level'
          : 'operating at elevated temperature',
    }));

  const assumptions: string[] = [];
  const included = parts.filter((p) => p.included);
  if (ctx.ambientSource === 'assumed') {
    assumptions.push(
      'Ambient temperature is not in the specs: 40 °C assumed for parts without a thermal result.',
    );
  }
  const atAmbient = included.filter(
    (p) =>
      (p.type === 'mosfet' || p.type === 'diode') &&
      p.temperatureSource !== 'thermal' &&
      p.temperatureSource !== 'input',
  );
  if (atAmbient.length) {
    assumptions.push(
      `${atAmbient.map((p) => p.ref).join(', ')} evaluated at ambient: run the Thermal stage for junction temperatures.`,
    );
  }
  const noStress = included.filter(
    (p) => (p.type === 'mosfet' || p.type === 'diode') && p.voltageV === null,
  );
  if (noStress.length) {
    assumptions.push(
      `${noStress.map((p) => p.ref).join(', ')}: no simulated voltage stress (generic 20 V of a 30 V rating); simulate and select devices for real derating.`,
    );
  }
  const withCurrent = included.filter(
    (p) => p.currentA != null && p.ratedCurrentA != null,
  );
  assumptions.push(
    withCurrent.length
      ? `Current stress: simulated RMS current over the selected device's rating for ${withCurrent.length} part(s); the engine default (3 A of a 4.5 A rating) for the others.`
      : 'Current stress uses the engine default (3 A of a 4.5 A rating) for every part.',
  );
  if (fswHz === null) {
    assumptions.push('Switching frequency unknown: 200 kHz assumed.');
  }

  const data = JSON.parse(
    JSON.stringify({
      origin: entered ? 'input' : 'circuit',
      settings: { predictionMethod: method, environment, overrides },
      inputs: entered,
      parts,
      ambientC: ctx.ambientC,
      switchingFrequencyHz: fswHz,
      result: {
        mtbfHours: primary.mtbfHours,
        failureRateFit: primary.failureRateFit,
        components: primary.components,
        byMethod,
        issues,
      },
      assumptions,
    }),
  ) as Record<string, unknown>;

  const top = [...primary.components]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 5);
  return {
    ok: true,
    data,
    summary: `MTBF ${hours(primary.mtbfHours)} · ${primary.failureRateFit} FIT`,
    result: (fork) => ({
      ok: true,
      summary: `MTBF · ${hours(primary.mtbfHours)} (${method}, ${environment})`,
      payload: {
        mode: entered
          ? 'standalone (entered parts)'
          : 'parts of the circuit on the active branch',
        prediction_method: method,
        environment,
        mtbf_hours: primary.mtbfHours,
        mtbf_years_continuous:
          primary.mtbfHours === null
            ? null
            : round(primary.mtbfHours / 8760, 1),
        failure_rate_fit: primary.failureRateFit,
        parts_evaluated: included.length,
        top_contributors: top.map((c) => ({
          ref: c.designator,
          category: c.category,
          part: c.partNumber || undefined,
          fit: c.lambda,
          contribution_pct: c.contribution,
        })),
        by_method: byMethod.map((m) => ({
          method: m.method,
          environment: m.environment,
          mtbf_hours: m.mtbfHours,
        })),
        issues,
        excluded: parts
          .filter((p) => !p.included)
          .map((p) => ({
            ref: p.ref,
            reason: p.excludedReason ?? 'excluded by the user',
          })),
        assumptions,
        ...fork,
      },
    }),
  };
}
