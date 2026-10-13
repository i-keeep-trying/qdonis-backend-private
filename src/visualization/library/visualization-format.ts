import type { CircuitInventory } from '../../circuits/circuits.types';
import { jsonText } from '../../common/python/python-semantics';
import type {
  DisplayInventory,
  EngineCircuit,
  EngineComponent,
  EngineEndpoint,
  EngineWire,
} from '../visualization.types';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const text = jsonText;

const ROTATIONS = new Set([0, 90, 180, 270]);

function endpoint(value: unknown): EngineEndpoint | null {
  if (!isObject(value)) return null;
  if (value.type === 'point')
    return { type: 'point', x: num(value.x), y: num(value.y) };
  if (typeof value.compId === 'string' && typeof value.terminal === 'string') {
    return { type: 'pin', compId: value.compId, terminal: value.terminal };
  }
  return null;
}

/**
 * Library schematic -> engine circuit. Drops editor-only keys (`params`
 * duplicate, `lastClickTime`, `manualPath`, `fromComp`, ...) and fills the
 * mirror flags the library files omit.
 */
export function toEngineCircuit(schematic: unknown): EngineCircuit | null {
  if (!isObject(schematic) || !Array.isArray(schematic.components)) return null;
  const components: EngineComponent[] = [];
  for (const comp of schematic.components) {
    if (!isObject(comp) || typeof comp.id !== 'string') continue;
    const rotation = num(comp.rotation);
    const parameters: Record<string, string> = {};
    if (isObject(comp.parameters)) {
      for (const [key, value] of Object.entries(comp.parameters)) {
        parameters[key] = text(value);
      }
    }
    components.push({
      id: comp.id,
      type: text(comp.type),
      x: num(comp.x),
      y: num(comp.y),
      rotation: (ROTATIONS.has(rotation)
        ? rotation
        : 0) as EngineComponent['rotation'],
      mirrorX: comp.mirrorX === true,
      mirrorY: comp.mirrorY === true,
      parameters,
    });
  }
  const wires: EngineWire[] = [];
  for (const wire of Array.isArray(schematic.wires) ? schematic.wires : []) {
    if (!isObject(wire) || typeof wire.id !== 'string') continue;
    const from = endpoint(wire.from);
    const to = endpoint(wire.to);
    if (from && to) wires.push({ id: wire.id, from, to });
  }
  return { components, wires };
}

const PREFIXES: Array<[number, string]> = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
];

/** 2.2e-5, 'H' -> '22 µH' (three significant digits). */
export function formatSi(value: number | null, unit: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value === 0) return `0 ${unit}`.trim();
  const magnitude = Math.abs(value);
  const [scale, prefix] =
    PREFIXES.find(([factor]) => magnitude >= factor) ??
    PREFIXES[PREFIXES.length - 1];
  const scaled = Number((value / scale).toPrecision(3));
  return `${scaled} ${prefix}${unit}`.trim();
}

/** Core inventory (numbers, snake_case) -> the Circuit tab's display strings. */
export function toDisplayInventory(
  inventory: CircuitInventory,
): DisplayInventory {
  return {
    components: inventory.components.map((comp) => ({
      ref: text(comp.ref),
      type: text(comp.type),
      role:
        comp.role === null || comp.role === undefined ? null : text(comp.role),
      params: Object.fromEntries(
        Object.entries(comp.params).map(([key, value]) => [key, text(value)]),
      ),
    })),
    magnetics: inventory.magnetics.map((part) => ({
      ref: text(part.ref),
      type: part.type,
      role:
        part.role === null || part.role === undefined ? null : text(part.role),
      inductance: formatSi(part.inductance ?? part.magnetizing_inductance, 'H'),
      turnsRatio:
        part.turns_ratio === null
          ? null
          : String(Number(part.turns_ratio.toPrecision(4))),
      saturationCurrent: formatSi(part.saturation_current, 'A'),
    })),
    switchingFrequency: formatSi(inventory.switching_frequency, 'Hz'),
    inputVoltage: formatSi(inventory.input_voltage, 'V'),
  };
}
