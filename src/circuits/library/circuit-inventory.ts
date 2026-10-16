import { PY_WHITESPACE } from '../../common/python/python-json';
import { jsonText, pyStrKey } from '../../common/python/python-semantics';
import { pyStr, truthy } from '../../simulation/netlist/py';
import type {
  OutputVoltageTarget,
  PowerSource,
} from '../../studio-stages/circuit-data.provider';
import type { CircuitInventory } from '../circuits.types';

/**
 * Circuit inventory, ported from qdonis-core `studio_circuit.py`
 * (`to_number`, `iter_components`, `apply_updates`, `_switching_frequency`,
 * `circuit_inventory`). Pure functions over a topology YAML dict.
 */

type Json = Record<string, unknown>;

export const MAGNETIC_TYPES = new Set([
  'inductor',
  'transformer',
  'ct_transformer',
  'dual_ct_transformer',
  'coupled_inductor',
]);

const SI: Record<string, number> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  k: 1e3,
  meg: 1e6,
  g: 1e9,
};

const NUMBER = new RegExp(
  `^[${PY_WHITESPACE}]*([-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?)[${PY_WHITESPACE}]*(meg|[fpnuµmkg])?`,
  'iu',
);

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScalarKey = (
  value: unknown,
): value is string | number | boolean | null | undefined =>
  value === null ||
  value === undefined ||
  ['string', 'number', 'boolean'].includes(typeof value);

/** Parses 47u, 4.7e-5, '100 kHz', 1e5 into a number; null when it is not one. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const match = NUMBER.exec(value);
  if (!match) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  return Number(match[1]) * (SI[suffix] ?? 1);
}

/** Every component, nested `internal` parts included, with its parent ref. */
export function* iterComponents(
  components: unknown,
  parent: unknown = null,
): Generator<[Json, unknown]> {
  if (!Array.isArray(components)) return;
  for (const comp of components) {
    if (!isObject(comp)) continue;
    yield [comp, parent];
    yield* iterComponents(comp.internal ?? [], comp.ref ?? null);
  }
}

const paramsOf = (comp: Json): Json =>
  isObject(comp.params) ? comp.params : {};

/** Applies `[{ref, param, after}]` design values onto the dict (in place). */
export function applyUpdates(yamlDict: Json, recalculated: unknown): Json {
  if (!Array.isArray(recalculated) || recalculated.length === 0)
    return yamlDict;
  const updates = new Map<string, Map<string, unknown>>();
  for (const row of recalculated) {
    if (!isObject(row)) continue;
    const { ref, param, after } = row;
    if (!ref || !param || after === null || after === undefined) continue;
    if (!isScalarKey(ref) || !isScalarKey(param)) continue;
    const key = pyStrKey(ref);
    if (!updates.has(key)) updates.set(key, new Map());
    updates.get(key)?.set(pyStrKey(param), after);
  }
  for (const [comp] of iterComponents(yamlDict.components)) {
    if (!isScalarKey(comp.ref)) continue;
    const changes = updates.get(pyStrKey(comp.ref));
    if (!changes) continue;
    if (!isObject(comp.params)) comp.params = {};
    const params = comp.params as Json;
    for (const [param, value] of changes) params[param] = value;
  }
  return yamlDict;
}

const lowerStr = (value: unknown): string =>
  value === null || value === undefined || value === false || value === ''
    ? ''
    : jsonText(value).toLowerCase();

/** Most frequent switching frequency in the circuit (PWM sources count double). */
export function switchingFrequency(yamlDict: Json): number | null {
  const candidates: number[] = [];
  for (const [comp] of iterComponents(yamlDict.components)) {
    const params = paramsOf(comp);
    const role = lowerStr(comp.role);
    const nodeType = lowerStr(params.node_type);
    const weight =
      nodeType.includes('pwm') ||
      role.includes('pwm') ||
      role.includes('carrier')
        ? 2
        : 1;
    for (const key of [
      'frequency',
      'fsw',
      'switching_frequency',
      'carrier_frequency',
      'f_sw',
    ]) {
      const value = toNumber(params[key]);
      if (value && value >= 1e3) {
        for (let i = 0; i < weight; i += 1) candidates.push(value);
      }
    }
    // Pulse sources (PWM / triangle carriers) are defined by their period.
    if (lowerStr(params.source) === 'pulse' || nodeType.includes('pwm')) {
      const period = toNumber(params.per || params.period);
      if (period && period > 1e-8 && period <= 1e-3) {
        const value = Number((1 / period).toFixed(6));
        for (let i = 0; i < weight; i += 1) candidates.push(value);
      }
    }
  }
  if (candidates.length === 0) return null;
  const counts = new Map<number, number>();
  for (const value of candidates)
    counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = candidates[0];
  for (const [value, count] of counts) {
    if (count > (counts.get(best) ?? 0)) best = value;
  }
  return best;
}

const INVENTORY_NODE_TYPES = new Set([
  'voltage_source',
  'current_source',
  'pwm_control',
]);

