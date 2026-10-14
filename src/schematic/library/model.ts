/**
 * The circuit as the drawing sees it: connectivity from the netlist
 * generator, one engine symbol per YAML part (and per bare net reference),
 * power-stage / control regions and readable net names. Port of the "Circuit
 * model" and "_symbols / _regions / _net_namer" parts of qdonis-core
 * `schematic_sync.py`.
 */

import { iterComponents } from '../../circuits/library/circuit-inventory';
import {
  CONTROL_BLOCK_GLYPHS,
  controlBlockSymbolPins,
  isControlBlock,
} from '../../simulation/netlist/signal-blocks';
import {
  buildCompNets,
  type CompNets,
} from '../../simulation/netlist/comp-nets';
import { or, pyStr, type Dict } from '../../simulation/netlist/py';
import type { SchematicSymbol } from '../schematic.types';
import { paramsOf, pinTerminals } from './symbols';
import { displayText, scalarParams } from './values';

/** A (YAML ref, YAML pin) member of a net. */
export type Pin = readonly [string, string];
export type Symbols = Map<string, SchematicSymbol>;
export type Region = 'main' | 'control' | null;

/** Python string order (code points). */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    if (x.value !== y.value) {
      return (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    }
  }
}

/** Python tuple order over strings / numbers. */
export function cmpTuple(
  a: ReadonlyArray<string | number | boolean>,
  b: ReadonlyArray<string | number | boolean>,
): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    const c =
      typeof x === 'string' && typeof y === 'string'
        ? cmpStr(x, y)
        : Number(x) - Number(y);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

export const sortedStr = (items: Iterable<string>): string[] =>
  [...items].sort(cmpStr);

export const pinKey = (ref: string, pin: string): string =>
  JSON.stringify([ref, pin]);

/** comp ref -> (pin -> net), as the netlist generator connects the circuit. */
export function connectivity(circuit: Dict): CompNets {
  return buildCompNets(structuredClone(circuit))[0];
}

/** net -> its (ref, pin) members, in connectivity order. */
export function netsByName(compNets: CompNets): Map<string, Pin[]> {
  const nets = new Map<string, Pin[]>();
  for (const [ref, pins] of compNets) {
    for (const [pin, net] of pins) {
      if (!nets.has(net)) nets.set(net, []);
      nets.get(net)?.push([ref, pin]);
    }
  }
  return nets;
}

/** Every component with a ref (nested parts included) and its parent ref. */
export function flat(circuit: Dict): Array<[Dict, unknown]> {
  return [...iterComponents(circuit.components)].filter(([c]) =>
    Boolean(c.ref),
  );
}

export const byRef = (circuit: Dict): Map<string, Dict> =>
  new Map(flat(circuit).map(([c]) => [pyStr(c.ref), c]));

const labelName = (comp: Dict): string =>
  pyStr(or(paramsOf(comp).net_name, comp.ref));

