/**
 * Drawing -> YAML: an edited drawing of one sheet becomes a circuit change
 * (value edits, removed / added / copied parts, rewiring), validated by
 * generating the netlist. Only that sheet's parts are in scope; block pins /
 * ports stand for the nets that cross the sheet boundary. Port of
 * `apply_schematic` of qdonis-core `schematic_sync.py`.
 */

import {
  applyUpdates,
  iterComponents,
} from '../../circuits/library/circuit-inventory';
import { pythonStrip } from '../../common/python/python-json';
import { generateNetlist } from '../../simulation/netlist/netlist-generator';
import { isDict, pyRepr, pyStr, type Dict } from '../../simulation/netlist/py';
import type {
  SchematicLayout,
  SchematicSymbol,
  SchematicWire,
} from '../schematic.types';
import { setSheetLayout } from './layout';
import {
  buildSymbols,
  cmpStr,
  connectivity,
  flat,
  netsByName,
  sortedStr,
  type Pin,
} from './model';
import { membership, resolveGroups, sheetView, type Sheet } from './sheets';
import { ANY, PALETTE_BY_TYPE, symbolFor } from './symbols';
import { coerce, displayText, fmtParam } from './values';
import { SheetNotFoundError } from './render';

export interface ParamChange {
  ref: string;
  param: string;
  value: string;
  before: string | null;
}

export interface ApplyResult {
  /** Only positions / wire routes changed: nothing that is simulated. */
  layout_only: boolean;
  /** The new circuit (design values not folded in). */
  circuit: Dict;
  /** The full layout with this sheet updated. */
  layout: SchematicLayout;
  /** Edits of values the design table owns. */
  param_changes: ParamChange[];
  added: string[];
  removed: string[];
  rewired: boolean;
  changes: string[];
  errors: string[];
}

const DEFAULT_SW_MODEL = (name: string) =>
  `.model ${name} SW(vt=2.5 vh=0.1 ron=10m roff=1MEG)`;
const REF_OK = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A net member as the YAML writes it: `ref` or `[ref, pin]`. */
type Member = string | [string, string];
const memberKey = (m: Member): Pin =>
  typeof m === 'string' ? [m, ''] : [m[0], m[1]];
const memberRef = (m: unknown): unknown =>
  Array.isArray(m) && m.length ? m[0] : m;
/** Python `str((ref, pin))`, the sort key the core uses. */
const tupleText = ([ref, pin]: Pin) => `(${pyRepr(ref)}, ${pyRepr(pin)})`;
const byTupleText = (a: Pin, b: Pin) => cmpStr(tupleText(a), tupleText(b));

/** Drop parts (top level or nested) and every net member naming them; children of a removed parent are promoted. */
function removeRefs(circuit: Dict, refs: ReadonlySet<string>): void {
  const promoted: Dict[] = [];
  const kept: Dict[] = [];
  for (const comp of (Array.isArray(circuit.components)
    ? circuit.components
    : []) as Dict[]) {
    const internal = Array.isArray(comp.internal)
      ? (comp.internal as Dict[])
      : [];
    const children = internal.filter((c) => !refs.has(pyStr(c.ref)));
    if (refs.has(pyStr(comp.ref))) {
      for (const child of children) {
        const copy = structuredClone(child);
        delete copy.connections;
        promoted.push(copy);
      }
      continue;
    }
    if (comp.internal !== undefined && comp.internal !== null)
      comp.internal = children;
    kept.push(comp);
  }
  circuit.components = [...kept, ...promoted];
  const nets: unknown[] = [];
  for (const net of Array.isArray(circuit.nets) ? circuit.nets : []) {
    const members = (Array.isArray(net) ? net : []).filter(
      (m) => !refs.has(pyStr(memberRef(m))),
    );
    if (members.length) nets.push(members);
  }
  circuit.nets = nets;
}

