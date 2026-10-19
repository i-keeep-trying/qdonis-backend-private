/**
 * Layouts: positions, wires and grouping of a drawing. The library layout is
 * the topology YAML's `schematic:` section; a project's layout (its moves and
 * edits) is merged over it. Port of the "Library layout" part of qdonis-core
 * `schematic_sync.py`.
 *
 *   schematic:
 *     tuned: true
 *     components: {VIN: {x: 0, y: 0, rotation: 90}, "~VOUT@L1.B": {...}}
 *     wires: [{id: W1, from: VIN.A, to: SW.D}, {id: W2, from: {wire: W1, x: 40, y: 0}, to: C1.A, path: [[40, 0], [40, 80]]}]
 *     groups: {voltage_loop: {label: Voltage loop, members: [E_V, R_V]}}
 *     sheets: {voltage_loop: {wires: [...]}}
 *
 * Pin endpoints are "<component id>.<terminal>" (the id may contain dots, the
 * terminal never does). Block symbols are "#<group>", ports "^<group>:<net>".
 */

import {
  isDict,
  or,
  pyStr,
  toFloat,
  truthy,
  type Dict,
} from '../../simulation/netlist/py';
import type {
  Placement,
  SchematicLayout,
  SchematicSymbol,
  SchematicWire,
  WireEnd,
} from '../schematic.types';
import { snap } from './geometry';
import { flat } from './model';

/** Python `int(value)`; null where Python raises. */
function pyInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number')
    return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string' && /^\s*[-+]?\d+(?:_\d+)*\s*$/.test(value)) {
    return Number(value.replace(/_/g, ''));
  }
  return null;
}

/** Python `float(value)`; null where Python raises. */
function pyFloat(value: unknown): number | null {
  try {
    return toFloat(value);
  } catch {
    return null;
  }
}

const mod360 = (r: number) => ((r % 360) + 360) % 360;

/** A stored position; null when it has no (numeric) position. */
export function placeEntry(p: Dict): Placement | null {
  if (!Object.hasOwn(p, 'x') || !Object.hasOwn(p, 'y')) return null;
  const x = pyFloat(p.x);
  const y = pyFloat(p.y);
  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const rotation = pyInt(or(p.rotation, 0));
  if (rotation === null) return null;
  return {
    x: snap(x),
    y: snap(y),
    rotation: mod360(rotation),
    mirrorX: truthy(p.mirrorX),
    mirrorY: truthy(p.mirrorY),
  };
}

function endpointFromYaml(end: unknown): WireEnd | null {
  if (typeof end === 'string' && end.includes('.')) {
    const cut = end.lastIndexOf('.');
    return {
      type: 'pin',
      compId: end.slice(0, cut),
      terminal: end.slice(cut + 1),
    };
  }
  if (isDict(end) && end.wire !== null && end.wire !== undefined) {
    return {
      type: 'wire',
      wireId: pyStr(end.wire),
      x: toFloat(Object.hasOwn(end, 'x') ? end.x : 0),
      y: toFloat(Object.hasOwn(end, 'y') ? end.y : 0),
    };
  }
  return null;
}

function wiresFromYaml(items: unknown): SchematicWire[] {
  const wires: SchematicWire[] = [];
  for (const w of Array.isArray(items) ? items : []) {
    if (!isDict(w)) continue;
    const from = endpointFromYaml(w.from);
    const to = endpointFromYaml(w.to);
    if (!from || !to) continue;
    const wire: SchematicWire = { id: pyStr(w.id), from, to };
    if (Array.isArray(w.path) && w.path.length >= 2) {
      wire.manualPath = (w.path as unknown[])
        .filter((p): p is unknown[] => Array.isArray(p) && p.length === 2)
        .map((p) => ({ x: toFloat(p[0]), y: toFloat(p[1]) }));
    }
    wires.push(wire);
  }
  return wires;
}