/** What is in the circuit: components, magnetics, fsw and input voltage. */
export function circuitInventory(yamlDict: Json): CircuitInventory {
  const components: CircuitInventory['components'] = [];
  const magnetics: CircuitInventory['magnetics'] = [];
  for (const [comp, parent] of iterComponents(yamlDict.components)) {
    const params = paramsOf(comp);
    const type = comp.type ?? null;
    if (
      type === 'node' &&
      !INVENTORY_NODE_TYPES.has(String(params.node_type))
    ) {
      continue;
    }
    const keyParams: Json = {};
    for (const [key, value] of Object.entries(params).slice(0, 6)) {
      if (typeof value !== 'object' || value === null) keyParams[key] = value;
    }
    components.push({
      ref: comp.ref ?? null,
      type,
      role: comp.role ?? null,
      inside: parent ?? null,
      params: keyParams,
    });
    if (typeof type === 'string' && MAGNETIC_TYPES.has(type)) {
      magnetics.push({
        ref: comp.ref ?? null,
        type,
        role: comp.role ?? null,
        inductance: toNumber(params.inductance),
        magnetizing_inductance: toNumber(params.Lm_primary),
        turns_ratio: toNumber(params.turns_ratio),
        coupling: toNumber(params.k_coupling || params.coupling_coefficient),
        saturation_current: toNumber(params.saturation_current),
      });
    }
  }

  let inputVoltage: number | null = null;
  for (const [comp] of iterComponents(yamlDict.components)) {
    const params = paramsOf(comp);
    const role = jsonText(comp.role);
    if (params.node_type === 'voltage_source' && role.startsWith('input')) {
      inputVoltage = toNumber(params.voltage || params.amplitude);
      break;
    }
  }

  return {
    id: yamlDict.id ?? null,
    name: yamlDict.name ?? null,
    components,
    magnetics,
    switching_frequency: switchingFrequency(yamlDict),
    input_voltage: inputVoltage,
    power_sources: powerSources(yamlDict),
    output_voltage: outputVoltageTarget(yamlDict),
    load_resistance: loadResistance(yamlDict),
  };
}

/** Python `str(value or "")`. */
const textOr = (value: unknown): string => (truthy(value) ? pyStr(value) : '');
/** Python `a or b`. */
const or = (a: unknown, b: unknown): unknown => (truthy(a) ? a : b);

const CONTROL_SOURCE =
  /sense|ref|tri|carrier|ramp|pwm|ff|feedforward|gate|drive/i;

/** Power voltage sources (not sense / reference / carrier sources): DC value or AC peak and frequency. */
function powerSources(yamlDict: Json): PowerSource[] {
  const sources: PowerSource[] = [];
  for (const [comp] of iterComponents(yamlDict.components)) {
    const params = paramsOf(comp);
    if (params.node_type !== 'voltage_source') continue;
    const ref = textOr(comp.ref);
    const role = textOr(comp.role);
    if (CONTROL_SOURCE.test(ref) || CONTROL_SOURCE.test(role)) continue;
    const kind = pyStr(or(params.source, 'dc')).toLowerCase();
    if (kind === 'sine' || kind === 'sin' || kind === 'ac') {
      const peak = toNumber(or(params.amplitude, params.voltage));
      if (peak) {
        sources.push({
          ref,
          role: role || null,
          kind: 'ac',
          peak,
          frequency: toNumber(params.frequency),
        });
      }
    } else if (kind === 'dc') {
      const value = toNumber(params.voltage);
      if (value) sources.push({ ref, role: role || null, kind: 'dc', value });
    }
  }
  return sources;
}

const VOUT_KEYS = [
  'target_vout',
  'target_vout_rms',
  'vout_target',
  'target_output_voltage',
  'vout_nominal',
];

/** Output-voltage target from the analysis criteria (`target_vout` …), if the template defines one. */
function outputVoltageTarget(yamlDict: Json): OutputVoltageTarget | null {
  const analyses = isObject(yamlDict.analysis) ? yamlDict.analysis : {};
  for (const analysis of Object.values(analyses)) {
    const requirements = isObject(analysis) ? analysis.requirements : null;
    if (!Array.isArray(requirements)) continue;
    for (const req of requirements) {
      const criteria =
        isObject(req) && isObject(req.criteria) ? req.criteria : {};
      for (const key of VOUT_KEYS) {
        const value = toNumber(criteria[key]);
        if (value !== null) return { value, rms: key.endsWith('_rms'), key };
      }
    }
  }
  return null;
}

const LOAD_REFS = new Set(['R_LOAD', 'RLOAD', 'ROUT', 'R_OUT', 'R_DC']);

function loadResistance(yamlDict: Json): number | null {
  for (const [comp] of iterComponents(yamlDict.components)) {
    if (comp.type !== 'resistor') continue;
    const ref = textOr(comp.ref).toUpperCase();
    const role = textOr(comp.role).toLowerCase();
    if (LOAD_REFS.has(ref) || role.includes('load')) {
      const value = toNumber(paramsOf(comp).resistance);
      if (value) return value;
    }
  }
  return null;
}