/** Engine symbols (without positions) of every part and bare net reference. */
export function buildSymbols(circuit: Dict, compNets: CompNets): Symbols {
  const out: Symbols = new Map();
  for (const [comp, parent] of flat(circuit)) {
    const ref = pyStr(comp.ref);
    const params = paramsOf(comp);
    const used = compNets.get(ref) ?? new Map<string, string>();
    const [symbol, terminals] = pinTerminals(comp, used);
    const entry: SchematicSymbol = {
      id: ref,
      type: symbol,
      parameters: scalarParams(params),
      display: displayText(comp),
      meta: {
        ref,
        yaml_type: comp.type ?? null,
        node_type: params.node_type ?? null,
        role: comp.role ?? null,
        parent: parent ?? null,
        pins: Object.fromEntries(terminals ?? []),
      },
    };
    if (terminals === null) {
      // No symbol fits: a generic block, pins split left / right.
      const names = [...used.keys()].sort(cmpStr);
      const half = Math.ceil(names.length / 2);
      entry.type = 'BLOCK';
      entry.symbol = pyStr(or(comp.type, '?'));
      entry.pins = {};
      names.forEach((name, i) => {
        const left = i < half;
        const [k, n] = left ? [i, half] : [i - half, names.length - half];
        (entry.pins as Record<string, unknown>)[name || 'pin'] = {
          x: left ? -40 : 40,
          y: Math.trunc(-(n - 1) * 10 + k * 20),
          dx: left ? -1 : 1,
          dy: 0,
        };
      });
      entry.meta.pins = Object.fromEntries(
        names.map((name) => [name, name || 'pin']),
      );
    }
    if (symbol === 'LABEL') {
      entry.label = labelName(comp);
      if (!Object.hasOwn(entry.parameters, 'net_name')) {
        entry.parameters.net_name = entry.label;
      }
    }
    if (symbol.startsWith('CB_') && entry.type !== 'BLOCK') {
      const ctype = pyStr(comp.type);
      entry.pins = controlBlockSymbolPins(ctype, params);
      entry.symbol = CONTROL_BLOCK_GLYPHS[ctype] ?? '';
    }
    out.set(ref, entry);
  }

  const known = new Set(out.keys());
  for (const [ref, pins] of compNets) {
    if (known.has(ref)) continue;
    for (const [pin, net] of pins) {
      const cid = pin ? `${ref}.${pin}` : ref;
      const ground = net === '0';
      out.set(cid, {
        id: cid,
        type: ground ? 'GND' : 'LABEL',
        label: ground ? null : net,
        parameters: ground ? {} : { net_name: net },
        display: '',
        meta: { bare: [ref, pin], pins: {} },
      });
    }
  }
  return out;
}

const POWER_DEVICES = new Set([
  'transistor',
  'mosfet',
  'igbt',
  'vg-fet',
  'inductor',
  'transformer',
  'ct_transformer',
  'dual_ct_transformer',
  'switch',
]);
const CONTROL_SOURCES = new Set(['b_source', 'e_source', 'g_source']);

const isControlPart = (ctype: unknown, nodeType: unknown) =>
  CONTROL_SOURCES.has(ctype as string) ||
  nodeType === 'pwm_control' ||
  isControlBlock(ctype);

type Side = 'main' | 'control' | '?' | '?source' | null;

/**
 * 'main' (power stage, plus what `main` names) or 'control' (gate drive,
 * sensing, modulation, regulation) for every symbol; null for labels /
 * grounds, which go wherever they are needed.
 */
