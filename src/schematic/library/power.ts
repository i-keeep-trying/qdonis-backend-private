/**
 * Power-stage structure for a layout from scratch. A power schematic reads by
 * its structure: DC rails top and bottom, switching legs as vertical columns
 * between them, power flowing left to right. This finds the structure and
 * places that skeleton; `render` places everything else around it.
 * Port of qdonis-core `schematic_power.py`.
 *
 * - device: conducts between an upper and a lower terminal (drain-source,
 *   switch pos-neg, diode cathode-anode);
 * - top rail: net with upper terminals only; bottom rail: lower only;
 *   midpoint: both;
 * - leg: devices from a top rail down through midpoints to a bottom rail;
 * - bridge: legs sharing their rails; rail column: passives / sources from a
 *   bridge's top rail to its bottom rail (DC link, source, split capacitors).
 *
 * 0 V sense sources and tiny series resistors count as wire.
 */

import type { CompNets } from '../../simulation/netlist/comp-nets';
import { or, pyStr, type Dict } from '../../simulation/netlist/py';
import type { Placement, SchematicSymbol } from '../schematic.types';
import { pinPoint, snap } from './geometry';
import {
  byRef,
  cmpStr,
  cmpTuple,
  flat,
  sortedStr,
  type Region,
  type Symbols,
} from './model';
import { paramsOf } from './symbols';
import { parseNumber } from './values';

/** type -> [upper pin, lower pin] */
const DEVICE_PINS: Readonly<Record<string, readonly [string, string]>> = {
  transistor: ['drain', 'source'],
  mosfet: ['drain', 'source'],
  igbt: ['drain', 'source'],
  'vg-fet': ['drain', 'source'],
  switch: ['pos', 'neg'],
  diode: ['cathode', 'anode'],
};
const TINY_OHMS = 0.05;

/** Union-find over nets; ground stays the representative. */
class Merge {
  private readonly parent = new Map<string, string>();

  find(a: string): string {
    if (!this.parent.has(a)) this.parent.set(a, a);
    let x = a;
    while (this.parent.get(x) !== x) {
      this.parent.set(
        x,
        this.parent.get(this.parent.get(x) as string) as string,
      );
      x = this.parent.get(x) as string;
    }
    return x;
  }

  union(a: string, b: string): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (rb === '0') [ra, rb] = [rb, ra];
    this.parent.set(rb, ra);
  }
}

/** A part that counts as wire: a 0 V DC source or a tiny resistor. */
function transparent(comp: Dict): boolean {
  const params = paramsOf(comp);
  if (comp.type === 'node' && params.node_type === 'voltage_source') {
    const v = parseNumber(
      Object.hasOwn(params, 'voltage') ? params.voltage : params.dc,
    );
    const src = pyStr(or(params.source, 'dc')).toLowerCase();
    return v !== null && Math.abs(v) < 1e-12 && (src === 'dc' || src === '');
  }
  if (comp.type === 'resistor') {
    const r = parseNumber(params.resistance);
    return r !== null && r >= 0 && r <= TINY_OHMS;
  }
  return false;
}

interface Bridge {
  top: string;
  bottom: string;
  legs: string[][];
  midpoints: string[][];
}

export interface Structure {
  bridges: Bridge[];
  /** device -> the representative it is parallel to */
  parallel: Map<string, string>;
  columns: Array<{ top: string; bottom: string; parts: string[] }>;
  /** original net -> merged net */
  net: Map<string, string>;
  /** device -> [upper net, lower net] */
  upper: Map<string, [string, string]>;
}

const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];

/** Order legs by phase / index in their names (A, B, C / 1, 2, 3). */
function legKey(path: string[]): Array<string | number> {
  const name = path[0];
  const m = /([A-Ca-c])(?:_?\w{0,3})?$/.exec(name);
  const digits = name.match(/\d+/);
  return [
    m ? m[1].toUpperCase() : '~',
    digits ? Number.parseInt(digits[0], 10) : 0,
    name,
  ];
}

