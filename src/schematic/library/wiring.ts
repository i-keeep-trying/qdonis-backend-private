/**
 * Wires of a sheet, from the netlist generator's connectivity: saved wires
 * that are still on one correct net are kept, the rest is a shortest
 * pin-to-pin tree; far-apart pieces of a net get drawing-only net labels /
 * grounds (`~NAME@REF.pin`). Also decides which helper parts the drawing may
 * hide. Port of `_wire_nets`, `_adopt_own_labels`, `_virtual_symbol`,
 * `_hide_candidates`, `_mark_hidden` of qdonis-core `schematic_sync.py`.
 */

import type { CompNets } from '../../simulation/netlist/comp-nets';
import { isDict, pyStr, type Dict } from '../../simulation/netlist/py';
import type {
  SchematicSymbol,
  SchematicWire,
  WireEnd,
} from '../schematic.types';
import { type Occupancy, extent, pinPoint, snap } from './geometry';
import { placeEntry } from './layout';
import {
  byRef,
  cmpTuple,
  flat,
  pinKey,
  sortedStr,
  type Pin,
  type Region,
  type Symbols,
} from './model';
import { expressionNets } from './sheets';
import { TRANSISTOR_SYMBOLS, paramsOf } from './symbols';
import { parseNumber } from './values';

/** (ref, pin) key -> [engine id, terminal]. */
export type Endpoints = Map<string, Terminal>;
export type Terminal = readonly [string, string];

const termKey = (t: Terminal): string => JSON.stringify(t);

export const DRIVE_TERMINALS = new Set(['G', 'CP', 'CN']);
const DRIVEN_SYMBOLS = new Set<string>([
  ...TRANSISTOR_SYMBOLS,
  'VSW',
  'ESRC',
  'EAMP',
  'GSRC',
]);
/** Block-to-block wires only this short; longer ones are label pairs. */
export const BLOCK_WIRE = 520;
/** A resistor this large to ground only gives SPICE a DC path. */
const AUXILIARY_OHMS = 1e6;

/**
 * True when one block pin is an output, the other an input, and the output
 * faces the input (signal flow left to right).
 */
export function blockFlow(
  a: SchematicSymbol,
  ta: string,
  pa: readonly number[],
  b: SchematicSymbol,
  tb: string,
  pb: readonly number[],
): boolean {
  const isOut = (block: SchematicSymbol, term: string) =>
    (block.pins?.[term]?.x ?? 0) > 0;
  if (isOut(a, ta) === isOut(b, tb)) return false;
  const [src, dst] = isOut(a, ta) ? [pa, pb] : [pb, pa];
  return (dst[0] - src[0]) * src[2] + (dst[1] - src[1]) * src[3] > 0;
}

export function virtualSymbol(
  cid: string,
  net: string,
  name: string,
  place: {
    x?: number;
    y?: number;
    rotation?: number;
    mirrorX?: boolean;
    mirrorY?: boolean;
  },
): SchematicSymbol {
  const ground = net === '0';
  return {
    id: cid,
    type: ground ? 'GND' : 'LABEL',
    label: ground ? null : name,
    x: snap(place.x ?? 0),
    y: snap(place.y ?? 0),
    rotation: ((Math.trunc(place.rotation ?? 0) % 360) + 360) % 360,
    mirrorX: Boolean(place.mirrorX),
    mirrorY: Boolean(place.mirrorY),
    parameters: ground ? {} : { net_name: name },
    display: '',
    meta: { virtual: true, net, pins: {} },
  };
}

