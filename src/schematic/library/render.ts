/**
 * YAML -> drawing. Every part of the circuit becomes an engine symbol, wires
 * follow the netlist generator's connectivity, and positions come from the
 * layout layers (the project's layout over the YAML's `schematic:` section);
 * parts without a position are placed next to what they connect to. Port of
 * `render` / `render_for_topology` of qdonis-core `schematic_sync.py`.
 */

import { applyUpdates } from '../../circuits/library/circuit-inventory';
import { isDict, pyStr, type Dict } from '../../simulation/netlist/py';
import type {
  Placement,
  RenderResult,
  SchematicLayout,
  SchematicSymbol,
} from '../schematic.types';
import {
  Occupancy,
  extent,
  pinPoint,
  pinTable,
  rotate,
  snap,
  type Bounds,
} from './geometry';
import {
  libraryLayout,
  mergeLayouts,
  placeEntry,
  setSheetLayout,
} from './layout';
import {
  buildSymbols,
  cmpTuple,
  connectivity,
  netNamer,
  netsByName,
  pinKey,
  regions,
  type Region,
  type Symbols,
} from './model';
import { seedFromDrawing, type TerminalNeighbours } from './drawing-seed';
import { skeleton } from './power';
import { membership, resolveGroups, sheetView, type Sheet } from './sheets';
import { paletteForEngine, symbolsForEngine } from './symbols';
import {
  expressionNames,
  hideCandidates,
  markHidden,
  wireNets,
  type Endpoints,
  type Terminal,
} from './wiring';

type Point = readonly [number, number];
const termKey = (t: Terminal): string => JSON.stringify(t);

/** Rotate an auto-placed part so its pins face the parts they connect to. */
function orient(comp: SchematicSymbol, targets: Map<string, Point>): void {
  if (comp.type === 'LABEL' || comp.type === 'GND') {
    if (!targets.size) return;
    const [tx, ty] = targets.values().next().value as Point;
    const dx = tx - (comp.x ?? 0);
    const dy = ty - (comp.y ?? 0);
    if (comp.type === 'LABEL') {
      comp.rotation =
        Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 0 : 180) : dy < 0 ? 90 : 270;
    } else {
      comp.rotation = dy <= 0 || Math.abs(dx) > Math.abs(dy) ? 0 : 180;
    }
    return;
  }
  const terminals = Object.keys(pinTable(comp));
  if (
    terminals.length !== 2 ||
    !terminals.includes('A') ||
    !terminals.includes('B')
  ) {
    return;
  }
  const a = targets.get('A');
  const b = targets.get('B');
  let vx: number;
  let vy: number;
  if (a && b) [vx, vy] = [a[0] - b[0], a[1] - b[1]];
  else if (a) [vx, vy] = [a[0] - (comp.x ?? 0), a[1] - (comp.y ?? 0)];
  else if (b) [vx, vy] = [(comp.x ?? 0) - b[0], (comp.y ?? 0) - b[1]];
  else return;
  if (Math.abs(vx) > Math.abs(vy)) comp.rotation = vx < 0 ? 270 : 90;
  else comp.rotation = vy <= 0 ? 0 : 180;
}

/**
 * Positions for group blocks as a signal-flow chain under the drawing: a
 * block feeding another sits one column to its left; columns are stacked.
 */