/** Structure of the power stage (parts limited to `refs` when given). */
export function analyse(
  circuit: Dict,
  compNets: CompNets,
  refs: ReadonlySet<string> | null = null,
): Structure {
  const parts = byRef(circuit);
  const scope = [...parts.keys()].filter((r) => refs === null || refs.has(r));
  const merge = new Merge();
  for (const ref of scope) {
    const nets = unique(compNets.get(ref)?.values() ?? []);
    if (transparent(parts.get(ref) as Dict) && nets.length === 2) {
      merge.union(nets[0], nets[1]);
    }
  }
  const net = (n: string) => merge.find(n);

  const devices = new Map<string, [string, string]>();
  for (const ref of sortedStr(scope)) {
    const pins = DEVICE_PINS[pyStr(parts.get(ref)?.type)] as
      readonly [string, string] | undefined;
    if (!pins) continue;
    const p = compNets.get(ref) ?? new Map<string, string>();
    const u = p.get(pins[0]);
    const l = p.get(pins[1]);
    if (u !== undefined && l !== undefined && net(u) !== net(l)) {
      devices.set(ref, [net(u), net(l)]);
    }
  }

  // Parallel devices collapse onto one representative (a switch).
  const isDiode = (r: string) => parts.get(r)?.type === 'diode';
  const byPair = new Map<string, string[]>();
  for (const [ref, [u, l]] of devices) {
    const key = JSON.stringify([u, l].sort(cmpStr));
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)?.push(ref);
  }
  const parallel = new Map<string, string>();
  const reps = new Map<string, [string, string]>();
  for (const group of byPair.values()) {
    group.sort((a, b) => cmpTuple([isDiode(a), a], [isDiode(b), b]));
    // An anti-parallel diode tells which side is up more reliably than a
    // switch whose YAML may have drain and source swapped.
    const diodes = group.filter(isDiode);
    reps.set(
      group[0],
      devices.get(diodes.length && group.length > 1 ? diodes[0] : group[0]) as [
        string,
        string,
      ],
    );
    for (const other of group.slice(1)) parallel.set(other, group[0]);
  }

  const ups = new Map<string, string[]>();
  const lows = new Map<string, string[]>();
  for (const [ref, [u, l]] of reps) {
    if (!ups.has(u)) ups.set(u, []);
    ups.get(u)?.push(ref);
    if (!lows.has(l)) lows.set(l, []);
    lows.get(l)?.push(ref);
  }
  const tops = new Set([...ups.keys()].filter((n) => !lows.get(n)?.length));
  const bottoms = new Set([...lows.keys()].filter((n) => !ups.get(n)?.length));

  // Legs: walk down from a top rail through midpoints to a bottom rail.
  const legs: Array<[string, string, string[], string[]]> = [];
  const walk = (at: string, path: string[], mids: string[], start: string) => {
    if (path.length > 6) return;
    for (const dev of sortedStr(ups.get(at) ?? [])) {
      if (path.includes(dev)) continue;
      const lower = (reps.get(dev) as [string, string])[1];
      if (bottoms.has(lower)) {
        if (path.length + 1 >= 2)
          legs.push([start, lower, [...path, dev], mids]);
        continue;
      }
      if (tops.has(lower)) continue;
      walk(lower, [...path, dev], [...mids, lower], start);
    }
  };
  for (const top of sortedStr(tops)) walk(top, [], [], top);

  // A device belongs to one leg: rails many legs share first, then longer
  // legs, then legs of switches rather than diodes.
  const topPop = new Map<string, number>();
  const bottomPop = new Map<string, number>();
  for (const [top, bottom] of legs) {
    topPop.set(top, (topPop.get(top) ?? 0) + 1);
    bottomPop.set(bottom, (bottomPop.get(bottom) ?? 0) + 1);
  }
  const legSort = (l: (typeof legs)[number]) => [
    -((topPop.get(l[0]) ?? 0) + (bottomPop.get(l[1]) ?? 0)),
    -l[2].length,
    l[2].filter(isDiode).length,
  ];
  legs.sort((a, b) => cmpTuple(legSort(a), legSort(b)) || cmpTuple(a[2], b[2]));
  const used = new Set<string>();
  const bridges = new Map<string, Bridge>();
  for (const [top, bottom, path, mids] of legs) {
    if (path.some((d) => used.has(d))) continue;
    for (const d of path) used.add(d);
    const key = JSON.stringify([top, bottom]);
    if (!bridges.has(key))
      bridges.set(key, { top, bottom, legs: [], midpoints: [] });
    const b = bridges.get(key) as Bridge;
    b.legs.push(path);
    b.midpoints.push(mids);
  }
  for (const b of bridges.values()) {
    const order = b.legs
      .map((_, i) => i)
      .sort((i, j) => cmpTuple(legKey(b.legs[i]), legKey(b.legs[j])));
    b.legs = order.map((i) => b.legs[i]);
    b.midpoints = order.map((i) => b.midpoints[i]);
  }

  // Rail columns: chains of non-device parts from a bridge's top rail to its bottom rail.
  const members = new Map<string, Set<string>>();
  for (const ref of scope) {
    for (const n of compNets.get(ref)?.values() ?? []) {
      if (!members.has(net(n))) members.set(net(n), new Set());
      members.get(net(n))?.add(ref);
    }
  }
  const columns: Structure['columns'] = [];
  const taken = new Set([...devices.keys(), ...parallel.keys()]);
  // Chains may pass any net except the legs' own midpoints and rails.
  const deviceNets = new Set<string>();
  for (const b of bridges.values()) {
    for (const mids of b.midpoints) for (const n of mids) deviceNets.add(n);
    deviceNets.add(b.top);
    deviceNets.add(b.bottom);
  }
  for (const b of bridges.values()) {
    for (const chain of passiveChains(
      b.top,
      b.bottom,
      compNets,
      parts,
      net,
      members,
      taken,
      deviceNets,
    )) {
      columns.push({ top: b.top, bottom: b.bottom, parts: chain });
      for (const r of chain) taken.add(r);
    }
  }

  const netMap = new Map<string, string>();
  for (const pins of compNets.values())
    for (const n of pins.values()) netMap.set(n, net(n));
  const upper = new Map(reps);
  for (const d of parallel.keys())
    upper.set(d, devices.get(d) as [string, string]);
  return {
    bridges: [...bridges.values()],
    parallel,
    columns,
    net: netMap,
    upper,
  };
}

