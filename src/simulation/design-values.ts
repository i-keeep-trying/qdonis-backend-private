/**
 * Design value edits, ported from qdonis-core
 * `topology_improver.apply_parameter_updates_to_yaml` (as used by
 * `/api/simulate/sync_parameters`).
 */

import { generateNetlist } from './netlist/netlist-generator';
import { fmt, isDict, type Dict } from './netlist/py';
import type { DeckKind, RecalculatedParameter } from './simulation.types';

/** Keys never written into a component's params (core `BANNED_KEYS`). */
const BANNED_KEYS = new Set([
  'constraint',
  'constraints',
  'note',
  'notes',
  'comment',
  'comments',
  'description',
  'reason',
  'reasoning',
  'unit',
  'units',
  '_reasoning',
]);

/** `_iter_all_components`: components plus nested `internal` parts. */
function allComponents(components: unknown): Dict[] {
  const out: Dict[] = [];
  const walk = (list: unknown, depth: number): void => {
    if (depth > 12 || !Array.isArray(list)) return;
    for (const comp of list) {
      if (!isDict(comp)) continue;
      out.push(comp);
      walk(comp.internal, depth + 1);
    }
  };
  walk(components, 0);
  return out;
}

const refOf = (comp: Dict): unknown => comp.ref ?? comp.id;

/** {ref: [components]} over the whole design. */
function componentsByRef(design: Dict): Map<string, Dict[]> {
  const map = new Map<string, Dict[]>();
  for (const comp of allComponents(design.components)) {
    const ref = refOf(comp);
    if (typeof ref !== 'string') continue;
    const list = map.get(ref) ?? [];
    list.push(comp);
    map.set(ref, list);
  }
  return map;
}

/** The params dict of a component, created like core when missing. */
function paramsOf(comp: Dict): Dict {
  const key = 'parameters' in comp ? 'parameters' : 'params';
  if (isDict(comp[key])) return comp[key];
  const params: Dict = {};
  comp['id' in comp && !('ref' in comp) ? 'parameters' : 'params'] = params;
  return params;
}

/**
 * Applies `{ref: {param: value}}` in place; unknown refs are skipped like
 * core. Returns the number of refs applied.
 */
export function applyParameterUpdates(
  design: Dict,
  updates: Map<string, Map<string, string>>,
): number {
  const byRef = componentsByRef(design);
  let applied = 0;
  for (const [ref, params] of updates) {
    const targets = byRef.get(ref);
    if (!targets || params.size === 0) continue;
    for (const comp of targets) {
      const into = paramsOf(comp);
      for (const [key, value] of params) {
        if (!BANNED_KEYS.has(key.toLowerCase())) into[key] = value;
      }
    }
    applied += 1;
  }
  return applied;
}

/**
 * Decks as `/api/simulate/sync_parameters` builds them: the base netlist
 * plus each non-empty control block, LF line ends.
 */
export function syncedDecks(design: Dict): Partial<Record<DeckKind, string>> {
  const { netlist, controls } = generateNetlist(design, null);
  const decks: Partial<Record<DeckKind, string>> = {};
  for (const kind of ['dc', 'ac', 'transient'] as const) {
    const control = controls[kind] ?? '';
    if (control.trim()) {
      decks[kind] = `${netlist}\n${control}`.replace(/\r\n?/g, '\n');
    }
  }
  return decks;
}

/** Main value of each component kind shown in the design table. */
const PRIMARY: Record<string, Array<[string, string | null]>> = {
  inductor: [['inductance', 'H']],
  capacitor: [['capacitance', 'F']],
  resistor: [['resistance', 'Ω']],
  voltage_source: [['voltage', 'V']],
  pwm_control: [
    ['frequency', 'Hz'],
    ['duty_cycle', null],
  ],
};

/** Library values of the design's main parameters (before = after). */
export function designParameters(design: Dict): RecalculatedParameter[] {
  const rows: RecalculatedParameter[] = [];
  for (const comp of allComponents(design.components)) {
    const ref = refOf(comp);
    if (typeof ref !== 'string') continue;
    const params = isDict(comp.params)
      ? comp.params
      : isDict(comp.parameters)
        ? comp.parameters
        : {};
    const kind = comp.type === 'node' ? params.node_type : comp.type;
    for (const [param, unit] of PRIMARY[String(kind)] ?? []) {
      if (!(param in params)) continue;
      const value = fmt(params[param]);
      rows.push({ ref, param, before: value, after: value, unit });
    }
  }
  return rows;
}

/** Whether a component with `ref` exists in the design. */
export function hasComponent(design: Dict, ref: string): boolean {
  return componentsByRef(design).has(ref);
}

/** Current value of a param, formatted like the design table. */
export function currentValue(
  design: Dict,
  ref: string,
  param: string,
): string | null {
  const comp = componentsByRef(design).get(ref)?.[0];
  if (!comp) return null;
  const params = paramsOf({ ...comp });
  return param in params ? fmt(params[param]) : null;
}

/** Rows whose value differs from the template's, as `{ref: {param: after}}`. */
export function rowUpdates(
  rows: readonly RecalculatedParameter[],
): Map<string, Map<string, string>> {
  // Only changed rows: the table shows rounded values (6 digits).
  const updates = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (row.after === row.before) continue;
    const params = updates.get(row.ref) ?? new Map<string, string>();
    params.set(row.param, row.after);
    updates.set(row.ref, params);
  }
  return updates;
}

/**
 * A design brought over to an edited circuit: its values are kept (with the
 * values edited in the schematic), rows of removed parts dropped, and the
 * decks regenerated from the edited circuit, so the next simulation runs
 * exactly the circuit that is drawn.
 */
export function carriedDesignValues(
  rows: readonly RecalculatedParameter[],
  circuit: Dict,
  edits: ReadonlyArray<{ ref: string; param: string; value: string }>,
): {
  recalculatedParameters: RecalculatedParameter[];
  decks: Partial<Record<DeckKind, string>>;
} {
  const kept = rows
    .filter((row) => hasComponent(circuit, row.ref))
    .map((row) => {
      const edit = edits.find(
        (e) => e.ref === row.ref && e.param === row.param,
      );
      return edit
        ? { ...row, before: row.after, after: edit.value }
        : { ...row };
    });
  const design = structuredClone(circuit);
  applyParameterUpdates(design, rowUpdates(kept));
  return { recalculatedParameters: kept, decks: syncedDecks(design) };
}
