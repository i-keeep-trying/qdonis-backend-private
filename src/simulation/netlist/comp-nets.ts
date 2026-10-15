/**
 * Net naming and pin resolution, ported from qdonis-core
 * `simulator/netlist_generator.py` (`build_comp_nets`, `need_pins`,
 * `get_component_pins`, `_resolve_voltage_node`, `_capacitor_plate_node`,
 * `_element_name_for_current`, `_device_current_vector`, `spice_dev_name`).
 *
 * Nets per component are Maps so pin order is insertion order even for
 * integer-like pin names (Python dicts keep insertion order; JS objects
 * would sort such keys first).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import {
  PyError,
  get,
  has,
  isDict,
  item,
  iter,
  lower,
  or,
  pyRepr,
  pyStr,
  toFloat,
  truthy,
  type Dict,
} from './py';

/** comp ref -> (pin -> net name). */
export type CompNets = Map<string, Map<string, string>>;

const SPICE_COMPONENTS = JSON.parse(
  readFileSync(join(ASSETS_ROOT, 'spice', 'spice_components.json'), 'utf8'),
) as Dict;

/** Map key for a decoded YAML scalar, with Python equality (1 == 1.0 == True). */
export function pyKey(value: unknown): string {
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'boolean') return `n:${Number(value)}`;
  if (typeof value === 'bigint' || typeof value === 'number') {
    return `n:${Number(value)}`;
  }
  if (value === null || value === undefined) return 'none';
  throw new PyError(
    'TypeError',
    `unhashable type: '${Array.isArray(value) ? 'list' : 'dict'}'`,
  );
}

/** Dict key text of a YAML scalar used as a Python dict key. */
export const keyText = (value: unknown): string =>
  typeof value === 'string' ? value : pyStr(value);

export function getPinAllocation(
  componentType: string,
  family?: string | null,
): Dict {
  if (componentType === 'transistor' && family) {
    const familyData = get(
      item(item(SPICE_COMPONENTS, 'transistor'), 'family_specific'),
      family,
      {},
    );
    return get(familyData, 'pin_allocation', {}) as Dict;
  }
  const entry = get(SPICE_COMPONENTS, componentType, {});
  return get(entry, 'pin_allocation', {}) as Dict;
}

/** Resolves each required SPICE pin to a net: [resolved | null, missing pin | null]. */
export function getComponentPins(
  nets: Map<string, string>,
  componentType: string,
  required: string[],
  family?: string | null,
): [Map<string, string> | null, string | null] {
  const resolved = new Map<string, string>();
  const allocation = getPinAllocation(componentType, family);
  for (const spicePin of required) {
    if (nets.has(spicePin)) {
      resolved.set(spicePin, nets.get(spicePin) as string);
      continue;
    }
    let found: string | undefined;
    for (const [yamlPin, aliases] of Object.entries(allocation)) {
      if (has(aliases, spicePin) && nets.has(yamlPin)) {
        found = nets.get(yamlPin);
        break;
      }
    }
    if (found === undefined) return [null, spicePin];
    resolved.set(spicePin, found);
  }
  return [resolved, null];
}

const listRepr = (values: string[]) => `[${values.map(pyRepr).join(', ')}]`;