function twoTerminalNets(
  ref: string,
  compNets: CompNets,
  net: (n: string) => string,
): [string, string] | null {
  const nets = unique([...(compNets.get(ref)?.values() ?? [])].map(net));
  return nets.length === 2 ? [nets[0], nets[1]] : null;
}

/**
 * Chains (1-3 parts) of two-terminal passives / sources from `top` to
 * `bottom`; shortest first, each part once.
 */
function passiveChains(
  top: string,
  bottom: string,
  compNets: CompNets,
  parts: Map<string, Dict>,
  net: (n: string) => string,
  members: Map<string, Set<string>>,
  taken: ReadonlySet<string>,
  deviceNets: ReadonlySet<string>,
): string[][] {
  const out: string[][] = [];
  const ok = (ref: string) => {
    const comp = parts.get(ref) as Dict;
    return (
      !taken.has(ref) &&
      (['capacitor', 'resistor', 'inductor'].includes(pyStr(comp.type)) ||
        paramsOf(comp).node_type === 'voltage_source')
    );
  };
  const dfs = (n: string, path: string[], seen: ReadonlySet<string>) => {
    if (path.length > 3) return;
    for (const ref of sortedStr(members.get(n) ?? [])) {
      if (path.includes(ref) || !ok(ref)) continue;
      const pair = twoTerminalNets(ref, compNets, net);
      if (!pair || !pair.includes(n)) continue;
      const other = pair[0] === n ? pair[1] : pair[0];
      if (other === bottom) {
        out.push([...path, ref]);
        continue;
      }
      if (
        seen.has(other) ||
        other === top ||
        (deviceNets.has(other) && other !== bottom)
      ) {
        continue;
      }
      dfs(other, [...path, ref], new Set([...seen, other]));
    }
  };
  dfs(top, [], new Set([top]));
  out.sort((a, b) => a.length - b.length);
  const used = new Set<string>();
  const result: string[][] = [];
  for (const chain of out) {
    if (chain.some((r) => used.has(r))) continue;
    for (const r of chain) used.add(r);
    result.push(chain);
  }
  return result;
}