function chainBlocks(
  symbols: Symbols,
  blocks: string[],
  bounds: Bounds | null,
): Map<string, Placement> {
  const sides = (cid: string) => {
    const sym = symbols.get(cid) as SchematicSymbol;
    const table = sym.pins ?? {};
    return new Map(
      Object.entries(sym.meta.pins).map(([net, term]) => [
        net,
        (table[term]?.x ?? 0) > 0 ? 'out' : 'in',
      ]),
    );
  };
  const side = new Map(blocks.map((cid) => [cid, sides(cid)]));
  const feeds = new Map(blocks.map((cid) => [cid, new Set<string>()]));
  for (const a of blocks) {
    for (const b of blocks) {
      if (a === b) continue;
      const fed = [...(side.get(a) ?? [])].some(
        ([net, d]) => d === 'out' && side.get(b)?.get(net) === 'in',
      );
      if (fed) feeds.get(a)?.add(b);
    }
  }
  const order = new Map(blocks.map((cid, i) => [cid, i]));
  const column = new Map<string, number>();
  const col = (cid: string, trail: string[]): number => {
    if (!column.has(cid)) {
      const preds = blocks.filter(
        (p) => feeds.get(p)?.has(cid) && !trail.includes(p),
      );
      const depth = preds.length
        ? Math.max(...preds.map((p) => col(p, [...trail, cid]) + 1))
        : 0;
      if (!column.has(cid)) column.set(cid, depth);
    }
    return column.get(cid) as number;
  };
  for (const cid of blocks) col(cid, []);
  const x0 = bounds ? bounds[0] + 80 : 0;
  const y0 = bounds ? bounds[3] + 200 : 0;
  const pitch = 160 + 400; // block width + room for the label pairs
  const out = new Map<string, Placement>();
  for (let k = 0; k <= Math.max(...column.values()); k += 1) {
    let y = y0;
    const inColumn = blocks
      .filter((c) => column.get(c) === k)
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    for (const cid of inColumn) {
      const ys = Object.values(symbols.get(cid)?.pins ?? {}).map((p) => p.y);
      const all = ys.length ? ys : [0];
      const top = Math.min(-40, Math.min(...all) - 30);
      const bottom = Math.max(40, Math.max(...all) + 30);
      out.set(cid, {
        x: snap(x0 + k * pitch),
        y: snap(y - top),
        rotation: 0,
        mirrorX: false,
        mirrorY: false,
      });
      y += bottom - top + 120;
    }
  }
  return out;
}

const placementOf = (sym: SchematicSymbol): Placement => ({
  x: sym.x ?? 0,
  y: sym.y ?? 0,
  rotation: sym.rotation ?? 0,
  mirrorX: sym.mirrorX ?? false,
  mirrorY: sym.mirrorY ?? false,
});

const ensureMirror = (sym: SchematicSymbol) => {
  sym.mirrorX ??= false;
  sym.mirrorY ??= false;
};

/** Python `str(value or "")` length in code points. */
const textLength = (value: unknown) =>
  value ? Array.from(pyStr(value)).length : 0;

/**
 * Drawing of one sheet of `circuit` (`sheet` null = top). `layout` keeps
 * positions / wires / groups of earlier renders and edits (all sheets); the
 * returned layout is the full layout with this sheet's part updated.
 */