export function regions(
  circuit: Dict,
  compNets: CompNets,
  symbols: Symbols,
  main: ReadonlySet<string>,
): Map<string, Region> {
  const refs = byRef(circuit);
  const powerNets = new Set<string>();
  const controlNets = new Set<string>();
  for (const [ref, pins] of compNets) {
    const comp = refs.get(ref);
    if (!comp) continue;
    const ctype = comp.type;
    const nodeType = paramsOf(comp).node_type;
    for (const [pin, net] of pins) {
      if (net === '0') continue;
      if (POWER_DEVICES.has(ctype as string)) {
        (pin === 'gate' || pin.startsWith('ctrl')
          ? controlNets
          : powerNets
        ).add(net);
      } else if (ctype === 'diode') {
        powerNets.add(net); // rectifier, freewheel, clamp
      } else if (
        (CONTROL_SOURCES.has(ctype as string) && !pin.startsWith('ctrl')) ||
        nodeType === 'pwm_control' ||
        isControlBlock(ctype)
      ) {
        controlNets.add(net);
      }
    }
  }
  for (const net of powerNets) controlNets.delete(net);

  const out = new Map<string, Side>();
  for (const [cid, sym] of symbols) {
    const meta = sym.meta;
    if (['LABEL', 'GND', 'PORT'].includes(sym.type) || meta.bare) {
      out.set(cid, null);
      continue;
    }
    if (sym.type === 'SHEET') {
      out.set(cid, 'control');
      continue;
    }
    if (main.has(cid)) {
      out.set(cid, 'main');
      continue;
    }
    const comp = refs.get(meta.ref ?? '') ?? {};
    const ctype = comp.type;
    const params = paramsOf(comp);
    if (isControlPart(ctype, params.node_type)) {
      out.set(cid, 'control');
    } else if (POWER_DEVICES.has(ctype as string)) {
      out.set(cid, 'main');
    } else {
      const used = [...(compNets.get(meta.ref ?? '')?.values() ?? [])].filter(
        (n) => n !== '0',
      );
      if (used.some((n) => controlNets.has(n))) out.set(cid, 'control');
      else if (used.some((n) => powerNets.has(n))) out.set(cid, 'main');
      else if (
        ['resistor', 'capacitor', 'inductor'].includes(ctype as string)
      ) {
        out.set(cid, '?'); // private nets only (a snubber's middle node)
      } else if (
        params.node_type === 'voltage_source' &&
        !['pulse', 'pwl'].includes(pyStr(or(params.source, 'dc')).toLowerCase())
      ) {
        out.set(cid, '?source'); // an AC / DC source follows what it feeds
      } else {
        out.set(cid, 'control');
      }
    }
  }

  // Undecided parts take the side of the parts they connect to.
  for (let pass = 0; pass < 4; pass += 1) {
    for (const [cid, sym] of symbols) {
      const side = out.get(cid);
      if (side !== '?' && side !== '?source') continue;
      const ref = sym.meta.ref ?? '';
      const kinds = new Set<Side>();
      for (const net of compNets.get(ref)?.values() ?? []) {
        if (net === '0') continue;
        for (const [otherRef, pins] of compNets) {
          const other = out.get(otherRef);
          if (
            otherRef !== ref &&
            [...pins.values()].includes(net) &&
            (other === 'main' || other === 'control')
          ) {
            kinds.add(other);
          }
        }
      }
      if (kinds.size) out.set(cid, kinds.has('main') ? 'main' : 'control');
    }
  }
  for (const [cid, side] of out) {
    if (side === '?') out.set(cid, 'main');
    else if (side === '?source') out.set(cid, 'control');
  }

  // A control part wired only to the power stage (a PWM source driving a
  // gate directly) is drawn with it.
  const members = new Map<string, Set<string>>();
  for (const [ref, pins] of compNets) {
    for (const net of pins.values()) {
      if (net === '0') continue;
      if (!members.has(net)) members.set(net, new Set());
      members.get(net)?.add(ref);
    }
  }
  for (const [cid, sym] of symbols) {
    if (out.get(cid) !== 'control') continue;
    const ref = sym.meta.ref ?? '';
    const neighbours = new Set<string>();
    for (const net of compNets.get(ref)?.values() ?? []) {
      if (net === '0') continue;
      for (const o of members.get(net) ?? []) if (o !== ref) neighbours.add(o);
    }
    const kinds = new Set<Side>();
    for (const o of neighbours) {
      if (out.has(o) && out.get(o) !== null) kinds.add(out.get(o) as Side);
    }
    if (kinds.size === 1 && kinds.has('main')) out.set(cid, 'main');
  }
  return out as Map<string, Region>;
}

const GENERATED = /^(?:n\d+|N\d+|net\d+)$/;

/** Readable net names: the net's own name, or "REF.pin" of a member for generated names. */
export function netNamer(
  compNets: CompNets,
  symbols: Symbols,
): (net: string) => string {
  const nets = netsByName(compNets);
  return (net: string) => {
    if (net === '0') return 'GND';
    if (!GENERATED.test(net)) return net;
    const reps = (nets.get(net) ?? [])
      .filter(
        ([ref]) =>
          symbols.has(ref) &&
          !['LABEL', 'GND'].includes(symbols.get(ref)?.type ?? ''),
      )
      .sort((a, b) => cmpTuple(a, b));
    return reps.length ? `${reps[0][0]}.${reps[0][1]}` : net;
  };
}

const EXPR_REF = /\b[VI]\(\s*([^,\s()]+)(?:\s*,\s*([^\s()]+))?\s*\)/gi;

/** Nodes a behavioural part reads in its expressions (V(node), V(a,b), I(Vx)). */
export function expressionNets(comp: Dict): Set<string> {
  const out = new Set<string>();
  for (const value of Object.values(paramsOf(comp))) {
    if (typeof value !== 'string' || !value.includes('(')) continue;
    for (const m of value.matchAll(EXPR_REF)) {
      if (m[1]) out.add(m[1]);
      if (m[2]) out.add(m[2]);
    }
  }
  return out;
}