/** Horizontal distance between legs (room for the anti-parallel diode and a snubber pair). */
const LEG_PITCH = 340;
/** Horizontal distance between rail columns. */
const COLUMN_PITCH = 160;
/** Vertical distance between the devices of a leg. */
const DEVICE_PITCH = 200;
/** Horizontal gap between two bridges. */
const BRIDGE_GAP = 520;
const FAR = 10 ** 6;

/** A real bridge (two or more legs) or a multi-level leg. */
const worthIt = (structure: Structure) =>
  structure.bridges.some(
    (b) => b.legs.length >= 2 || b.legs.some((leg) => leg.length >= 3),
  );

const probe = (sym: SchematicSymbol, rotation: number): SchematicSymbol => ({
  ...sym,
  x: 0,
  y: 0,
  rotation,
  mirrorX: false,
  mirrorY: false,
});

/** Rotation that puts `upper` straight above `lower`. */
function orientVertical(
  sym: SchematicSymbol,
  upper: string,
  lower: string,
): number {
  let best = 0;
  let score: number[] | null = null;
  for (const rotation of [0, 180, 90, 270]) {
    const [ux, uy] = pinPoint(probe(sym, rotation), upper);
    const [lx, ly] = pinPoint(probe(sym, rotation), lower);
    const s = [uy < ly ? 0 : 1, Math.abs(ux - lx)];
    if (score === null || cmpTuple(s, score) < 0) [best, score] = [rotation, s];
  }
  return best;
}

/** Rotation that puts `left` straight left of `right`. */
function orientHorizontal(
  sym: SchematicSymbol,
  left: string,
  right: string,
): number {
  let best = 90;
  let score: number[] | null = null;
  for (const rotation of [90, 270, 0, 180]) {
    const [lx, ly] = pinPoint(probe(sym, rotation), left);
    const [rx, ry] = pinPoint(probe(sym, rotation), right);
    const s = [lx < rx ? 0 : 1, Math.abs(ly - ry)];
    if (score === null || cmpTuple(s, score) < 0) [best, score] = [rotation, s];
  }
  return best;
}

/** The symbol terminal whose YAML pin is on (merged) net `target`. */
function terminalOn(
  sym: SchematicSymbol,
  compNets: CompNets,
  netOf: (n: string) => string,
  target: string,
): string | null {
  const pins = compNets.get(sym.meta.ref ?? '');
  for (const [pin, terminal] of Object.entries(sym.meta.pins)) {
    if (netOf(pins?.get(pin) ?? '') === target) return terminal;
  }
  return null;
}