/** Analysis measurements that probe `ref` (by component or by one of its pins). */
function measurementsUsing(circuit: Dict, ref: string): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (isDict(node)) {
      const nets = Array.isArray(node.nets) ? node.nets : [];
      const probesPin = nets.some(
        (m) => Array.isArray(m) && m.length > 0 && m[0] === ref,
      );
      if (
        !Object.hasOwn(node, 'measurement') &&
        node.ref &&
        (node.component === ref || probesPin)
      ) {
        found.add(pyStr(node.ref));
      }
      for (const value of Object.values(node)) walk(value);
    } else if (Array.isArray(node)) {
      for (const value of node) walk(value);
    }
  };
  walk(circuit.analysis ?? {});
  return sortedStr(found);
}

/** Engine terminal -> YAML pins for a part placed from the palette or copied. */
function terminalMap(comp: Dict): Map<string, string[]> {
  if (isDict(comp.pins)) {
    // generic block: terminals are named after the YAML pins
    return new Map(Object.keys(comp.pins).map((t) => [t, [t]]));
  }
  const spec = PALETTE_BY_TYPE.get(pyStr(comp.type ?? null));
  return new Map(Object.entries(spec?.pins ?? {}).map(([t, p]) => [t, [p]]));
}

const paramsOf = (c: Dict): Dict => (isDict(c.parameters) ? c.parameters : {});
const nested = (value: unknown) => Array.isArray(value) || isDict(value);

/** The YAML part for a part added in the editor: a copy of an existing part, or a palette part. */
function yamlFromPalette(
  cid: string,
  comp: Dict,
  originals: Map<string, Dict>,
): Dict {
  const meta = isDict(comp.meta) ? comp.meta : {};
  const source = originals.get(pyStr(meta.copyOf ?? null));
  if (source) {
    const copy = structuredClone(source);
    delete copy.internal;
    delete copy.connections;
    delete copy.layout;
    copy.ref = cid;
    if (!isDict(copy.params)) copy.params = {};
    const params = copy.params as Dict;
    for (const [key, value] of Object.entries(paramsOf(comp))) {
      if (
        !nested(params[key]) &&
        fmtParam(params[key]) !== pythonStrip(pyStr(value))
      ) {
        params[key] = coerce(value);
      }
    }
    return copy;
  }
  const spec = PALETTE_BY_TYPE.get(pyStr(comp.type ?? null));
  if (!spec) {
    throw new ApplyError(
      `${cid}: parts of type ${pyStr(comp.type ?? null)} cannot be added from the drawing`,
    );
  }
  const created: Dict = { ref: cid, ...structuredClone(spec.yaml) };
  if (!isDict(created.params)) created.params = {};
  const params = created.params as Dict;
  for (const [key, value] of Object.entries({
    ...spec.parameters,
    ...paramsOf(comp),
  })) {
    params[key] = coerce(value);
  }
  if (comp.type === 'LABEL') {
    params.net_name = pyStr(paramsOf(comp).net_name || comp.label || cid);
  }
  return created;
}

class ApplyError extends Error {}

/** The simulated connectivity: one canonical key per SPICE node with 2+ members. */
function partition(circuit: Dict): Set<string> {
  const out = new Set<string>();
  for (const members of netsByName(connectivity(circuit)).values()) {
    if (members.length > 1) out.add(canonical(members));
  }
  return out;
}
const canonical = (members: readonly Pin[]) =>
  JSON.stringify([...new Set(members.map((m) => JSON.stringify(m)))].sort());

/** Design rows with the drawing's edits applied. */
function updatedRows(rows: unknown, changes: ParamChange[]): Dict[] {
  const out = (Array.isArray(rows) ? rows : [])
    .filter(isDict)
    .map((r) => ({ ...r }));
  for (const change of changes) {
    for (const row of out) {
      if (pyStr(row.ref) === change.ref && pyStr(row.param) === change.param) {
        row.after = change.value;
      }
    }
  }
  return out;
}