export function render(
  circuit: Dict,
  layout: SchematicLayout | null = null,
  drawing: Dict | null = null,
  sheet: Sheet = null,
): RenderResult {
  const fullCompNets = connectivity(circuit);
  const fullSymbols = buildSymbols(circuit, fullCompNets);
  const [groups, explicitGroups] = resolveGroups(
    circuit,
    fullCompNets,
    fullSymbols,
    layout,
    drawing,
  );
  if (sheet !== null && !groups.has(sheet)) {
    throw new SheetNotFoundError(sheet);
  }
  const memberOf = membership(fullSymbols, fullCompNets, groups);
  const namer = netNamer(fullCompNets, fullSymbols);
  const [compNets, symbols] = sheetView(
    circuit,
    fullCompNets,
    fullSymbols,
    groups,
    memberOf,
    sheet,
    namer,
  );
  const nets = netsByName(compNets);
  if (sheet !== null) drawing = null; // the old drawings only show the top level
  const sheetWires =
    sheet === null ? layout?.wires : layout?.sheets?.[sheet]?.wires;

  const endpoint: Endpoints = new Map();
  for (const [cid, sym] of symbols) {
    if (sym.meta.bare) {
      endpoint.set(pinKey(...sym.meta.bare), [cid, 'P']);
    } else {
      for (const [pin, terminal] of Object.entries(sym.meta.pins)) {
        endpoint.set(pinKey(sym.meta.ref ?? cid, pin), [cid, terminal]);
      }
    }
  }

  // Part adjacency (through small nets) and terminal neighbours. Islands are
  // separated by ground (channels of a gate drive are laid out side by side).
  let adjacency = new Map<string, Set<string>>();
  const terminalNeighbours: TerminalNeighbours = new Map();
  const signalAdjacency = new Map<string, Set<string>>();
  const adj = (map: Map<string, Set<string>>, cid: string) => {
    if (!map.has(cid)) map.set(cid, new Set());
    return map.get(cid) as Set<string>;
  };
  for (const [net, members] of nets) {
    const ids = members.flatMap(([ref, pin]) => {
      const t = endpoint.get(pinKey(ref, pin));
      return t ? [t] : [];
    });
    const cids = new Set(ids.map(([cid]) => cid));
    for (const [cid, terminal] of ids) {
      if (!terminalNeighbours.has(cid)) terminalNeighbours.set(cid, new Map());
      const byTerminal = terminalNeighbours.get(cid) as Map<
        string,
        Set<string>
      >;
      if (!byTerminal.has(terminal)) byTerminal.set(terminal, new Set());
      for (const other of cids) {
        if (other !== cid) byTerminal.get(terminal)?.add(other);
      }
      if (cids.size > 8) continue;
      adj(adjacency, cid);
      if (net !== '0') adj(signalAdjacency, cid);
      for (const other of cids) {
        if (other === cid) continue;
        adj(adjacency, cid).add(other);
        if (net !== '0') adj(signalAdjacency, cid).add(other);
      }
    }
  }

  const allStored = (layout?.components ?? {}) as Record<string, unknown>;
  const positions = new Map<string, Placement>();
  for (const cid of symbols.keys()) {
    const stored = Object.hasOwn(allStored, cid) ? allStored[cid] : undefined;
    const entry = isDict(stored) ? placeEntry(stored) : null;
    if (entry) positions.set(cid, entry);
  }
  // This sheet has a layout of its own (not just positions from other sheets).
  const stored = new Map(positions);
  let fromSkeleton = false;
  if (!stored.size) {
    // A bridge power stage is laid out from its structure; otherwise the old
    // hand-drawn schematic seeds the positions.
    const structured = skeleton(
      circuit,
      compNets,
      symbols,
      regions(circuit, compNets, symbols, new Set()),
    );
    if (structured.size) {
      for (const [cid, place] of structured) positions.set(cid, place);
      fromSkeleton = true;
    } else if (drawing) {
      const seeded = seedFromDrawing(
        symbols,
        adjacency,
        terminalNeighbours,
        drawing,
      );
      for (const [cid, place] of seeded) positions.set(cid, place);
    }
  }

  // Power stage and control circuitry are laid out apart; labels and grounds
  // follow the part they hang on.
  const region = regions(
    circuit,
    compNets,
    symbols,
    stored.size ? new Set() : new Set(positions.keys()),
  );
  const order = new Map([...symbols.keys()].map((cid, i) => [cid, i]));
  const orderOf = (cid: string) => order.get(cid) ?? 0;
  for (const cid of symbols.keys()) {
    if (region.get(cid) !== null) continue;
    const near = [...(adjacency.get(cid) ?? [])]
      .filter((n) => region.get(n))
      .sort((a, b) => orderOf(a) - orderOf(b));
    region.set(cid, near.length ? (region.get(near[0]) as Region) : null);
  }
  adjacency = new Map(
    [...adjacency].map(([cid, ns]) => [
      cid,
      new Set(
        [...ns].filter(
          (n) =>
            region.get(n) === region.get(cid) ||
            (region.get(n) ?? null) === null ||
            (region.get(cid) ?? null) === null,
        ),
      ),
    ]),
  );
  const adjacent = (cid: string) => adjacency.get(cid) ?? new Set<string>();
  const sym = (cid: string) => symbols.get(cid) as SchematicSymbol;

  // The old drawings are tight: spread the seeded power stage in proportion
  // to the power parts that still have to fit in around it.
  if (!stored.size && positions.size && !fromSkeleton) {
    const extra = [...symbols.keys()].filter(
      (c) =>
        !positions.has(c) &&
        region.get(c) === 'main' &&
        !['LABEL', 'GND'].includes(sym(c).type),
    ).length;
    const factor = 1.2 + Math.min(0.4, extra / Math.max(1, 2 * positions.size));
    const places = [...positions.values()];
    const cx = places.reduce((t, p) => t + p.x, 0) / places.length;
    const cy = places.reduce((t, p) => t + p.y, 0) / places.length;
    for (const p of places) {
      p.x = snap(cx + (p.x - cx) * factor);
      p.y = snap(cy + (p.y - cy) * factor);
    }
  }

  for (const [cid, place] of positions) Object.assign(sym(cid), place);
  let occupancy = new Occupancy();
  for (const cid of [...positions.keys()].sort(
    (a, b) => orderOf(a) - orderOf(b),
  )) {
    const s = sym(cid);
    if (!stored.size) {
      // Seeded parts can collide: nudge them apart.
      const [hw, hh] = extent(s);
      if (!occupancy.free(s.x ?? 0, s.y ?? 0, hw, hh, 0)) {
        [s.x, s.y] = occupancy.spot(s.x ?? 0, s.y ?? 0, hw, hh, 20, 10);
        const place = positions.get(cid) as Placement;
        place.x = s.x;
        place.y = s.y;
      }
    }
    occupancy.add(cid, s);
  }

  const termNet = new Map<string, string>();
  for (const [key, t] of endpoint) {
    const [ref, pin] = JSON.parse(key) as [string, string];
    const net = compNets.get(ref)?.get(pin);
    if (net !== undefined) termNet.set(termKey(t), net);
  }
  const netAt = (cid: string, terminal: string) =>
    termNet.get(termKey([cid, terminal]));

  /** The two terminals a part conducts between (A/B, drain/source). */
  const mainPair = (cid: string): [string, string] | null => {
    const table = pinTable(sym(cid));
    for (const [a, b] of [
      ['A', 'B'],
      ['D', 'S'],
    ] as const) {
      if (
        Object.hasOwn(table, a) &&
        Object.hasOwn(table, b) &&
        netAt(cid, a) !== undefined &&
        netAt(cid, b) !== undefined
      ) {
        return [a, b];
      }
    }
    return null;
  };
  const isTwoTerminal = (cid: string) => {
    const keys = Object.keys(pinTable(sym(cid)));
    return keys.length === 2 && keys.includes('A') && keys.includes('B');
  };

  /** A placed part across the same two nets (body diode, snubber, parallel resistor). */
  const parallelPartner = (cid: string): [string, string, string] | null => {
    const pair = mainPair(cid);
    if (!pair || !isTwoTerminal(cid)) return null;
    const mine = new Set([netAt(cid, pair[0]), netAt(cid, pair[1])]);
    if (mine.size !== 2) return null;
    for (const other of [...positions.keys()].sort(
      (a, b) => orderOf(a) - orderOf(b),
    )) {
      if (region.get(other) !== region.get(cid)) continue;
      const opair = mainPair(other);
      if (!opair) continue;
      const theirs = new Set([netAt(other, opair[0]), netAt(other, opair[1])]);
      if (theirs.size === mine.size && [...theirs].every((n) => mine.has(n))) {
        return [other, opair[0], opair[1]];
      }
    }
    return null;
  };

  /** For each terminal of `cid`: a point just outside the placed pins it connects to. */
  const neighbourTargets = (cid: string): Map<string, Point> => {
    const targets = new Map<string, Point>();
    const terminals = Object.keys(pinTable(sym(cid)));
    for (const terminal of terminals.length ? terminals : ['P']) {
      const points: Point[] = [];
      for (const [key, [ocid, oterm]] of endpoint) {
        if (ocid !== cid || oterm !== terminal) continue;
        const [ref, pin] = JSON.parse(key) as [string, string];
        const net = compNets.get(ref)?.get(pin);
        if (net === '0') continue; // ground should not pull a part anywhere
        const members = net === undefined ? [] : (nets.get(net) ?? []);
        for (const [mref, mpin] of members) {
          const other = endpoint.get(pinKey(mref, mpin));
          if (
            !other ||
            other[0] === cid ||
            !positions.has(other[0]) ||
            members.length > 8
          ) {
            continue;
          }
          const [px, py, dx, dy] = pinPoint(sym(other[0]), other[1]);
          points.push([px + dx * 60, py + dy * 60]);
        }
      }
      if (points.length) {
        targets.set(terminal, [
          points.reduce((s, p) => s + p[0], 0) / points.length,
          points.reduce((s, p) => s + p[1], 0) / points.length,
        ]);
      }
    }
    return targets;
  };

  const record = (cid: string) => {
    const s = sym(cid);
    ensureMirror(s);
    positions.set(cid, placementOf(s));
    occupancy.add(cid, s);
  };

  const place = (cid: string, x: number, y: number) => {
    const s = sym(cid);
    s.rotation ??= 0;
    const targets = neighbourTargets(cid);
    s.x = snap(x);
    s.y = snap(y);
    orient(s, targets);
    const [hw, hh] = extent(s);
    [s.x, s.y] = occupancy.spot(x, y, hw, hh);
    record(cid);
  };

  let pending = [...symbols.keys()].filter((cid) => !positions.has(cid));
  const done = (cid: string) => {
    pending = pending.filter((c) => c !== cid);
  };

  // Parallel parts sit right beside their partner, oriented the same way.
  for (let placedOne = true; placedOne;) {
    placedOne = false;
    for (const cid of [...pending]) {
      const partner = parallelPartner(cid);
      if (!partner) continue;
      const [other, ta, tb] = partner;
      const q = sym(other);
      const s = sym(cid);
      s.rotation ??= 0;
      const pa = pinPoint(q, ta);
      const pb = pinPoint(q, tb);
      const mine = new Map([
        [netAt(cid, 'A'), 'A'],
        [netAt(cid, 'B'), 'B'],
      ]);
      const targets = new Map<string, Point>([
        [mine.get(netAt(other, ta)) as string, [pa[0], pa[1]]],
        [mine.get(netAt(other, tb)) as string, [pb[0], pb[1]]],
      ]);
      s.x = q.x;
      s.y = q.y;
      orient(s, targets);
      const [ox, oy] = rotate(q.mirrorX ? -1 : 1, 0, q.rotation ?? 0);
      const axis = Math.abs(ox) ? 0 : 1;
      const gap = extent(q)[axis] + extent(s)[axis] - 40;
      const [hw, hh] = extent(s);
      [s.x, s.y] = occupancy.spot(
        (q.x ?? 0) + ox * gap,
        (q.y ?? 0) + oy * gap,
        hw,
        hh,
        20,
        8,
      );
      record(cid);
      done(cid);
      placedOne = true;
    }
  }

  /** Python `max()` of (count, -order) over candidates. */
  const best = (cands: string[]) => {
    let top: string | null = null;
    let topCount = -1;
    for (const c of cands) {
      const count = [...adjacent(c)].filter((n) => positions.has(n)).length;
      if (
        top === null ||
        count > topCount ||
        (count === topCount && orderOf(c) < orderOf(top))
      ) {
        top = c;
        topCount = count;
      }
    }
    return [top, topCount] as const;
  };
  const centre = (targets: Map<string, Point>): Point => {
    const vs = [...targets.values()];
    return [
      vs.reduce((s, t) => s + t[0], 0) / vs.length,
      vs.reduce((s, t) => s + t[1], 0) / vs.length,
    ];
  };

  for (;;) {
    // Ground symbols and net labels are placed by their own rules below.
    const [cid, count] = best(
      pending.filter((c) => !['GND', 'LABEL', 'SHEET'].includes(sym(c).type)),
    );
    if (cid === null || count === 0) break;
    const targets = neighbourTargets(cid);
    let x: number;
    let y: number;
    if (targets.size) [x, y] = centre(targets);
    else {
      const near = [...adjacent(cid)].filter((n) => positions.has(n)).map(sym);
      x = near.reduce((s, n) => s + (n.x ?? 0), 0) / near.length;
      y = near.reduce((s, n) => s + (n.y ?? 0), 0) / near.length + 100;
    }
    place(cid, x, y);
    done(cid);
  }

  const byPinOrder = (a: Terminal, b: Terminal) =>
    cmpTuple([orderOf(a[0]), a[1]], [orderOf(b[0]), b[1]]);
  const terminalsOn = (net: string | undefined, used: Set<string>) =>
    [...termNet]
      .filter(([key, n]) => {
        const [cid] = JSON.parse(key) as Terminal;
        return (
          n === net &&
          positions.has(cid) &&
          !hideable.has(cid) &&
          !['GND', 'LABEL'].includes(sym(cid).type) &&
          !used.has(key)
        );
      })
      .map(([key]) => JSON.parse(key) as Terminal);

  // Ground symbols of the circuit itself: just off a placed ground pin
  // (never beside a part the drawing may hide).
  const hideable = hideCandidates(circuit, symbols, compNets);
  const usedGroundPins = new Set<string>();
  for (const cid of pending.filter((c) => sym(c).type === 'GND')) {
    const candidates = terminalsOn('0', usedGroundPins);
    const own = candidates.filter(
      (t) => region.get(t[0]) === (region.get(cid) || 'main'),
    );
    const pins = (own.length ? own : candidates).sort(byPinOrder);
    if (!pins.length) continue;
    usedGroundPins.add(termKey(pins[0]));
    const [px, py, dx, dy] = pinPoint(sym(pins[0][0]), pins[0][1]);
    const s = sym(cid);
    s.rotation = dy >= 0 || Math.abs(dx) > Math.abs(dy) ? 0 : 180;
    const [hw, hh] = extent(s);
    [s.x, s.y] = occupancy.spot(px + dx * 40, py + dy * 40 + 40, hw, hh, 20, 8);
    record(cid);
    done(cid);
  }

  // Net labels of the circuit itself: just beside a placed pin of their net, facing it.
  const usedLabelPins = new Set<string>();
  for (const cid of pending.filter((c) => sym(c).type === 'LABEL')) {
    const meta = sym(cid).meta;
    const [ref, pin] = meta.bare ?? [meta.ref ?? cid, 'pin'];
    const pins = compNets.get(ref);
    const labelNet = pins?.get(pin) || pins?.values().next().value;
    const candidates = terminalsOn(labelNet, usedLabelPins).sort(byPinOrder);
    if (!candidates.length) continue;
    usedLabelPins.add(termKey(candidates[0]));
    const [px, py, dx, dy0] = pinPoint(sym(candidates[0][0]), candidates[0][1]);
    const dy = dx === 0 && dy0 === 0 ? 1 : dy0;
    const s = sym(cid);
    // the flag's pin is on its left: turn it so the pin faces the part
    s.rotation = dx > 0 ? 0 : dx < 0 ? 180 : dy > 0 ? 90 : 270;
    const [hw, hh] = extent(s);
    [s.x, s.y] = occupancy.spot(px + dx * 80, py + dy * 60, hw, hh, 20, 12, 10);
    record(cid);
    done(cid);
  }

  // Sense ports (a net only read inside an expression): just left of the part
  // that reads it. Placed once their reader is.
  const perReader = new Map<string, number>();
  const sensePorts = new Set(
    pending.filter((c) => {
      const s = sym(c);
      return s.type === 'PORT' && s.meta.sense && s.meta.readers?.length;
    }),
  );
  const placeSensePorts = () => {
    for (const cid of pending.filter((c) => sensePorts.has(c))) {
      const readers = (sym(cid).meta.readers ?? []).filter((r) =>
        positions.has(r),
      );
      if (!readers.length) continue;
      const reader = sym(readers[0]);
      const k = perReader.get(readers[0]) ?? 0;
      perReader.set(readers[0], k + 1);
      const s = sym(cid);
      s.rotation = 0;
      s.mirrorX = false;
      s.mirrorY = false;
      const width = 14 + 7 * textLength(s.label);
      const [hw, hh] = extent(s);
      [s.x, s.y] = occupancy.spot(
        (reader.x ?? 0) - extent(reader)[0] - 60 - width,
        (reader.y ?? 0) - 20 + 40 * k,
        hw,
        hh,
        20,
        8,
        10,
      );
      record(cid);
      done(cid);
    }
  };
  placeSensePorts();

  // Group blocks: a signal-flow chain under the drawing.
  const blocks = pending.filter((c) => sym(c).type === 'SHEET');
  if (blocks.length) {
    for (const [cid, spot] of chainBlocks(
      symbols,
      blocks,
      occupancy.bounds(),
    )) {
      Object.assign(sym(cid), spot);
      positions.set(cid, { ...spot });
      occupancy.add(cid, sym(cid));
      done(cid);
    }
  }

  // Islands with nothing placed around them: lay each out on its own, then
  // stack them in rows under what is already drawn.
  if (pending.length) {
    const remaining = new Set(pending.filter((c) => !sensePorts.has(c)));
    const islands: string[][] = [];
    while (remaining.size) {
      const start = [...remaining].reduce((a, b) =>
        orderOf(b) < orderOf(a) ? b : a,
      );
      const stack = [start];
      const island: string[] = [];
      remaining.delete(start);
      while (stack.length) {
        const c = stack.pop() as string;
        island.push(c);
        const next = [...(signalAdjacency.get(c) ?? [])]
          .filter((n) => remaining.has(n))
          .sort((a, b) => orderOf(a) - orderOf(b));
        for (const n of next) {
          remaining.delete(n);
          stack.push(n);
        }
      }
      islands.push(island);
    }
    islands.sort(
      (a, b) => b.length - a.length || orderOf(a[0]) - orderOf(b[0]),
    );

    const bounds = occupancy.bounds();
    const x0 = bounds ? bounds[0] : 0;
    let yCursor = bounds ? bounds[3] + 140 : 0;
    const rowWidth = Math.max(1200, bounds ? bounds[2] - bounds[0] : 0);
    let cursorX = x0;
    let rowHeight = 0;
    for (const island of islands) {
      const local = new Occupancy();
      const saved = occupancy;
      occupancy = local;
      const hub = island.reduce((a, b) => {
        const da = adjacent(a).size;
        const db = adjacent(b).size;
        return db > da || (db === da && orderOf(b) < orderOf(a)) ? b : a;
      });
      place(hub, 0, 0);
      let todo = island.filter((c) => c !== hub);
      while (todo.length) {
        const [cid] = best(todo) as [string, number];
        const targets = neighbourTargets(cid);
        let x: number;
        let y: number;
        if (targets.size) [x, y] = centre(targets);
        else {
          const b = local.bounds();
          [x, y] = b ? [b[2] + 60, 0] : [0, 0];
        }
        place(cid, x, y);
        todo = todo.filter((c) => c !== cid);
      }
      occupancy = saved;
      const [minx, miny, maxx, maxy] = local.bounds() as Bounds;
      const width = maxx - minx;
      const height = maxy - miny;
      if (cursorX > x0 && cursorX + width > x0 + rowWidth) {
        cursorX = x0;
        yCursor += rowHeight + 80;
        rowHeight = 0;
      }
      const dx = snap(cursorX - minx);
      const dy = snap(yCursor - miny);
      for (const cid of island) {
        const s = sym(cid);
        s.x = (s.x ?? 0) + dx;
        s.y = (s.y ?? 0) + dy;
        positions.set(cid, {
          ...(positions.get(cid) as Placement),
          x: s.x,
          y: s.y,
        });
        occupancy.add(cid, s);
      }
      cursorX += width + 80;
      rowHeight = Math.max(rowHeight, height);
    }
  }

  placeSensePorts();
  for (const cid of pending.filter((c) => sensePorts.has(c))) {
    // reader never placed: beside the drawing
    const b = occupancy.bounds() ?? [0, 0, 0, 0];
    place(cid, b[0] - 120, b[1]);
    done(cid);
  }

  const [wires, extra] = wireNets(
    symbols,
    nets,
    endpoint,
    Array.isArray(sheetWires) ? sheetWires : [],
    allStored,
    occupancy,
    region,
    namer,
    hideable,
  );
  const components = [...symbols.values(), ...extra];
  markHidden(components, wires, hideable, expressionNames(circuit));
  components.forEach(ensureMirror);
  const newLayout = setSheetLayout(layout, sheet, components, wires);
  newLayout.groups = Object.fromEntries(
    [...groups].map(([gid, g]) => [
      gid,
      { label: g.label, members: [...g.members] },
    ]),
  );
  const sheetList = [...groups].map(([gid, g]) => ({
    id: gid,
    label: g.label,
    parts: [...fullSymbols].filter(
      ([cid, s]) =>
        memberOf.get(cid) === gid && s.type !== 'LABEL' && s.type !== 'GND',
    ).length,
  }));
  return {
    schematic: {
      components,
      wires,
      plotConfiguration: { plots: [] },
      simulationSettings: {
        stopTime: '0.05',
        stepSize: '1e-5',
        stepType: 'fixed',
        solver: 'euler',
      },
    },
    layout: newLayout,
    sheet: {
      id: sheet,
      label: sheet !== null ? (groups.get(sheet)?.label ?? sheet) : 'Top level',
    },
    basis: stored.size
      ? 'saved'
      : fromSkeleton
        ? 'structure'
        : drawing && positions.size
          ? 'drawing'
          : 'auto',
    sheets: sheetList,
    groups_explicit: explicitGroups,
  };
}