/** Hops from the main input source to every (merged) net. */
function flowDistance(
  circuit: Dict,
  compNets: CompNets,
  structure: Structure,
): Map<string, number> {
  const netOf = (n: string) => structure.net.get(n) ?? n;
  let best: string | null = null;
  let bestV = -1;
  for (const [comp] of flat(circuit)) {
    const params = paramsOf(comp);
    if (comp.type !== 'node' || params.node_type !== 'voltage_source') continue;
    const v = parseNumber(params.amplitude) || parseNumber(params.voltage) || 0;
    if (Math.abs(v) > bestV) [best, bestV] = [pyStr(comp.ref), Math.abs(v)];
  }
  const adj = new Map<string, Set<string>>();
  for (const pins of compNets.values()) {
    const nets = new Set(
      [...pins.values()].filter((n) => n !== '0').map(netOf),
    );
    for (const a of nets) {
      if (!adj.has(a)) adj.set(a, new Set());
      for (const b of nets) if (b !== a) adj.get(a)?.add(b);
    }
  }
  const dist = new Map<string, number>();
  if (best !== null) {
    const queue = [...(compNets.get(best)?.values() ?? [])]
      .filter((n) => n !== '0')
      .map(netOf);
    for (const n of queue) dist.set(n, 0);
    while (queue.length) {
      const a = queue.shift() as string;
      for (const b of adj.get(a) ?? []) {
        if (!dist.has(b)) {
          dist.set(b, (dist.get(a) as number) + 1);
          queue.push(b);
        }
      }
    }
  }
  return dist;
}

/**
 * Positions for the power stage of this sheet (empty when it has no bridge):
 * legs as vertical columns, rail columns beside them, each switch's
 * anti-parallel diode and RC snubber beside it, gate drive left of the gate,
 * and the power-flow chain from the midpoints outwards.
 */