/** `need_pins`: required pins, with alias resolution when the type is given. */
export function needPins(
  ref: string,
  nets: Map<string, string>,
  pins: string[],
  componentType?: string | null,
  family?: string | null,
): Map<string, string> {
  if (componentType) {
    const [resolved, missing] = getComponentPins(
      nets,
      componentType,
      pins,
      family,
    );
    if (resolved === null) {
      throw new PyError(
        'ValueError',
        `${ref}: missing required pin '${missing}' in YAML nets (checked pin mappings for ${componentType})` +
          `\n  Required pins: ${listRepr(pins)}` +
          `\n  Available pins in nets: ${listRepr([...nets.keys()])}` +
          `\n  Component type: ${componentType}, Family: ${pyStr(family ?? null)}`,
      );
    }
    return resolved;
  }
  const missing = pins.filter((pin) => !nets.has(pin));
  if (missing.length > 0) {
    if (missing.every((pin) => pin === '') && nets.has('')) {
      const out = new Map<string, string>();
      for (const pin of pins) {
        if (!nets.has(pin)) throw new PyError('KeyError', pyRepr(pin));
        out.set(pin, nets.get(pin) as string);
      }
      return out;
    }
    throw new PyError(
      'ValueError',
      `${ref}: missing required pins in YAML nets: ${listRepr(missing)}`,
    );
  }
  return new Map(pins.map((pin) => [pin, nets.get(pin) as string]));
}

/** Component name with the SPICE prefix, without doubling it. */
export function spiceDevName(prefix: string, ref: unknown): string {
  const sref = pyStr(ref);
  return sref.toUpperCase().startsWith(prefix.toUpperCase())
    ? sref
    : `${prefix}${sref}`;
}

const SEMICONDUCTOR = ['transistor', 'mosfet', 'igbt', 'vg-fet'];

/** ngspice `@dev[param]` current vector for parts emitted without a sense source. */
export function deviceCurrentVector(comp: Dict): string | null {
  const ref = get(comp, 'ref');
  const ctype = pyStr(or(get(comp, 'type'), '')).toLowerCase();
  const params = or(get(comp, 'params', {}), {}) as Dict;
  if (!truthy(ref)) return null;
  if (ctype === 'switch') return `@${spiceDevName('S', ref)}[i]`;
  if (get(params, 'sense') !== false) return null;
  if (ctype === 'diode') return `@${spiceDevName('D', ref)}[id]`;
  if (SEMICONDUCTOR.includes(ctype)) {
    const family = lower(
      or(get(params, 'family'), ctype === 'transistor' ? 'bjt' : ctype),
    );
    if (['mosfet', 'vdmos', 'igbt', 'vg-fet'].includes(family)) {
      return `@${spiceDevName('M', ref)}[id]`;
    }
  }
  return null;
}

const LABEL_PINS = new Set(['pin', 'net', 'label', 'net_name', 'node']);
const MAIN_DC_REFS = new Set<unknown>([
  'VIN',
  'V5',
  'VDC',
  'V_DC',
  'V_IN',
  'V_BUS',
  'Vdc',
  'Vin',
]);
const MAIN_DC_ROLES = new Set<unknown>([
  'dc_link_voltage',
  'dc_bus',
  'input_voltage',
  'input_source',
]);

/**
 * `build_comp_nets`: merges nets that share a pin, names each one (`0` for
 * ground, a label's name, else `n<idx>`), then wires internal parts.
 * Returns the nets per component and the auto-ground notes.
 */