/** The netlist generator is the judge of a circuit. */
function validate(circuit: Dict): void {
  const { netlist } = generateNetlist(structuredClone(circuit), null);
  if (!netlist.trim())
    throw new Error('Netlist generation produced an empty circuit');
}

/**
 * Turn an edited drawing of one sheet into a circuit change. `layout` is the
 * full layout the drawing was rendered with (groups, other sheets).
 */
export function applySchematic(
  baseIn: Dict,
  schematic: Dict,
  recalculated: unknown = null,
  sheet: Sheet = null,
  layout: SchematicLayout | null = null,
  drawing: Dict | null = null,
): ApplyResult {
  const base = structuredClone(baseIn);
  const effective = applyUpdates(structuredClone(base), recalculated);
  const effByRef = new Map(flat(effective).map(([c]) => [pyStr(c.ref), c]));
  const baseByRef = new Map(flat(base).map(([c]) => [pyStr(c.ref), c]));
  const oldCompNets = connectivity(base);
  const oldNets = netsByName(oldCompNets);
  const oldGroups = [...oldNets.values()].filter((g) => g.length > 1);
  const wasConnected = new Map<string, Pin>();
  for (const g of oldGroups)
    for (const m of g) wasConnected.set(JSON.stringify(m), m);

  const oldSymbols = buildSymbols(base, oldCompNets);
  const [sheetGroups] = resolveGroups(
    base,
    oldCompNets,
    oldSymbols,
    layout,
    drawing,
  );
  if (sheet !== null && !sheetGroups.has(sheet))
    throw new SheetNotFoundError(sheet);
  const memberOf = membership(oldSymbols, oldCompNets, sheetGroups);
  const sheetOf = (ref: string, pin = ''): Sheet => {
    const cid = oldSymbols.has(ref)
      ? ref
      : oldSymbols.has(`${ref}.${pin}`)
        ? `${ref}.${pin}`
        : ref;
    return memberOf.get(cid) ?? null;
  };

  const scomps = (
    Array.isArray(schematic.components) ? schematic.components : []
  ).filter((c): c is Dict => isDict(c) && Boolean(c.id));
  const swires = (Array.isArray(schematic.wires) ? schematic.wires : []).filter(
    isDict,
  );
  const metaOf = (c: Dict): Dict => (isDict(c.meta) ? c.meta : {});
  const idOf = (c: Dict) => pyStr(c.id);
  const errors: string[] = [];
  const changes: string[] = [];

  const present = new Map<string, Dict>();
  const addedComps: Dict[] = [];
  for (const c of scomps) {
    const meta = metaOf(c);
    if (meta.virtual || meta.bare || c.type === 'SHEET' || c.type === 'PORT')
      continue;
    if (meta.ref && meta.ref === c.id && baseByRef.has(idOf(c)))
      present.set(idOf(c), c);
    else addedComps.push(c);
  }
  const inScope = [...baseByRef.keys()].filter((ref) => sheetOf(ref) === sheet);
  const removed = sortedStr(inScope.filter((ref) => !present.has(ref)));
  const removedSet = new Set(removed);
  if (sheet === null) {
    // A group block can not be deleted as a whole: its parts are deleted on its own sheet.
    const [, expected] = sheetView(
      base,
      oldCompNets,
      oldSymbols,
      sheetGroups,
      memberOf,
      null,
      (n) => n,
    );
    const drawnIds = new Set(scomps.map(idOf));
    for (const [cid, sym] of expected) {
      if (sym.type === 'SHEET' && !drawnIds.has(cid)) {
        errors.push(
          `The block “${pyStr(sym.label ?? null)}” was deleted: open it and delete its parts there instead.`,
        );
      }
    }
  }

  // Parameters of the parts that stay (compared with what the drawing showed).
  const paramChanges: ParamChange[] = [];
  for (const [ref, c] of present) {
    const eff = effByRef.get(ref) as Dict;
    const effParams = isDict(eff.params) ? eff.params : {};
    const target = baseByRef.get(ref) as Dict;
    if (!isDict(target.params)) target.params = {};
    const params = target.params as Dict;
    for (const [key, value] of Object.entries(paramsOf(c))) {
      if (nested(effParams[key])) continue;
      const text = pythonStrip(pyStr(value));
      const before = Object.hasOwn(effParams, key)
        ? fmtParam(effParams[key])
        : null;
      if (
        before === text ||
        (before === null &&
          (text === '' || (key === 'net_name' && text === ref)))
      ) {
        continue;
      }
      params[key] = coerce(text);
      paramChanges.push({ ref, param: key, value: text, before });
      changes.push(`${ref} ${key}: ${before ?? '—'} → ${text}`);
    }
  }

  if (removed.length) {
    for (const ref of removed) {
      const users = measurementsUsing(base, ref);
      if (users.length) {
        errors.push(
          `${ref} cannot be deleted: the analyses measure it (${users.slice(0, 4).join(', ')}).`,
        );
      }
    }
    removeRefs(base, removedSet);
    changes.push(...removed.map((ref) => `Removed ${ref}`));
  }

  // Engine terminal -> YAML pins of every part in the drawing.
  const terminalPins = new Map<string, Map<string, string[]>>();
  for (const [ref, c] of present) {
    const tmap = new Map<string, string[]>();
    const pins = isDict(metaOf(c).pins) ? (metaOf(c).pins as Dict) : {};
    for (const [pin, terminal] of Object.entries(pins)) {
      const t = pyStr(terminal);
      tmap.set(t, [...(tmap.get(t) ?? []), pin]);
    }
    for (const [terminal, list] of terminalMap(c))
      if (!tmap.has(terminal)) tmap.set(terminal, list);
    terminalPins.set(ref, tmap);
  }

  const added: string[] = [];
  const taken = new Set(flat(base).map(([c]) => pyStr(c.ref)));
  for (const c of addedComps) {
    const cid = idOf(c);
    if (!REF_OK.test(cid)) {
      errors.push(
        `“${cid}” is not a valid component name (letters, digits and _, starting with a letter).`,
      );
      continue;
    }
    if (taken.has(cid)) {
      errors.push(`${cid} already exists in the circuit.`);
      continue;
    }
    let created: Dict;
    try {
      created = yamlFromPalette(cid, c, effByRef);
    } catch (error) {
      if (!(error instanceof ApplyError)) throw error;
      errors.push(error.message);
      continue;
    }
    if (!Array.isArray(base.components)) base.components = [];
    (base.components as Dict[]).push(created);
    taken.add(cid);
    let tmap = terminalMap(c);
    if (!tmap.size) {
      const [, pinMap] = symbolFor(created);
      tmap = new Map(
        Object.entries(pinMap)
          .filter(([p]) => p !== ANY)
          .map(([p, t]) => [t, [p]]),
      );
    }
    terminalPins.set(cid, tmap);
    added.push(cid);
    const kind =
      created.type !== 'node'
        ? created.type
        : (created.params as Dict).node_type;
    const desc = displayText(created);
    changes.push(`Added ${cid} (${pyStr(kind)}${desc ? `, ${desc}` : ''})`);
  }

  // Connectivity as drawn: wires (and taps), labels joined by name, grounds joined.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    if (!parent.has(a)) parent.set(a, a);
    let x = a;
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x) as string) as string);
      x = parent.get(x) as string;
    }
    return x;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const k = (...parts: unknown[]) => JSON.stringify(parts);
  const nameOf = (c: Dict) => pyStr(paramsOf(c).net_name || c.label || c.id);
  for (const w of swires) {
    const wid = k('w', w.id ?? null);
    find(wid);
    for (const end of [w.from, w.to]) {
      if (!isDict(end)) continue;
      if (end.type === 'pin')
        union(wid, k('p', end.compId ?? null, end.terminal ?? null));
      else if (end.wireId !== null && end.wireId !== undefined)
        union(wid, k('w', end.wireId));
    }
  }
  for (const c of scomps) {
    const meta = metaOf(c);
    if (c.type === 'GND') {
      union(k('p', c.id, 'P'), k('name', '\x00GND'));
      union(k('name', '\x00GND'), k('net', '0'));
    } else if (c.type === 'LABEL') {
      union(k('p', c.id, 'P'), k('name', nameOf(c)));
    } else if (
      c.type === 'PORT' &&
      meta.port !== null &&
      meta.port !== undefined
    ) {
      union(k('p', c.id, 'P'), k('net', pyStr(meta.port)));
      // Like the drawing: a port and a label of the same name are the same net.
      union(k('p', c.id, 'P'), k('name', nameOf(c)));
    } else if (c.type === 'SHEET') {
      const pins = isDict(meta.pins) ? meta.pins : {};
      for (const [net, terminal] of Object.entries(pins)) {
        union(k('p', c.id, terminal ?? null), k('net', net));
      }
    }
  }

  const groups = new Map<string, Member[]>();
  const push = (root: string, members: Member[]) => {
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)?.push(...members);
  };
  for (const c of scomps) {
    const meta = metaOf(c);
    if (meta.virtual) continue;
    if (Array.isArray(meta.bare)) {
      const [ref, pin] = meta.bare.map((x) => pyStr(x));
      push(find(k('p', c.id, 'P')), [pin ? [ref, pin] : ref]);
      continue;
    }
    for (const [terminal, pins] of terminalPins.get(idOf(c)) ?? []) {
      for (const pin of pins)
        push(find(k('p', c.id, terminal)), [[idOf(c), pin]]);
    }
  }
  // Members on other sheets: joined through the block pin / port of their net.
  for (const [net, members] of oldNets) {
    const outside: Member[] = members
      .filter(
        ([ref, pin]) => sheetOf(ref, pin) !== sheet && !removedSet.has(ref),
      )
      .map(([ref, pin]) => (pin ? [ref, pin] : ref));
    if (!outside.length) continue;
    if (parent.has(k('net', net))) push(find(k('net', net)), outside);
    else push(k('outside', net), outside);
  }

  const size = new Map<string, number>();
  for (const g of groups.values()) {
    for (const m of g) size.set(JSON.stringify(memberKey(m)), g.length);
  }
  const sizeOf = (ref: string, pin: string) =>
    size.get(JSON.stringify([ref, pin])) ?? 1;
  for (const cid of added) {
    for (const pins of terminalPins.get(cid)?.values() ?? []) {
      for (const pin of pins) {
        if (sizeOf(cid, pin) < 2) {
          errors.push(
            `Connect ${cid} pin ${pin || '(pin)'} — it is not wired to anything.`,
          );
        }
      }
    }
  }
  for (const [ref, pin] of [...wasConnected.values()].sort(byTupleText)) {
    if (present.has(ref) && sizeOf(ref, pin) < 2) {
      errors.push(
        `${ref} pin ${pin || '(pin)'} is no longer connected to anything.`,
      );
    }
  }

  // Compare with the simulated connectivity; rewrite the nets only when it really changed.
  const previously = new Set<string>();
  for (const [ref, pins] of oldCompNets)
    for (const pin of pins.keys()) previously.add(JSON.stringify([ref, pin]));
  const drawnNets = [...groups.values()].filter(
    (g) =>
      g.length > 1 ||
      (g.length === 1 && previously.has(JSON.stringify(memberKey(g[0])))),
  );
  const partitionOf = (
    gs: ReadonlyArray<readonly Pin[]>,
    drop: ReadonlySet<string>,
  ) =>
    new Set(
      gs
        .map((g) => g.filter((m) => !drop.has(m[0])))
        .filter((g) => new Set(g.map((m) => JSON.stringify(m))).size > 1)
        .map(canonical),
    );
  const oldPartition = partitionOf(oldGroups, removedSet);
  let rewired = false;
  if (!errors.length) {
    const candidate = structuredClone(base);
    candidate.nets = drawnNets;
    for (const [comp] of iterComponents(candidate.components))
      delete comp.connections;
    const newPartition = partition(candidate);
    const same = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && [...a].every((x) => b.has(x));
    if (!same(newPartition, oldPartition)) {
      base.nets = candidate.nets;
      for (const [comp] of iterComponents(base.components))
        delete comp.connections;
      // Connections between the parts that already existed (new parts only add members).
      const addedSet = new Set(added);
      const existing = partitionOf(
        [...newPartition].map((g) =>
          (JSON.parse(g) as string[]).map((m) => JSON.parse(m) as Pin),
        ),
        addedSet,
      );
      rewired = !same(existing, oldPartition);
      const moved = new Map<string, Pin>();
      for (const g of [...existing]
        .filter((x) => !oldPartition.has(x))
        .concat([...oldPartition].filter((x) => !existing.has(x)))) {
        for (const m of JSON.parse(g) as string[])
          moved.set(m, JSON.parse(m) as Pin);
      }
      const shown = [...moved.values()].sort(byTupleText);
      if (shown.length) {
        const text = shown
          .slice(0, 8)
          .map(([r, p]) => (p ? `${r}.${p}` : r))
          .join(', ');
        changes.push(`Rewired ${text}${shown.length > 8 ? ' …' : ''}`);
      }
    }
  }

  // Controlled switches need a .model; give a new one a default.
  const defined = new Set<string>();
  const modelName = /\.model\s+(\S+)/gi;
  for (const line of Array.isArray(base.models) ? base.models : []) {
    const m = /\.model\s+(\S+)/i.exec(pyStr(line));
    if (m) defined.add(m[1].toLowerCase());
  }
  for (const [comp] of iterComponents(base.components)) {
    if (comp.type !== 'custom_spice') continue;
    const params = isDict(comp.params) ? comp.params : {};
    const line = pyStr(
      Object.hasOwn(params, 'spice_line') ? params.spice_line : '',
    );
    for (const m of line.matchAll(modelName)) defined.add(m[1].toLowerCase());
  }
  for (const [comp] of iterComponents(base.components)) {
    if (comp.type !== 'switch') continue;
    const params = isDict(comp.params) ? comp.params : {};
    const name = pyStr(params.model || 'sw_mod');
    if (!defined.has(name.toLowerCase())) {
      if (!Array.isArray(base.models)) base.models = [];
      (base.models as unknown[]).push(DEFAULT_SW_MODEL(name));
      defined.add(name.toLowerCase());
    }
  }

  const newLayout = setSheetLayout(
    layout,
    sheet,
    scomps as unknown as SchematicSymbol[],
    swires as unknown as SchematicWire[],
  );
  const newGroups = new Map(
    [...sheetGroups].map(([gid, g]) => [
      gid,
      { label: g.label, members: g.members.filter((m) => !removedSet.has(m)) },
    ]),
  );
  if (sheet !== null) newGroups.get(sheet)?.members.push(...added);
  newLayout.groups = Object.fromEntries(
    [...newGroups].filter(([, g]) => g.members.length),
  );
  const layoutOnly =
    !(paramChanges.length || removed.length || added.length || rewired) &&
    !errors.length;
  if (!errors.length && !layoutOnly) {
    try {
      validate(
        applyUpdates(
          structuredClone(base),
          updatedRows(recalculated, paramChanges),
        ),
      );
    } catch (error) {
      errors.push(
        `The netlist cannot be generated from this circuit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    layout_only: layoutOnly,
    circuit: base,
    layout: newLayout,
    param_changes: paramChanges,
    added,
    removed,
    rewired,
    changes,
    errors,
  };
}