export function skeleton(
  circuit: Dict,
  compNets: CompNets,
  symbols: Symbols,
  region: ReadonlyMap<string, Region>,
): Map<string, Placement> {
  const refs = new Set(
    [...symbols]
      .filter(
        ([cid, sym]) => region.get(cid) === 'main' && sym.meta.ref === cid,
      )
      .map(([cid]) => cid),
  );
  const structure = analyse(circuit, compNets, refs);
  const positions = new Map<string, Placement>();
  if (!worthIt(structure)) return positions;

  const parts = byRef(circuit);
  const netOf = (n: string) => structure.net.get(n) ?? n;
  const dist = flowDistance(circuit, compNets, structure);
  const d = (n: string) => dist.get(n) ?? FAR;

  const members = new Map<string, Set<string>>();
  const netsOf = new Map<string, string[]>();
  for (const ref of refs) {
    const merged: string[] = [];
    for (const n of compNets.get(ref)?.values() ?? []) {
      if (!members.has(netOf(n))) members.set(netOf(n), new Set());
      members.get(netOf(n))?.add(ref);
      if (!merged.includes(netOf(n))) merged.push(netOf(n));
    }
    netsOf.set(ref, merged);
  }
  const membersOf = (n: string) => members.get(n) ?? new Set<string>();
  const nets = (ref: string) => netsOf.get(ref) ?? [];
  const rails = new Set([
    '0',
    ...structure.bridges.flatMap((b) => [b.top, b.bottom]),
  ]);
  const devices = new Set(structure.upper.keys());
  const netPos = new Map<string, [number, number]>();

  const putVertical = (
    ref: string,
    x: number,
    y: number,
    upperNet: string,
    lowerNet?: string,
  ) => {
    const sym = symbols.get(ref);
    if (!sym) return;
    const upper = terminalOn(sym, compNets, netOf, upperNet);
    let lower = lowerNet ? terminalOn(sym, compNets, netOf, lowerNet) : null;
    if (!lower)
      lower = Object.values(sym.meta.pins).find((t) => t !== upper) ?? null;
    const rotation = upper && lower ? orientVertical(sym, upper, lower) : 0;
    positions.set(ref, {
      x: snap(x),
      y: snap(y),
      rotation,
      mirrorX: false,
      mirrorY: false,
    });
  };
  const putHorizontal = (
    ref: string,
    x: number,
    y: number,
    nearNet: string,
    direction: number,
  ) => {
    const sym = symbols.get(ref);
    if (!sym) return;
    const near = terminalOn(sym, compNets, netOf, nearNet);
    const others = Object.values(sym.meta.pins).filter((t) => t !== near);
    let rotation = 90;
    if (near && others.length) {
      rotation =
        direction > 0
          ? orientHorizontal(sym, near, others[0])
          : orientHorizontal(sym, others[0], near);
    }
    positions.set(ref, {
      x: snap(x),
      y: snap(y),
      rotation,
      mirrorX: false,
      mirrorY: false,
    });
  };

  /** A PWM source / gate resistor driving the device: just left of its gate. */
  const placeGateDrive = (dev: string, lowNet: string) => {
    const sym = symbols.get(dev);
    const place = positions.get(dev);
    if (!sym || !place) return;
    const pins = compNets.get(dev) ?? new Map<string, string>();
    const gatePin = pins.has('gate')
      ? 'gate'
      : pins.has('ctrl+')
        ? 'ctrl+'
        : null;
    if (!gatePin) return;
    const terminal = sym.meta.pins[gatePin];
    if (!terminal) return;
    const [gx, gy] = pinPoint({ ...sym, ...place }, terminal);
    const gateNet = netOf(pins.get(gatePin) as string);
    for (const part of sortedStr(membersOf(gateNet))) {
      if (positions.has(part) || devices.has(part) || nets(part).length !== 2)
        continue;
      const other = nets(part).filter((n) => n !== gateNet)[0];
      if (other === lowNet || other === '0') {
        putVertical(part, gx - 100, gy + 40, gateNet); // PWM source / gate-source resistor
      } else {
        putHorizontal(part, gx - 90, gy, other, 1); // gate resistor; its driver further left
        for (const drv of sortedStr(membersOf(other))) {
          if (
            !positions.has(drv) &&
            !devices.has(drv) &&
            nets(drv).length === 2
          ) {
            putVertical(drv, gx - 200, gy + 40, other);
            break;
          }
        }
      }
    }
  };

  const bridgeDistance = (b: Bridge) =>
    Math.min(d(b.top), d(b.bottom), ...b.midpoints.flat().map(d));
  const bridges = [...structure.bridges].sort(
    (a, b) =>
      bridgeDistance(a) - bridgeDistance(b) || b.legs.length - a.legs.length,
  );
  const columnsOf = new Map<string, string[][]>();
  for (const col of structure.columns) {
    const key = JSON.stringify([col.top, col.bottom]);
    if (!columnsOf.has(key)) columnsOf.set(key, []);
    columnsOf.get(key)?.push(col.parts);
  }

  let x = 0;
  for (const b of bridges) {
    const height =
      Math.max(...b.legs.map((leg) => leg.length), 2) * DEVICE_PITCH;
    const yTop = 0;
    const cols = columnsOf.get(JSON.stringify([b.top, b.bottom])) ?? [];
    const railD = Math.min(d(b.top), d(b.bottom));
    const mids = b.midpoints.flat();
    const midD = mids.length ? Math.min(...mids.map(d)) : FAR;
    // strictly closer: when the source reaches both alike, it is drawn on the midpoint side
    const columnsLeft = railD < midD;
    const direction = columnsLeft ? 1 : -1;

    const placeColumn = (chain: string[], cx: number) => {
      let upperNet = b.top;
      chain.forEach((ref, k) => {
        putVertical(
          ref,
          cx,
          yTop + ((k + 0.5) * height) / chain.length,
          upperNet,
        );
        const next = nets(ref).filter((n) => n !== upperNet);
        upperNet = next.length ? next[0] : upperNet;
      });
    };

    if (columnsLeft) {
      for (const chain of cols) {
        placeColumn(chain, x);
        x += COLUMN_PITCH;
      }
      x += 60;
    }
    const firstLegX = x;
    const legDevices = new Set(b.legs.flat());

    /** Devices hanging off a leg midpoint (T-type neutral switches, NPC clamps), outwards. */
    const branchFrom = (mid: string): string[] => {
      const chain: string[] = [];
      let cur = mid;
      const seen = new Set([mid]);
      for (;;) {
        const next = sortedStr(membersOf(cur)).filter(
          (dv) =>
            devices.has(dv) &&
            !legDevices.has(dv) &&
            !positions.has(dv) &&
            !chain.includes(dv) &&
            !structure.parallel.has(dv),
        );
        if (!next.length) return chain;
        const dv = next[0];
        chain.push(dv);
        const farNets = nets(dv).filter((n) => n !== cur);
        if (!farNets.length) return chain;
        cur = farNets[0];
        if (
          seen.has(cur) ||
          rails.has(cur) ||
          [...membersOf(cur)].filter((m) => devices.has(m)).length > 2
        ) {
          return chain;
        }
        seen.add(cur);
      }
    };

    for (const leg of b.legs) {
      const n = leg.length;
      let branchExtra = 0;
      leg.forEach((ref, k) => {
        const cy = yTop + ((k + 0.5) * height) / n;
        const [upNet, lowNet] = structure.upper.get(ref) as [string, string];
        putVertical(ref, x, cy, upNet, lowNet);
        placeGateDrive(ref, lowNet);
        // Companions: anti-parallel diodes, then an RC snubber across the device.
        let cx = x + 100;
        for (const [dv, rep] of structure.parallel) {
          if (rep !== ref) continue;
          putVertical(
            dv,
            cx,
            cy,
            ...(structure.upper.get(dv) as [string, string]),
          );
          cx += 70;
        }
        // passives straight across the device (drain capacitance, bleeder)
        const across = sortedStr(
          [...membersOf(upNet)].filter((r) => membersOf(lowNet).has(r)),
        );
        for (const pa of across) {
          const pn = nets(pa);
          if (positions.has(pa) || devices.has(pa)) continue;
          if (!(
            new Set(pn).size === 2 &&
            pn.includes(upNet) &&
            pn.includes(lowNet)
          ))
            continue;
          putVertical(pa, cx, cy, upNet, lowNet);
          cx += 70;
        }
        for (const pa of sortedStr(
          new Set([...membersOf(upNet), ...membersOf(lowNet)]),
        )) {
          if (positions.has(pa) || devices.has(pa) || nets(pa).length !== 2)
            continue;
          const aNets = nets(pa);
          const end = aNets.includes(upNet) ? upNet : lowNet;
          const priv = aNets[0] === end ? aNets[1] : aNets[0];
          if (rails.has(priv) || priv === upNet || priv === lowNet) continue;
          const partners = [...membersOf(priv)].filter(
            (q) => q !== pa && !positions.has(q) && !devices.has(q),
          );
          const otherEnd = end === upNet ? lowNet : upNet;
          if (
            membersOf(priv).size === 2 &&
            partners.length === 1 &&
            nets(partners[0]).includes(otherEnd)
          ) {
            const [topPart, bottomPart] =
              end === upNet ? [pa, partners[0]] : [partners[0], pa];
            putVertical(topPart, cx + 10, cy - 50, upNet);
            putVertical(bottomPart, cx + 10, cy + 50, priv);
            break;
          }
        }
        if (k < n - 1) {
          // Branch devices off this midpoint: horizontal, beside the leg.
          const my = yTop + ((k + 1) * height) / n;
          let bx = x + 280;
          let prev = lowNet;
          for (const dv of branchFrom(lowNet)) {
            putHorizontal(dv, bx, my, prev, 1);
            const next = nets(dv).filter((nt) => nt !== prev);
            prev = next.length ? next[0] : prev;
            bx += 130;
          }
          branchExtra = Math.max(branchExtra, bx - (x + 280));
          // each leg's output exits a step lower than the previous leg's
          netPos.set(lowNet, [
            x,
            yTop + ((k + 1) * height) / n + 120 * b.legs.indexOf(leg),
          ]);
        }
      });
      x += LEG_PITCH + branchExtra;
    }
    const lastLegX = x - LEG_PITCH;
    if (!netPos.has(b.top)) netPos.set(b.top, [firstLegX, yTop]);
    if (!netPos.has(b.bottom)) netPos.set(b.bottom, [firstLegX, yTop + height]);
    if (!columnsLeft) {
      x += 40;
      for (const chain of cols) {
        placeColumn(chain, x);
        x += COLUMN_PITCH;
      }
    }

    // Power-flow chain from the midpoints outwards.
    const edgeX = direction > 0 ? lastLegX + LEG_PITCH - 40 : firstLegX - 200;
    let frontier = [...mids];
    const reached = new Set(frontier);
    const levelX = new Map(frontier.map((m) => [m, edgeX]));
    const shuntsAt = new Map<string, number>(); // parallel parts across the same nodes step aside
    const seriesFrom = new Map<string, number>(); // series parts leaving one node: one below the other
    const count = (map: Map<string, number>, key: string) => map.get(key) ?? 0;
    const ownRails = new Set([b.top, b.bottom, '0']);
    const atY = (n: string) => (netPos.get(n) ?? [edgeX, yTop + height / 2])[1];
    for (let step = 0; step < 8; step += 1) {
      const newFrontier: string[] = [];
      for (const at of frontier) {
        // inline sense parts sit on the wire, then the chain goes on beyond
        for (const ref of sortedStr(membersOf(at))) {
          if (
            !positions.has(ref) &&
            !devices.has(ref) &&
            nets(ref).length === 1 &&
            transparent(parts.get(ref) ?? {})
          ) {
            const lx0 = levelX.get(at) ?? edgeX;
            putHorizontal(ref, lx0 + direction * 70, atY(at), at, direction);
            levelX.set(at, lx0 + direction * 140);
          }
        }
        for (const ref of sortedStr(membersOf(at))) {
          if (positions.has(ref) || devices.has(ref) || nets(ref).length !== 2)
            continue;
          const other = nets(ref).filter((nt) => nt !== at)[0];
          let ay = atY(at);
          const lx = levelX.get(at) ?? edgeX;
          if (ownRails.has(other)) {
            const down = other === b.bottom || other === '0';
            const key = JSON.stringify(['rail', Math.trunc(lx)]);
            putVertical(
              ref,
              lx + direction * (60 + 120 * count(shuntsAt, key)),
              ay + (down ? 60 : -60),
              down ? at : other,
            );
            shuntsAt.set(key, count(shuntsAt, key) + 1);
          } else if (reached.has(other)) {
            const oy = (netPos.get(other) ?? [lx, ay])[1];
            const ox = levelX.get(other) ?? lx;
            const key = JSON.stringify([at, other].sort(cmpStr));
            const xx =
              (direction > 0 ? Math.max(lx, ox) : Math.min(lx, ox)) +
              direction * (100 + 120 * count(shuntsAt, key));
            shuntsAt.set(key, count(shuntsAt, key) + 1);
            putVertical(ref, xx, (ay + oy) / 2, ay <= oy ? at : other);
          } else {
            const nx = lx + direction * 140;
            const ny = ay + 120 * count(seriesFrom, at);
            seriesFrom.set(at, count(seriesFrom, at) + 1);
            putHorizontal(ref, nx, ny, at, direction);
            ay = ny;
            netPos.set(other, [nx + direction * 60, ay]);
            levelX.set(other, nx + direction * 60);
            reached.add(other);
            newFrontier.push(other);
          }
        }
      }
      frontier = newFrontier;
      if (!frontier.length) break;
    }
    x = Math.max(...[...positions.values()].map((p) => p.x), x) + BRIDGE_GAP;
  }
  return positions;
}