/** Parts the drawing may leave out: lone net labels and auxiliary resistors to ground. */
export function hideCandidates(
  circuit: Dict,
  symbols: Symbols,
  compNets: CompNets,
): Set<string> {
  const refs = byRef(circuit);
  const names = new Map<string, number>();
  for (const s of symbols.values()) {
    if (s.type !== 'LABEL') continue;
    const name = pyStr(s.label ?? null);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [cid, sym] of symbols) {
    const ref = sym.meta.ref;
    if (sym.type === 'LABEL' && names.get(pyStr(sym.label ?? null)) === 1) {
      out.add(cid);
    } else if (sym.type === 'R' && ref !== undefined && refs.has(ref)) {
      const ohms = parseNumber(paramsOf(refs.get(ref) as Dict).resistance);
      const toGround = [...(compNets.get(ref)?.values() ?? [])].includes('0');
      if (ohms !== null && ohms >= AUXILIARY_OHMS && toGround) out.add(cid);
    }
  }
  return out;
}

/** Net names (lower case) read in behavioural expressions. */
export function expressionNames(circuit: Dict): Set<string> {
  const out = new Set<string>();
  for (const [comp] of flat(circuit)) {
    for (const n of expressionNets(comp)) out.add(n.toLowerCase());
  }
  return out;
}

/**
 * Sets `meta.hidden` on what the drawing can leave out and `hidden` on its
 * wires: labels no wire reaches, lone labels nothing reads, auxiliary parts
 * hanging off as leaves, and labels / grounds left with only hidden wires.
 */
export function markHidden(
  components: SchematicSymbol[],
  wires: SchematicWire[],
  candidates: ReadonlySet<string>,
  read: ReadonlySet<string>,
): void {
  const byId = new Map(components.map((c) => [c.id, c]));
  const tapped = new Set<string>();
  const onPin = new Map<string, { cid: string; wires: SchematicWire[] }>();
  for (const w of wires) {
    for (const e of [w.from, w.to]) {
      if (e.type === 'wire') tapped.add(e.wireId);
      if (e.type === 'pin') {
        const key = termKey([e.compId, e.terminal]);
        if (!onPin.has(key)) onPin.set(key, { cid: e.compId, wires: [] });
        onPin.get(key)?.wires.push(w);
      }
    }
  }
  const wired = new Set([...onPin.values()].map((p) => p.cid));
  const labelOf = (c: SchematicSymbol) => pyStr(c.label ?? null);
  const unwired = new Set(
    components
      .filter((c) => c.type === 'LABEL' && !wired.has(c.id))
      .map((c) => c.id),
  );
  const names = new Map<string, number>();
  for (const c of components) {
    if (c.type === 'LABEL' && !unwired.has(c.id)) {
      names.set(labelOf(c), (names.get(labelOf(c)) ?? 0) + 1);
    }
  }
  const ports = new Set(
    components.filter((c) => c.type === 'PORT').map(labelOf),
  );
  const lonely = components
    .filter(
      (c) =>
        c.type === 'LABEL' &&
        !unwired.has(c.id) &&
        names.get(labelOf(c)) === 1 &&
        (ports.has(labelOf(c)) || !read.has(labelOf(c).toLowerCase())),
    )
    .map((c) => c.id);
  const parts = [...candidates].filter(
    (cid) => byId.has(cid) && byId.get(cid)?.type !== 'LABEL',
  );

  const leaf = (cid: string) =>
    [...onPin.values()]
      .filter((p) => p.cid === cid)
      .every((p) => p.wires.length === 1 && !tapped.has(p.wires[0].id));

  const hidden = new Set(unwired);
  for (const cid of sortedStr(new Set([...lonely, ...parts]))) {
    if (leaf(cid)) hidden.add(cid);
  }
  const hiddenWires = new Set(
    wires
      .filter((w) =>
        [w.from, w.to].some((e) => e.type === 'pin' && hidden.has(e.compId)),
      )
      .map((w) => w.id),
  );
  // Labels / grounds whose every wire is now hidden.
  for (const c of components) {
    if ((c.type !== 'LABEL' && c.type !== 'GND') || hidden.has(c.id)) continue;
    const mine = [...onPin.values()]
      .filter((p) => p.cid === c.id)
      .flatMap((p) => p.wires.map((w) => w.id));
    if (mine.length && mine.every((id) => hiddenWires.has(id)))
      hidden.add(c.id);
  }
  for (const c of components) {
    c.meta = { ...c.meta };
    if (hidden.has(c.id)) c.meta.hidden = true;
    else delete c.meta.hidden;
  }
  for (const w of wires) {
    if (hiddenWires.has(w.id)) w.hidden = true;
    else delete w.hidden;
  }
}