/** The requested sheet is not a group of the circuit. */
export class SheetNotFoundError extends Error {
  constructor(readonly sheet: string) {
    super(`no sheet '${sheet}' in this circuit`);
    this.name = 'SheetNotFoundError';
  }
}

export interface RenderOptions {
  /** Design values `[{ref, param, after}]` applied before drawing. */
  recalculated?: unknown;
  /** The project's layout (moves / edits), drawn over the library layout. */
  layout?: SchematicLayout | null;
  /** Ignore saved positions / wires (automatic layout; grouping kept). */
  fresh?: boolean;
  /** Also drop the saved grouping. */
  regroup?: boolean;
  sheet?: Sheet;
  /** The topology's old hand-drawn schematic (`json_library`), to seed a fresh layout. */
  drawing?: Dict | null;
}

export interface TopologyRender extends RenderResult {
  palette: Dict[];
  seeded_from_drawing: boolean;
  library_layout: { present: boolean; tuned: boolean };
}

/** Render one sheet with the layout layers: the project's layout over the YAML's `schematic:` section. */
export function renderForTopology(
  circuit: Dict,
  options: RenderOptions = {},
): TopologyRender {
  const effective = applyUpdates(
    structuredClone(circuit),
    options.recalculated,
  );
  const library = libraryLayout(circuit);
  let merged = mergeLayouts(library, options.layout ?? null, circuit);
  if (options.fresh || options.regroup) {
    const groups = options.regroup ? undefined : merged?.groups;
    merged = isDict(groups) ? { groups } : null;
  }
  const result = render(
    effective,
    merged,
    options.drawing ?? null,
    options.sheet ?? null,
  );
  // pin geometry from the symbol registry: the engine draws with exactly this table
  result.schematic.symbols = symbolsForEngine();
  const section = circuit.schematic;
  const saved = merged?.components ?? {};
  const hasPositions = result.schematic.components.some((c) =>
    Object.hasOwn(saved, c.id),
  );
  return {
    ...result,
    palette: paletteForEngine(),
    seeded_from_drawing: result.basis === 'drawing' && !hasPositions,
    library_layout: {
      present: library !== null,
      tuned: isDict(section) && Boolean(section.tuned),
    },
  };
}
