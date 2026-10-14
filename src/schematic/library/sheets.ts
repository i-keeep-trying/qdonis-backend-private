/**
 * Hierarchical sheets. Groups are presentation only (the netlist stays flat):
 * a group's parts are drawn on their own sheet; on the top sheet the group is
 * one block (`SHEET`, id `#<group>`) with a pin per net that leaves it, and on
 * the group's sheet those nets are ports (`PORT`, id `^<group>:<net>`). A
 * sheet view is the circuit as one sheet sees it, so the placer, router and
 * editor run on it unchanged. Port of qdonis-core `schematic_sheets.py`.
 */

import type { CompNets } from '../../simulation/netlist/comp-nets';
import { isDict, or, pyStr, type Dict } from '../../simulation/netlist/py';
import type {
  SchematicGroup,
  SchematicLayout,
  SchematicSymbol,
} from '../schematic.types';
import {
  byRef,
  cmpStr,
  expressionNets,
  sortedStr,
  type Symbols,
} from './model';
import { autoGroups } from './auto-groups';
import { paramsOf } from './symbols';
import { roundHalfEven } from './geometry';

export type Groups = Map<string, SchematicGroup>;
export type Sheet = string | null;

export const blockId = (group: string): string => `#${group}`;
export const portId = (group: string, net: string): string =>
  `^${group}:${net}`;

const BLOCK_OUTPUTS = new Set(['out', 'g']);
const DRIVER_PINS: Readonly<Record<string, ReadonlySet<string>>> = {
  b_source: new Set(['+', 'pos']),
  e_source: new Set(['+', 'pos']),
  g_source: new Set(['+', 'pos']),
  // control blocks drive their outputs
  ...Object.fromEntries(
    [
      'gain',
      'sum',
      'product',
      'const',
      'function',
      'limiter',
      'comparator',
      'integrator',
      'lowpass',
      'pi',
      'pid',
      'carrier',
      'pwm',
      'gate_driver',
      'and',
      'or',
      'not',
      'xor',
    ].map((t) => [t, BLOCK_OUTPUTS]),
  ),
};

/** [groups, explicit]: the layout's grouping wins; otherwise the automatic proposal. */
export function resolveGroups(
  circuit: Dict,
  compNets: CompNets,
  symbols: Symbols,
  layout: SchematicLayout | null,
  drawing: Dict | null,
): [Groups, boolean] {
  const stored = layout?.groups as unknown;
  if (!isDict(stored)) {
    const drawn = new Set(
      (Array.isArray(drawing?.components) ? drawing.components : [])
        .filter(isDict)
        .map((c) => pyStr(c.id ?? null)),
    );
    return [autoGroups(circuit, compNets, symbols, drawn), false];
  }
  const out: Groups = new Map();
  for (const [gid, g] of Object.entries(stored)) {
    if (!isDict(g)) continue;
    const members = Array.isArray(g.members) ? (g.members as unknown[]) : [];
    const refs = members.map((r) => pyStr(r)).filter((r) => symbols.has(r));
    if (refs.length) {
      out.set(gid, { label: pyStr(or(g.label, gid)), members: refs });
    }
  }
  return [out, true];
}

const refOf = (sym: SchematicSymbol, cid: string): string =>
  sym.meta.bare ? sym.meta.bare[0] : (sym.meta.ref ?? cid);