/** A stored wire end, as Python keys it (raw values, type kept). */
const endKey = (e: Dict): string =>
  e.type === 'pin'
    ? JSON.stringify(['p', e.compId ?? null, e.terminal ?? null])
    : JSON.stringify(['w', e.wireId ?? null]);

const pinEnd = (cid: string, terminal: string): WireEnd => ({
  type: 'pin',
  compId: cid,
  terminal,
});

/**
 * Wires for every net: earlier wires that are still right are kept, the rest
 * is completed with the shortest pin-to-pin wires; pieces of a net that are
 * far apart are joined by net labels. Parts in `leaves` are wired last, so
 * they hang off the net and never join two other parts.
 */
export function wireNets(
  symbols: Symbols,
  nets: Map<string, Pin[]>,
  endpoint: Endpoints,
  storedWires: unknown[],
  storedPositions: Record<string, unknown>,
  occupancy: Occupancy,
  region: ReadonlyMap<string, Region>,
  namer: (net: string) => string,
  leaves: ReadonlySet<string>,
): [SchematicWire[], SchematicSymbol[]] {
  const netOf = new Map<string, string>();
  for (const [net, members] of nets) {
    for (const [ref, pin] of members) {
      const t = endpoint.get(pinKey(ref, pin));
      if (t) netOf.set(termKey(t), net);
    }
  }

  const displayName = (net: string): string => {
    if (net === '0') return 'GND';
    const named = (nets.get(net) ?? []).some(([ref, pin]) => {
      const t = endpoint.get(pinKey(ref, pin));
      const s = t && symbols.get(t[0]);
      return s && (s.type === 'LABEL' || s.type === 'PORT') && Boolean(s.label);
    });
    if (named || !/^n\d+$/.test(net)) return net;
    return namer(net); // the same name on every sheet (ports use it too)
  };

  // Earlier wires: keep each connected group whose pins all sit on one net.
  const virtual = new Map<string, ReturnType<typeof placeEntry>>();
  for (const [cid, place] of Object.entries(storedPositions)) {
    const entry =
      cid.startsWith('~') && isDict(place) ? placeEntry(place) : null;
    if (entry) virtual.set(cid, entry);
  }
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

  const validWires = storedWires.filter(
    (w): w is Dict => isDict(w) && isDict(w.from) && isDict(w.to),
  );
  const wireKey = (w: Dict) => JSON.stringify(['w', w.id ?? null]);
  for (const w of validWires) {
    for (const end of [w.from, w.to] as Dict[]) union(wireKey(w), endKey(end));
  }
  const groups = new Map<string, Dict[]>();
  for (const w of validWires) {
    const root = find(wireKey(w));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)?.push(w);
  }
  const kept: SchematicWire[] = [];
  const extra = new Map<string, SchematicSymbol>();
  const piecesSeed: Array<[string, Terminal[]]> = [];
  const wireIds = new Set(validWires.map((w) => JSON.stringify(w.id ?? null)));
  for (const ws of groups.values()) {
    const pins = new Map<string, Terminal>();
    let refsOk = true;
    for (const w of ws) {
      for (const e of [w.from, w.to] as Dict[]) {
        if (e.type === 'pin') {
          const t: Terminal = [pyStr(e.compId), pyStr(e.terminal)];
          pins.set(termKey(t), t);
        } else if (
          e.type === 'wire' &&
          !wireIds.has(JSON.stringify(e.wireId ?? null))
        ) {
          refsOk = false;
        }
      }
    }
    const real = [...pins.values()].filter((p) => !p[0].startsWith('~'));
    const labels = [...pins.values()].filter((p) => p[0].startsWith('~'));
    const hit = new Set(real.map((p) => netOf.get(termKey(p))));
    if (!real.length || hit.has(undefined) || hit.size !== 1 || !refsOk)
      continue;
    const net = [...hit][0] as string;
    // Drawing-only labels / grounds are kept with their wires.
    const wanted = net !== '0' ? displayName(net) : 'GND';
    const ok = labels.every(
      ([cid]) => virtual.has(cid) && cid.split('@')[0].slice(1) === wanted,
    );
    if (!ok) continue;
    for (const [cid] of labels) {
      extra.set(
        cid,
        virtualSymbol(cid, net, displayName(net), virtual.get(cid) ?? {}),
      );
    }
    kept.push(...(ws as unknown as SchematicWire[]));
    piecesSeed.push([net, [...pins.values()]]);
  }

  const wires: SchematicWire[] = [...kept];
  const usedIds = new Set(wires.map((w) => w.id));
  let counter = 0;
  const newId = (): string => {
    for (;;) {
      counter += 1;
      const wid = `W${counter}`;
      if (!usedIds.has(wid)) {
        usedIds.add(wid);
        return wid;
      }
    }
  };
  const comp = (cid: string) =>
    (symbols.get(cid) ?? extra.get(cid)) as SchematicSymbol;

  for (const net of sortedStr(nets.keys())) {
    const members = nets.get(net) ?? [];
    const own = new Map<string, Terminal>();
    for (const [ref, pin] of members) {
      const t = endpoint.get(pinKey(ref, pin));
      if (t) own.set(termKey(t), t);
    }
    const terms: Terminal[] = [...own.values()].sort((a, b) => cmpTuple(a, b));
    terms.push(
      ...[...extra]
        .filter(([, s]) => s.meta.net === net)
        .map(([cid]): Terminal => [cid, 'P'])
        .sort((a, b) => cmpTuple(a, b)),
    );
    // A lone ground pin still gets its ground symbol.
    const loneGround =
      net === '0' && terms.length === 1 && comp(terms[0][0]).type !== 'GND';
    if (terms.length < 2 && !loneGround) continue;

    const uf = new Map<string, string>(
      terms.map((t) => [termKey(t), termKey(t)]),
    );
    const f = (key: string): string => {
      let t = key;
      while (uf.get(t) !== t) {
        uf.set(t, uf.get(uf.get(t) as string) as string);
        t = uf.get(t) as string;
      }
      return t;
    };
    // Pieces: terminals already joined by kept wires ...
    for (const [pnet, pins] of piecesSeed) {
      if (pnet !== net) continue;
      const inside = pins.map(termKey).filter((k) => uf.has(k));
      for (const k of inside.slice(1)) uf.set(f(k), f(inside[0]));
    }
    // ... and labels (or grounds) of one name, which are joined by name.
    const nameOf = new Map<string, string>();
    for (const t of terms) {
      const s = comp(t[0]);
      if (s.type === 'GND') nameOf.set(termKey(t), '\x00GND');
      else if (s.type === 'LABEL')
        nameOf.set(termKey(t), `\x00L:${pyStr(s.label ?? null)}`);
    }
    const firstOf = new Map<string, string>();
    for (const [k, name] of nameOf) {
      if (firstOf.has(name)) uf.set(f(k), f(firstOf.get(name) as string));
      else firstOf.set(name, k);
    }

    // Gate / control pins belong to the side that drives them.
    const termRegion = (t: Terminal): Region => {
      if (comp(t[0]).type === 'GND') return null;
      const base = region.get(t[0]) ?? null;
      if (DRIVE_TERMINALS.has(t[1]) && DRIVEN_SYMBOLS.has(comp(t[0]).type)) {
        const others = terms.filter(
          (o) =>
            termKey(o) !== termKey(t) &&
            comp(o[0]).type !== 'LABEL' &&
            comp(o[0]).type !== 'GND',
        );
        if (
          others.some(
            (o) => region.get(o[0]) === 'main' && !DRIVE_TERMINALS.has(o[1]),
          )
        ) {
          return 'main';
        }
        const kinds = new Set(others.map((o) => region.get(o[0]) ?? null));
        kinds.delete(null);
        if (kinds.size === 1 && kinds.has('main')) return 'main';
        return kinds.size ? 'control' : null;
      }
      return base;
    };
    const regionsOf = new Map(terms.map((t) => [termKey(t), termRegion(t)]));
    const points = new Map(
      terms.map((t) => [termKey(t), pinPoint(comp(t[0]), t[1])]),
    );
    const point = (t: Terminal) =>
      points.get(termKey(t)) as [number, number, number, number];
    const limitFor = (a: Terminal, b: Terminal): number => {
      if (net === '0') {
        return comp(a[0]).type === 'GND' || comp(b[0]).type === 'GND'
          ? 520
          : 260;
      }
      if (comp(a[0]).type === 'SHEET' && comp(b[0]).type === 'SHEET')
        return BLOCK_WIRE;
      const main = (r: Region | undefined) =>
        r === 'main' || r === null || r === undefined;
      return main(regionsOf.get(termKey(a))) && main(regionsOf.get(termKey(b)))
        ? 900
        : 520;
    };

    const edges: Array<[number, Terminal, Terminal]> = [];
    // Leaves hang off the other parts of their net, never off each other.
    const leafOnly = terms.some(
      (t) => !leaves.has(t[0]) && !nameOf.has(termKey(t)),
    );
    terms.forEach((a, i) => {
      for (const b of terms.slice(i + 1)) {
        if (termKey(a) === termKey(b)) continue;
        if (nameOf.has(termKey(a)) && nameOf.has(termKey(b))) continue;
        if (leafOnly && leaves.has(a[0]) && leaves.has(b[0])) continue;
        const ra = regionsOf.get(termKey(a));
        const rb = regionsOf.get(termKey(b));
        if (ra && rb && ra !== rb) continue; // power and control join by labels
        const sa = comp(a[0]).type === 'SHEET';
        const sb = comp(b[0]).type === 'SHEET';
        if (
          sa !== sb &&
          (region.get(a[0]) === 'main' || region.get(b[0]) === 'main')
        ) {
          continue; // a group block reaches the power stage through labels
        }
        const pa = point(a);
        const pb = point(b);
        if (sa && sb && !blockFlow(comp(a[0]), a[1], pa, comp(b[0]), b[1], pb))
          continue;
        edges.push([Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]), a, b]);
      }
    });
    // A B source's ctrl pins: its expression reads the node, SPICE does not wire it.
    const readOnly = (t: Terminal) =>
      (t[1] === 'CP' || t[1] === 'CN') && comp(t[0]).type === 'BSRC';
    const edgeKey = ([cost, a, b]: [number, Terminal, Terminal]) =>
      [
        leaves.has(a[0]) || leaves.has(b[0]),
        readOnly(a) || readOnly(b),
        cost,
        a[0],
        a[1],
        b[0],
        b[1],
      ] as const;
    edges.sort((x, y) => cmpTuple(edgeKey(x), edgeKey(y)));
    for (const [cost, a, b] of edges) {
      if (cost > limitFor(a, b) || f(termKey(a)) === f(termKey(b))) continue;
      uf.set(f(termKey(a)), f(termKey(b)));
      wires.push({
        id: newId(),
        from: pinEnd(a[0], a[1]),
        to: pinEnd(b[0], b[1]),
      });
    }

    // Pieces still apart get the net's label (ground: a ground symbol, always).
    const roots = new Set(terms.map((t) => f(termKey(t))));
    const name = displayName(net);
    const target = net === '0' ? '\x00GND' : `\x00L:${name}`;
    const named = new Set(
      [...nameOf].filter(([, n]) => n === target).map(([k]) => f(k)),
    );
    if (roots.size <= 1 && (net !== '0' || named.size)) continue;
    const byKey = new Map(terms.map((t) => [termKey(t), t]));
    const rootTerms = [...roots]
      .filter((r) => !named.has(r))
      .map((r) => byKey.get(r) as Terminal)
      .sort((a, b) => cmpTuple(a, b));
    for (const root of rootTerms) {
      const piece = terms
        .filter((t) => f(termKey(t)) === termKey(root))
        .sort((a, b) => cmpTuple(a, b));
      const anchor =
        piece.find((t) => !['LABEL', 'GND'].includes(comp(t[0]).type)) ??
        piece[0];
      const cid = `~${name}@${anchor[0]}.${anchor[1]}`;
      const [px, py, dx0, dy0] = point(anchor);
      const dx = dx0;
      const dy = dx0 === 0 && dy0 === 0 ? 1 : dy0;
      const sym = virtualSymbol(cid, net, name, { x: px, y: py });
      if (sym.type === 'GND') {
        const [hw, hh] = extent(sym);
        [sym.x, sym.y] = occupancy.spot(
          px + dx * 40,
          py + dy * 40 + (dy >= 0 ? 40 : -40),
          hw,
          hh,
          20,
          12,
          20,
        );
      } else {
        // The flag's pin is on its left: turn it so the pin faces the part.
        sym.rotation = dx > 0 ? 0 : dx < 0 ? 180 : dy > 0 ? 90 : 270;
        const [hw, hh] = extent(sym);
        [sym.x, sym.y] = occupancy.spot(
          px + dx * 80,
          py + dy * 60,
          hw,
          hh,
          20,
          12,
          10,
        );
      }
      occupancy.add(cid, sym);
      extra.set(cid, sym);
      wires.push({
        id: newId(),
        from: pinEnd(anchor[0], anchor[1]),
        to: pinEnd(cid, 'P'),
      });
    }
  }
  adoptOwnLabels(symbols, extra, wires, endpoint, nets);
  return [wires, [...extra.values()]];
}

