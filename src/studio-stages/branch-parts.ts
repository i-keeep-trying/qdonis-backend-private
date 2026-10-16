import { toNumber } from '../circuits/library/circuit-inventory';
import type { MagneticDesign } from '../engines/magnetics/magnetics-engine';
import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { formatSi } from '../visualization/library/visualization-format';
import type { CircuitDataProvider } from './circuit-data.provider';

/**
 * The physical parts of a branch, shared by the MTBF and BOM stages: the
 * circuit inventory (library topology or the edited circuit, with design
 * values), the parts picked in the Simulation device selection and the
 * custom-wound magnetics of the Magnetics stage.
 */

/** Part classes (the reliability engine's categories). */
export const PART_TYPES = [
  'mosfet',
  'diode',
  'inductor',
  'transformer',
  'capacitor',
  'resistor',
  'ic',
] as const;
export type PartType = (typeof PART_TYPES)[number];

/** A hardware part of the branch circuit. */
export interface CircuitPart {
  ref: string;
  type: PartType;
  role: string | null;
  /** Display value ("22 µH"), for passives. */
  value: string | null;
  /** Why the part is not a product part (load, line model, helper), or null. */
  excludedReason: string | null;
}

/** A part picked by the Simulation device selection. */
export interface SelectedDevice {
  part: string;
  manufacturer: string | null;
  family: string | null;
  /** MOSFET, IGBT or Diode. */
  deviceType: string | null;
  vPeakV: number | null;
  vRatingV: number | null;
  iRatingA: number | null;
  /** Co-packaged / companion diode part. */
  diode: string | null;
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

/** Case-insensitive ref key (stage results do not always keep the case). */
export const refKey = (ref: string) => ref.toLowerCase();

/** Library component type -> part class (null: not a hardware part). */
export function partType(type: string): PartType | null {
  const t = type.toLowerCase();
  if (/^(transistor|switch|nmos|pmos|mosfet|igbt)$/.test(t)) return 'mosfet';
  if (t === 'diode') return 'diode';
  if (t === 'inductor' || t === 'coupled_inductor') return 'inductor';
  if (/transformer$/.test(t)) return 'transformer';
  if (t === 'capacitor') return 'capacitor';
  if (t === 'resistor') return 'resistor';
  return null;
}

const LOAD_REFS = new Set(['R_LOAD', 'RLOAD', 'ROUT', 'R_OUT', 'R_DC']);

/**
 * Parts the simulation models but the product does not contain: the load,
 * the source / line impedance, winding resistances and solver helpers, and
 * MOSFET body diodes (part of the switch).
 */
export function defaultExclusion(
  ref: string,
  type: PartType,
  role: string | null,
): string | null {
  const r = ref.toUpperCase();
  const ro = (role ?? '').toLowerCase();
  if (type === 'diode' && ro === 'body_diode') {
    return 'Body diode of a MOSFET (part of the switch)';
  }
  if (type === 'resistor' || type === 'inductor') {
    if (LOAD_REFS.has(r) || /load/.test(ro) || /LOAD/.test(r)) {
      return 'Load (outside the converter)';
    }
  }
  if (type !== 'resistor') return null;
  if (
    /line_impedance/.test(ro) ||
    /^R_?(GRID|LINE|IN)(_|$)/.test(r) ||
    /^RAC_|_SERIES$/.test(r)
  ) {
    return 'Source / line impedance model';
  }
  if (/^R_?(PRI|SEC)$/.test(r) || /ESR/.test(r)) {
    return 'Winding or ESR resistance of another part';
  }
  // R_ISO: ~100 MΩ ground anchor of an isolated side (as in the thermal stage).
  if (
    /ANCHOR|GND|TIE|_DRIVE(_|$)|^R+_?ISO/.test(r) ||
    /anchor|isolation_resistor|ground_tie/.test(ro)
  ) {
    return 'Simulation helper (not a physical part)';
  }
  return null;
}

const VALUE_PARAM: Partial<Record<PartType, [string, string]>> = {
  capacitor: ['capacitance', 'F'],
  resistor: ['resistance', 'Ω'],
  inductor: ['inductance', 'H'],
};

function valueOf(
  type: PartType,
  params: Record<string, unknown>,
): string | null {
  const spec = VALUE_PARAM[type];
  return spec ? formatSi(toNumber(params[spec[0]]), spec[1]) : null;
}

/** Hardware parts of the branch circuit; null when the branch has no circuit. */
export async function circuitParts(
  project: StudioProject,
  provider: CircuitDataProvider,
): Promise<{ parts: CircuitPart[]; fswHz: number | null } | null> {
  const vis = stageNodeOnBranch(project, 'visualization');
  const design = stageNodeOnBranch(project, 'design');
  const sim = stageNodeOnBranch(project, 'simulation');
  const topologyId =
    str(vis?.data.topologyId) ??
    str(design?.data.topologyId) ??
    str(rec(sim?.data.metadata).topology);
  if (!topologyId) return null;
  const inventory = await provider.inventory({
    topologyId,
    circuit: vis?.data.customCircuit,
    recalculated: Array.isArray(design?.data.recalculatedParameters)
      ? (design.data.recalculatedParameters as unknown[])
      : undefined,
  });
  if (!inventory) return null;
  const parts: CircuitPart[] = [];
  const seen = new Set<string>();
  for (const comp of inventory.components) {
    const ref = typeof comp.ref === 'string' ? comp.ref : '';
    const type = partType(String(comp.type ?? ''));
    if (!ref || !type || seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    const role = typeof comp.role === 'string' ? comp.role : null;
    parts.push({
      ref,
      type,
      role,
      value: valueOf(type, comp.params ?? {}),
      excludedReason: defaultExclusion(ref, type, role),
    });
  }
  return { parts, fswHz: inventory.switching_frequency ?? null };
}

/** Parts of the Simulation device selection, by ref key. */
export function selectedDevices(
  project: StudioProject,
): Map<string, SelectedDevice> {
  const sim = stageNodeOnBranch(project, 'simulation');
  const out = new Map<string, SelectedDevice>();
  if (sim?.status !== 'ready') return out;
  for (const choice of records(rec(sim.data.deviceSelection).selections)) {
    const ref = str(choice.ref);
    const selected = rec(choice.selected);
    const part = str(selected.part);
    if (!ref || !part) continue;
    out.set(refKey(ref), {
      part,
      manufacturer: str(selected.manufacturer) ?? null,
      family: str(selected.family) ?? null,
      deviceType: str(selected.type) ?? null,
      vPeakV: fin(rec(choice.stress).vPeakV) ?? null,
      vRatingV: fin(selected.vRatingV) || null,
      iRatingA: fin(selected.iRatingA) || null,
      diode: str(selected.diode) ?? null,
    });
  }
  return out;
}

/** Magnetics designed on the branch, by ref key. */
export function magneticDesigns(
  project: StudioProject,
): Map<string, MagneticDesign> {
  const data = rec(stageNodeOnBranch(project, 'magnetics')?.data);
  const out = new Map<string, MagneticDesign>();
  for (const d of records(data.designs)) {
    const ref = str(d.ref);
    if (ref) out.set(refKey(ref), d as unknown as MagneticDesign);
  }
  return out;
}

/** "PQ26/25 N97 (custom wound)", "2× ETD39 3C95 (custom wound)". */
export const customWound = (design: MagneticDesign): string =>
  `${design.stacked > 1 ? `${design.stacked}× ` : ''}${design.core} ${design.material} (custom wound)`;