/** Sheet of every symbol (null = top); labels / grounds go where most neighbours are. */
export function membership(
  symbols: Symbols,
  compNets: CompNets,
  groups: Groups,
): Map<string, Sheet> {
  const out = new Map<string, Sheet>();
  for (const cid of symbols.keys()) out.set(cid, null);
  for (const [gid, g] of groups) {
    for (const ref of g.members) if (out.has(ref)) out.set(ref, gid);
  }
  const explicit = new Set([...groups.values()].flatMap((g) => g.members));

  const refOfCid = new Map<string, string>();
  for (const [cid, sym] of symbols) refOfCid.set(cid, refOf(sym, cid));
  const members = new Map<string, Set<string>>();
  for (const [ref, pins] of compNets) {
    for (const net of pins.values()) {
      if (net === '0') continue;
      if (!members.has(net)) members.set(net, new Set());
      members.get(net)?.add(ref);
    }
  }
  const owner = new Map<string, string>();
  for (const cid of symbols.keys()) {
    const ref = refOfCid.get(cid) as string;
    if (!owner.has(ref)) owner.set(ref, cid);
  }

  for (const [cid, sym] of symbols) {
    const floating =
      sym.type === 'LABEL' || sym.type === 'GND' || sym.meta.bare;
    if (!floating || explicit.has(cid)) continue;
    const ref = refOfCid.get(cid) as string;
    const pins = compNets.get(ref) ?? new Map<string, string>();
    const nets = sym.meta.bare
      ? [pins.get(sym.meta.bare[1])]
      : [...pins.values()];
    const votes = new Map<Sheet, number>();
    for (const net of nets) {
      if (!net || net === '0') continue;
      for (const other of members.get(net) ?? []) {
        if (other === ref) continue;
        const ocid = owner.get(other);
        const osym = ocid === undefined ? undefined : symbols.get(ocid);
        if (
          !osym ||
          osym.type === 'LABEL' ||
          osym.type === 'GND' ||
          osym.meta.bare
        ) {
          continue;
        }
        const sheet = out.get(ocid as string) ?? null;
        votes.set(sheet, (votes.get(sheet) ?? 0) + 1);
      }
    }
    if (votes.size) {
      const top = Math.max(...votes.values());
      const choices = [...votes].filter(([, n]) => n === top).map(([g]) => g);
      out.set(
        cid,
        choices.includes(null) ? null : sortedStr(choices as string[])[0],
      );
    } else if (sym.type === 'GND') {
      out.set(cid, null);
    }
  }
  return out;
}

/** Nets driven from inside `refs` (source outputs). */
function drivenNets(
  refs: Map<string, Dict>,
  compNets: CompNets,
  inside: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  for (const ref of inside) {
    const comp = refs.get(ref) ?? {};
    const ctype = pyStr(comp.type);
    const nodeType = paramsOf(comp).node_type;
    const pins = compNets.get(ref) ?? new Map<string, string>();
    for (const [pin, net] of pins) {
      const driver = Object.hasOwn(DRIVER_PINS, ctype)
        ? DRIVER_PINS[ctype]
        : null;
      if (driver && driver.has(pin)) {
        // "pos" counts only when there is no "+" (some YAMLs carry both).
        if (pin === 'pos' && pins.has('+')) continue;
        out.add(net);
      } else if (
        (nodeType === 'pwm_control' || nodeType === 'voltage_source') &&
        ['+', 'pos', ''].includes(pin) &&
        !(pin === 'pos' && pins.has('+'))
      ) {
        out.add(net);
      }
    }
  }
  return out;
}

const CONSUMER_PINS = new Set(['gate', 'ctrl+', 'ctrl-', 'inp', 'inn', 'in']);

/** direction(net, inside) -> "in" / "out" for a net crossing a group boundary. */
function directionFn(
  refs: Map<string, Dict>,
  compNets: CompNets,
): (net: string, inside: ReadonlySet<string>) => 'in' | 'out' {
  const drivers = new Map<string, Set<string>>();
  for (const ref of compNets.keys()) {
    for (const net of drivenNets(refs, compNets, [ref])) {
      if (!drivers.has(net)) drivers.set(net, new Set());
      drivers.get(net)?.add(ref);
    }
  }
  const members = new Map<string, Array<[string, string]>>();
  for (const [ref, pins] of compNets) {
    for (const [pin, net] of pins) {
      if (!members.has(net)) members.set(net, []);
      members.get(net)?.push([ref, pin]);
    }
  }
  const driversOf = (net: string) => drivers.get(net) ?? new Set<string>();

  /** Nets reached through up to three series resistors / inductors on one side. */
  const throughPassives = (net: string, onSide: (ref: string) => boolean) => {
    const seen = new Set([net]);
    let frontier = [net];
    for (let step = 0; step < 3; step += 1) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const [ref] of members.get(n) ?? []) {
          const type = refs.get(ref)?.type;
          if (!onSide(ref) || (type !== 'resistor' && type !== 'inductor'))
            continue;
          for (const other of compNets.get(ref)?.values() ?? []) {
            if (!seen.has(other) && other !== '0') {
              seen.add(other);
              next.push(other);
            }
          }
        }
      }
      frontier = next;
    }
    seen.delete(net);
    return seen;
  };

  return (net, inside) => {
    const all = driversOf(net);
    const ins = [...all].filter((r) => inside.has(r));
    const outs = [...all].filter((r) => !inside.has(r));
    if (ins.length && !outs.length) return 'out';
    if (outs.length && !ins.length) return 'in';
    if (!ins.length && !outs.length) {
      const fromIn = [...throughPassives(net, (r) => inside.has(r))].some((n) =>
        [...driversOf(n)].some((r) => inside.has(r)),
      );
      const fromOut = [...throughPassives(net, (r) => !inside.has(r))].some(
        (n) => [...driversOf(n)].some((r) => !inside.has(r)),
      );
      if (fromIn !== fromOut) return fromIn ? 'out' : 'in';
      const outside = (members.get(net) ?? []).filter(([r]) => {
        const comp = refs.get(r);
        if (inside.has(r) || !comp) return false;
        const nodeType = paramsOf(comp).node_type;
        return nodeType !== 'label' && nodeType !== 'ground';
      });
      if (
        outside.length &&
        outside.every(([, p]) => CONSUMER_PINS.has(p) || /^in\d+$/.test(p))
      ) {
        return 'out';
      }
    }
    return 'in';
  };
}