/**
 * One label per net piece: a net label of the circuit itself that no wire
 * reaches takes the place of a drawing-only label of the same name.
 */
function adoptOwnLabels(
  symbols: Symbols,
  extra: Map<string, SchematicSymbol>,
  wires: SchematicWire[],
  endpoint: Endpoints,
  nets: Map<string, Pin[]>,
): void {
  const wired = new Set(
    wires.flatMap((w) =>
      [w.from, w.to].flatMap((e) => (e.type === 'pin' ? [e.compId] : [])),
    ),
  );
  for (const net of sortedStr(nets.keys())) {
    const own = sortedStr(
      (nets.get(net) ?? []).flatMap(([ref, pin]) => {
        const t = endpoint.get(pinKey(ref, pin));
        return t && symbols.get(t[0])?.type === 'LABEL' && !wired.has(t[0])
          ? [t[0]]
          : [];
      }),
    );
    if (!own.length) continue;
    const standIns = sortedStr(
      [...extra]
        .filter(([, s]) => s.type === 'LABEL' && s.meta.net === net)
        .map(([cid]) => cid),
    );
    for (let i = 0; i < Math.min(own.length, standIns.length); i += 1) {
      const cid = own[i];
      const vid = standIns[i];
      const label = symbols.get(cid) as SchematicSymbol;
      const stand = extra.get(vid) as SchematicSymbol;
      extra.delete(vid);
      if (pyStr(label.label ?? null) !== pyStr(stand.label ?? null)) {
        extra.set(vid, stand);
        continue;
      }
      label.x = stand.x ?? label.x;
      label.y = stand.y ?? label.y;
      label.rotation = stand.rotation ?? label.rotation;
      label.mirrorX = stand.mirrorX ?? label.mirrorX;
      label.mirrorY = stand.mirrorY ?? label.mirrorY;
      for (const w of wires) {
        for (const end of [w.from, w.to]) {
          if (end.type === 'pin' && end.compId === vid) {
            end.compId = cid;
            end.terminal = 'P';
          }
        }
      }
    }
  }
}