export function buildCompNets(design: Dict): [CompNets, string[]] {
  const compByRef = new Map<string, Dict>();
  for (const comp of iter(get(design, 'components', []))) {
    compByRef.set(keyText(item(comp, 'ref')), comp as Dict);
    for (const internal of iter(get(comp, 'internal', []))) {
      compByRef.set(keyText(item(internal, 'ref')), internal as Dict);
    }
  }

  const compNets: CompNets = new Map();
  const notes: string[] = [];
  const setPin = (ref: unknown, pin: unknown, net: string) => {
    const refKey = keyText(ref);
    if (!compNets.has(refKey)) compNets.set(refKey, new Map());
    compNets.get(refKey)?.set(keyText(pin), net);
  };

  // A net is an insertion-ordered set of (ref, pin) members.
  type Member = [unknown, unknown];
  const netsAsSets: Array<Map<string, Member>> = [];
  for (const net of iter(get(design, 'nets', []))) {
    const pinSet = new Map<string, Member>();
    for (const m of iter(net)) {
      let ref: unknown;
      let pin: unknown;
      if (Array.isArray(m)) {
        ref = m[0];
        pin = m.length > 1 ? m[1] : '';
        if (m.length === 0)
          throw new PyError('IndexError', 'list index out of range');
      } else {
        ref = m;
        pin = '';
      }
      pinSet.set(`${pyKey(ref)}|${pyKey(pin)}`, [ref, pin]);
    }
    if (pinSet.size > 0) netsAsSets.push(pinSet);
  }

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < netsAsSets.length; i += 1) {
      for (let j = i + 1; j < netsAsSets.length; j += 1) {
        if ([...netsAsSets[j].keys()].some((key) => netsAsSets[i].has(key))) {
          for (const [key, member] of netsAsSets[j]) {
            if (!netsAsSets[i].has(key)) netsAsSets[i].set(key, member);
          }
          netsAsSets.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  const explicitGround =
    [...compByRef.values()].some(
      (c) =>
        get(c, 'type') === 'node' &&
        get(or(get(c, 'params'), {}), 'node_type') === 'ground',
    ) ||
    netsAsSets.some((pinSet) =>
      [...pinSet.values()].some(
        ([ref]) =>
          !(typeof ref === 'string' && compByRef.has(ref)) &&
          ['GND', '0'].includes(pyStr(ref).toUpperCase()),
      ),
    );

  netsAsSets.forEach((pinSet, idx) => {
    let groundMember: Member | null = null;
    let namedMember: unknown = null;
    for (const [ref, pin] of pinSet.values()) {
      const refKnown = typeof ref === 'string' && compByRef.has(ref);
      const comp = refKnown ? compByRef.get(ref) : undefined;
      if (comp && truthy(comp) && get(comp, 'type') === 'node') {
        const params = get(comp, 'params', {});
        if (get(params, 'node_type') === 'ground') {
          groundMember = [ref, pin];
          break;
        }
        // Main DC voltage source with minus pin (traditional ground reference).
        // Sources other than VIN only when the circuit has no ground of its own:
        // with a split DC link (NPC: midpoint grounded) grounding every rail's
        // minus pin would short the rails.
        if (
          get(params, 'node_type') === 'voltage_source' &&
          (pin === '-' || pin === 'neg') &&
          (ref === 'VIN' ||
            (!explicitGround &&
              (MAIN_DC_REFS.has(ref) || MAIN_DC_ROLES.has(get(comp, 'role')))))
        ) {
          groundMember = [ref, pin];
          break;
        }
        if (
          ['label', 'net', 'net_label'].includes(
            get(params, 'node_type') as string,
          )
        ) {
          namedMember = or(get(params, 'net_name'), ref);
        }
      } else if (!refKnown && ['GND', '0'].includes(pyStr(ref).toUpperCase())) {
        groundMember = [ref, pin];
        break;
      } else if (
        ['NET', 'LABEL', 'net_name'].includes(ref as string) &&
        truthy(pin)
      ) {
        namedMember = pin;
      } else if (
        ['NET', 'LABEL', 'net_name'].includes(pin as string) &&
        truthy(ref)
      ) {
        namedMember = ref;
      } else if (
        (!truthy(pin) || LABEL_PINS.has(pyStr(pin).toLowerCase())) &&
        !refKnown &&
        typeof ref === 'string'
      ) {
        namedMember = ref;
      } else if (
        refKnown &&
        !(typeof pin === 'string' && compByRef.has(pin)) &&
        LABEL_PINS.has(pyStr(ref).toLowerCase()) &&
        typeof pin === 'string'
      ) {
        namedMember = pin;
      }
    }

    let netName: string;
    if (groundMember) {
      netName = '0';
      const [gRef, gPin] = groundMember;
      notes.push(
        `* Auto-grounded net ${idx} due to ${pyStr(gRef)}:${pyStr(gPin)}`,
      );
    } else if (namedMember !== null && namedMember !== undefined) {
      netName = pyStr(namedMember);
    } else {
      netName = `n${idx}`;
    }
    for (const [ref, pin] of pinSet.values()) setPin(ref, pin, netName);
  });

  let netCounter = netsAsSets.length;
  for (const comp of iter(get(design, 'components', []))) {
    for (const internal of iter(get(comp, 'internal', []))) {
      const internalRef = item(internal, 'ref');
      const connections = get(internal, 'connections', {});
      if (!isDict(connections)) {
        throw new PyError('AttributeError', "object has no attribute 'items'");
      }
      for (const [pin, connection] of Object.entries(connections)) {
        if (Array.isArray(connection) && connection.length === 2) {
          const [targetComp, targetPin] = connection as [unknown, unknown];
          const targetNets = compNets.get(keyText(targetComp));
          let targetNet = targetNets?.get(keyText(targetPin));
          if (targetNet === undefined) {
            targetNet = `n${netCounter}`;
            netCounter += 1;
            setPin(targetComp, targetPin, targetNet);
            notes.push(
              `* Created internal net ${targetNet} for ${pyStr(internalRef)}:${pin} -> ${pyStr(targetComp)}:${pyStr(targetPin)}`,
            );
          }
          setPin(internalRef, pin, targetNet);
        }
      }
    }
  }

  return [compNets, notes];
}

/** `_build_components_index`: ref -> component (internal parts included). */
export function buildComponentsIndex(design: Dict): Dict {
  const index: Dict = {};
  for (const comp of iter(get(design, 'components', []))) {
    index[keyText(item(comp, 'ref'))] = comp;
    for (const internal of iter(get(comp, 'internal', []))) {
      index[keyText(item(internal, 'ref'))] = internal;
    }
  }
  design.components_dict = index;
  return index;
}

export const componentsDict = (design: Dict): Dict =>
  (get(design, 'components_dict', {}) ?? {}) as Dict;

const netsOf = (compNets: CompNets, ref: unknown): Map<string, string> =>
  compNets.get(keyText(ref)) ?? new Map<string, string>();

/** Moves a probe on a capacitor's external net to its internal plate node. */
export function capacitorPlateNode(
  design: Dict,
  compNets: CompNets,
  net: string,
  targetRef: string | null = null,
): string {
  if (!net || net === '0' || net === 'gnd' || net === 'GND') return net;
  try {
    const comps =
      targetRef && has(design, 'components_dict')
        ? [get(componentsDict(design), targetRef)]
        : iter(get(design, 'components', []));
    for (const comp of comps) {
      if (!comp || !truthy(comp) || get(comp, 'type') !== 'capacitor') continue;
      const ref = get(comp, 'ref');
      if (targetRef && ref !== targetRef) continue;
      if (!truthy(ref)) continue;
      const params = or(get(comp, 'params'), {}) as Dict;
      let esr: number;
      let esl: number;
      try {
        esr = toFloat(or(get(params, 'esr', 0.0), 0.0));
      } catch {
        esr = 0;
      }
      try {
        esl = toFloat(or(get(params, 'esl', 0.0), 0.0));
      } catch {
        esl = 0;
      }
      if (esr <= 0 && esl <= 0) continue;
      let pinNets: Map<string, string>;
      try {
        pinNets = needPins(
          pyStr(ref),
          netsOf(compNets, ref),
          ['pos', 'neg'],
          'capacitor',
        );
      } catch {
        continue;
      }
      if (pinNets.get('pos') !== net) continue;
      if (esr > 0) return `n_${pyStr(ref)}_esr`;
      if (esl > 0) return `n_${pyStr(ref)}_esl`;
    }
  } catch {
    // Python: `except Exception: pass`
  }
  return net;
}

/** Node name for a (ref, pin) probe; capacitors probe their plate node. */
export function resolveVoltageNode(
  design: Dict,
  compNets: CompNets,
  ref: unknown,
  pin: unknown,
): string {
  if (typeof ref !== 'string') {
    if (ref === '0') return ref;
    throw new PyError('AttributeError', "object has no attribute 'startswith'");
  }
  if (ref === '0' || ref.startsWith('n_') || pin === '__raw_node__') return ref;
  const nets = netsOf(compNets, ref);
  let n = nets.get(keyText(pin));
  if (n === undefined) n = nets.get('');
  if (n === undefined) {
    throw new PyError(
      'ValueError',
      `Cannot resolve node for ${ref}:${pyStr(pin)} in nets`,
    );
  }
  let comp = get(componentsDict(design), ref) as Dict | undefined;
  if (!comp || !truthy(comp)) {
    comp = undefined;
    for (const c of iter(get(design, 'components', []))) {
      if (get(c, 'ref') === ref) {
        comp = c as Dict;
        break;
      }
    }
  }
  if (comp && truthy(comp) && get(comp, 'type') === 'capacitor') {
    return capacitorPlateNode(design, compNets, n, ref);
  }
  return n;
}

const TRANSFORMERS = ['transformer', 'ct_transformer', 'dual_ct_transformer'];

/** Element name inside `i(...)` for a component (dot notation for windings). */
export function elementNameForCurrent(design: Dict, compRef: unknown): string {
  let ref = pyStr(compRef);
  const index = item(design, 'components_dict') as Dict;
  if (typeof compRef === 'string' && compRef.includes('.')) {
    const dot = compRef.indexOf('.');
    const baseRef = compRef.slice(0, dot);
    const terminal = compRef.slice(dot + 1);
    const comp = get(index, baseRef);
    if (!truthy(comp))
      throw new PyError('ValueError', `Unknown component ref: ${baseRef}`);
    const ctype = get(comp, 'type');
    if (TRANSFORMERS.includes(ctype as string)) {
      const t = terminal.toLowerCase();
      if (['pri', 'primary', 'p', 'p1'].includes(t)) {
        return ctype === 'dual_ct_transformer'
          ? `V${baseRef}_SENSE_PRI1`
          : `V${baseRef}_SENSE_PRI`;
      }
      if (['sec', 'secondary', 's', 's1', 'sec1'].includes(t)) {
        return ctype === 'transformer'
          ? `V${baseRef}_SENSE_SEC`
          : `V${baseRef}_SENSE_SEC1`;
      }
      if (['s2', 'sec2'].includes(t)) return `V${baseRef}_SENSE_SEC2`;
      if (['p2', 'pri2'].includes(t)) return `V${baseRef}_SENSE_PRI2`;
      throw new PyError(
        'ValueError',
        `Unknown transformer terminal: ${terminal} (use pri/sec/sec1/sec2)`,
      );
    }
    ref = baseRef;
  }
  const comp = get(index, ref);
  if (!truthy(comp)) {
    throw new PyError(
      'ValueError',
      `Unknown component ref for current mapping: ${ref}`,
    );
  }
  const ctype = get(comp, 'type');
  const params = get(comp, 'params', {});
  if (ctype === 'node') return spiceDevName('V', ref);
  if (ctype === 'inductor' && get(params, 'sense') === false) {
    return spiceDevName('L', ref);
  }
  if (TRANSFORMERS.includes(ctype as string)) {
    throw new PyError(
      'ValueError',
      `Transformer '${ref}' requires explicit terminal in i() expression. ` +
        `Use i(${ref}.pri) or i(${ref}.sec) / i(${ref}.sec1) / i(${ref}.sec2)`,
    );
  }
  if (get(params, 'sense') === false) {
    const prefix =
      ctype === 'resistor'
        ? 'R'
        : ctype === 'capacitor'
          ? 'C'
          : ctype === 'diode'
            ? 'D'
            : ctype === 'switch'
              ? 'S'
              : '';
    return spiceDevName(prefix, ref);
  }
  return `V${ref}_SENSE`;
}