function terminalName(net: string, used: Set<string>): string {
  let name = net.replace(/[^A-Za-z0-9_+-]/g, '_') || 'net';
  while (used.has(name)) name += '_';
  used.add(name);
  return name;
}

const union = <T>(sets: Iterable<Iterable<T>>): Set<T> => {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
};

/** compNets and symbols of one sheet: visible parts plus block pins (top) or ports (group sheet). */
export function sheetView(
  circuit: Dict,
  compNets: CompNets,
  symbols: Symbols,
  groups: Groups,
  memberOf: ReadonlyMap<string, Sheet>,
  sheet: Sheet,
  netDisplay: (net: string) => string,
): [CompNets, Symbols] {
  const refs = byRef(circuit);
  const direction = directionFn(refs, compNets);
  const visible: Symbols = new Map(
    [...symbols].filter(([cid]) => (memberOf.get(cid) ?? null) === sheet),
  );

  const ownerOf = (ref: string, pin: string): Sheet => {
    const cid = symbols.has(ref)
      ? ref
      : symbols.has(`${ref}.${pin}`)
        ? `${ref}.${pin}`
        : ref;
    return memberOf.get(cid) ?? null;
  };

  const viewNets: CompNets = new Map();
  const setView = (ref: string, pin: string, net: string) => {
    if (!viewNets.has(ref)) viewNets.set(ref, new Map());
    viewNets.get(ref)?.set(pin, net);
  };
  const hiddenByNet = new Map<string, Map<Sheet, Array<[string, string]>>>();
  for (const [ref, pins] of compNets) {
    for (const [pin, net] of pins) {
      const g = ownerOf(ref, pin);
      if (g === sheet) {
        setView(ref, pin, net);
      } else {
        if (!hiddenByNet.has(net)) hiddenByNet.set(net, new Map());
        const owners = hiddenByNet.get(net) as Map<
          Sheet,
          Array<[string, string]>
        >;
        if (!owners.has(g)) owners.set(g, []);
        owners.get(g)?.push([ref, pin]);
      }
    }
  }
  const visibleNets = new Set(
    [...viewNets.values()].flatMap((pins) => [...pins.values()]),
  );

  // Sense links: nets behavioural parts read in their expressions (V(node)).
  const netByLower = new Map<string, string>();
  for (const pins of compNets.values()) {
    for (const net of pins.values()) {
      if (!netByLower.has(net.toLowerCase()))
        netByLower.set(net.toLowerCase(), net);
    }
  }
  const readsOf = new Map<string, Set<string>>();
  for (const ref of compNets.keys()) {
    const comp = refs.get(ref);
    const names = comp ? expressionNets(comp) : new Set<string>();
    const nets = new Set<string>();
    for (const n of names) {
      const net = netByLower.get(n.toLowerCase());
      if (net !== undefined && net !== '0') nets.add(net);
    }
    readsOf.set(ref, nets);
  }
  const membersOfNet = new Map<string, Set<string>>();
  for (const [ref, pins] of compNets) {
    for (const net of pins.values()) {
      if (!membersOfNet.has(net)) membersOfNet.set(net, new Set());
      membersOfNet.get(net)?.add(ref);
    }
  }
  const netMembers = (net: string) =>
    membersOfNet.get(net) ?? new Set<string>();

  /** [nets read inside whose parts are outside, nets inside that are read outside]. */
  const senseLinks = (
    inside: ReadonlySet<string>,
  ): [Set<string>, Set<string>] => {
    const readIn = union([...inside].map((r) => readsOf.get(r) ?? []));
    const senseIn = new Set(
      [...readIn].filter((n) => [...netMembers(n)].some((r) => !inside.has(r))),
    );
    const outsideReads = union(
      [...readsOf].filter(([r]) => !inside.has(r)).map(([, nets]) => nets),
    );
    const senseOut = new Set(
      [...outsideReads].filter((n) =>
        [...netMembers(n)].some((r) => inside.has(r)),
      ),
    );
    return [senseIn, senseOut];
  };

  const byDisplay = (a: string, b: string) =>
    cmpStr(netDisplay(a), netDisplay(b));
  const outSymbols: Symbols = new Map(visible);
  if (sheet === null) {
    // One block per group, with a pin for every net that leaves the group.
    for (const [gid, g] of groups) {
      const groupRefs = new Set(g.members);
      for (const [cid] of symbols)
        if (memberOf.get(cid) === gid) groupRefs.add(cid);
      const boundary: string[] = [];
      for (const [net, owners] of hiddenByNet) {
        if (net === '0' || !owners.has(gid)) continue;
        const elsewhere =
          [...owners.keys()].some((o) => o !== gid) || visibleNets.has(net);
        if (elsewhere) boundary.push(net);
      }
      const inside = new Set(
        [...groupRefs]
          .filter((c) => symbols.has(c))
          .map((c) => refOf(symbols.get(c) as SchematicSymbol, c)),
      );
      const [senseIn, senseOut] = senseLinks(inside);
      const boundarySet = new Set(boundary);
      const sense = [...union([senseIn, senseOut])].filter(
        (n) => !boundarySet.has(n),
      );
      const outs = [
        ...boundary
          .filter((n) => direction(n, inside) === 'out')
          .sort(byDisplay),
        ...[...senseOut]
          .filter((n) => !boundarySet.has(n) && !senseIn.has(n))
          .sort(byDisplay),
      ];
      const ins = [
        ...boundary
          .filter((n) => direction(n, inside) !== 'out')
          .sort(byDisplay),
        ...[...senseIn].filter((n) => !boundarySet.has(n)).sort(byDisplay),
      ];
      const used = new Set<string>();
      const table: NonNullable<SchematicSymbol['pins']> = {};
      const pins: Record<string, string> = {};
      const block = blockId(gid);
      for (const [nets, x, dx] of [
        [ins, -80, -1],
        [outs, 80, 1],
      ] as const) {
        nets.forEach((net, k) => {
          const term = terminalName(netDisplay(net), used);
          const y =
            roundHalfEven(((k - (nets.length - 1) / 2) * 40) / 20) * 20 + 0;
          table[term] = { x, y, dx, dy: 0 };
          pins[net] = term;
          setView(block, net, net);
        });
      }
      const nParts = [...groupRefs].filter((cid) => {
        const s = symbols.get(cid);
        return s && s.type !== 'LABEL' && s.type !== 'GND';
      }).length;
      outSymbols.set(block, {
        id: block,
        type: 'SHEET',
        label: g.label,
        symbol: g.label,
        pins: table,
        parameters: {},
        display: `${nParts} parts · double-click to open`,
        meta: {
          ref: block,
          sheet: gid,
          pins,
          rows: Math.max(ins.length, outs.length, 1),
          sense: sortedStr(
            sense.filter((n) => Object.hasOwn(pins, n)).map((n) => pins[n]),
          ),
        },
      });
    }
  } else {
    const inside = new Set(
      [...symbols]
        .filter(([cid]) => memberOf.get(cid) === sheet)
        .map(([cid, s]) => refOf(s, cid)),
    );
    const [senseIn, senseOut] = senseLinks(inside);
    for (const net of sortedStr(union([visibleNets, senseIn, senseOut]))) {
      if (net === '0') continue;
      const outside = [
        ...(hiddenByNet.get(net) ?? new Map<Sheet, unknown[]>()),
      ].filter(([, ms]) => ms.length > 0);
      const galvanic = visibleNets.has(net) && outside.length > 0;
      if (!galvanic && !senseIn.has(net) && !senseOut.has(net)) continue;
      const pid = portId(sheet, net);
      const name = netDisplay(net);
      setView(pid, 'p', net);
      outSymbols.set(pid, {
        id: pid,
        type: 'PORT',
        label: name,
        parameters: { net_name: name },
        display: '',
        meta: {
          ref: pid,
          port: net,
          pins: { p: 'P' },
          sense: !galvanic,
          direction: galvanic
            ? direction(net, inside)
            : senseIn.has(net)
              ? 'in'
              : 'out',
          // parts of this sheet whose expressions read the net
          readers: sortedStr(
            [...inside].filter(
              (r) => visible.has(r) && (readsOf.get(r)?.has(net) ?? false),
            ),
          ),
        },
      });
    }
  }
  return [viewNets, outSymbols];
}