/** The YAML's `schematic:` section as a layout, or null. */
export function libraryLayout(circuit: Dict): SchematicLayout | null {
  const section = circuit.schematic;
  if (!isDict(section)) return null;
  const components: Record<string, Placement> = {};
  const stored = or(section.components, {});
  for (const [cid, p] of Object.entries(isDict(stored) ? stored : {})) {
    const entry = isDict(p) ? placeEntry(p) : null;
    if (entry) components[cid] = entry;
  }
  const out: SchematicLayout = {
    components,
    wires: wiresFromYaml(section.wires),
  };
  if (isDict(section.groups)) {
    out.groups = {};
    for (const [gid, g] of Object.entries(section.groups)) {
      if (!isDict(g)) continue;
      const members = or(g.members, []);
      out.groups[gid] = {
        label: pyStr(or(g.label, gid)),
        members: (Array.isArray(members) ? members : []).map((m) => pyStr(m)),
      };
    }
  }
  if (isDict(section.sheets)) {
    out.sheets = {};
    for (const [gid, sh] of Object.entries(section.sheets)) {
      if (isDict(sh)) out.sheets[gid] = { wires: wiresFromYaml(sh.wires) };
    }
  }
  return out;
}

/**
 * True when a saved layout groups a part the circuit no longer has (the
 * library topology changed after the layout was saved).
 */
export function staleLayout(
  layout: SchematicLayout | null,
  circuit: Dict,
): boolean {
  if (!layout || !isDict(layout.groups)) return false;
  const refs = new Set(flat(circuit).map(([c]) => pyStr(c.ref)));
  for (const g of Object.values(layout.groups as Dict)) {
    if (!isDict(g)) continue;
    const members = or(g.members, []);
    for (const m of Array.isArray(members) ? members : []) {
      if (!refs.has(pyStr(m))) return true;
    }
  }
  return false;
}

/**
 * Project positions win over library positions; wires (per sheet) and the
 * grouping come from the project once it has its own. A stale project
 * layout is dropped for the library layout.
 */
export function mergeLayouts(
  library: SchematicLayout | null,
  project: SchematicLayout | null,
  circuit: Dict | null = null,
): SchematicLayout | null {
  if (circuit && staleLayout(project, circuit)) project = null;
  if (!library) return project;
  const hasOwn =
    project &&
    (truthy(project.components) ||
      (project.groups !== undefined && project.groups !== null));
  if (!project || !hasOwn) return library;
  const out: SchematicLayout = {
    components: {
      ...(library.components ?? {}),
      ...(project.components ?? {}),
    },
    wires: truthy(project.components) ? project.wires : or(library.wires, []),
    sheets: { ...(library.sheets ?? {}), ...(project.sheets ?? {}) },
  };
  const groups = isDict(project.groups) ? project.groups : library.groups;
  if (isDict(groups)) out.groups = groups;
  return out;
}

/** The full layout with one sheet's positions and wires replaced. */
export function setSheetLayout(
  layout: SchematicLayout | null,
  sheet: string | null,
  components: SchematicSymbol[],
  wires: SchematicWire[],
): SchematicLayout {
  const out: SchematicLayout = {
    components: { ...(layout?.components ?? {}) },
    wires: [...(layout?.wires ?? [])],
    sheets: Object.fromEntries(
      Object.entries(layout?.sheets ?? {})
        .filter(([, v]) => isDict(v))
        .map(([k, v]) => [k, { ...v }]),
    ),
  };
  if (isDict(layout?.groups)) out.groups = layout.groups;
  const positions = out.components as Record<string, Placement>;
  for (const c of components) {
    positions[c.id] = {
      x: c.x ?? 0,
      y: c.y ?? 0,
      rotation: c.rotation ?? 0,
      mirrorX: Boolean(c.mirrorX),
      mirrorY: Boolean(c.mirrorY),
    };
  }
  if (sheet === null) out.wires = wires;
  else
    (out.sheets as Record<string, { wires: SchematicWire[] }>)[sheet] = {
      wires,
    };
  return out;
}
