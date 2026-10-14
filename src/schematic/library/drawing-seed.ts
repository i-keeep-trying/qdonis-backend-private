/**
 * Seed positions from the old hand-drawn schematic (`json_library`) for a
 * topology that has no layout: parts are matched by name, by name family
 * (`S_A_1` -> `S_A`), then by type + connectivity. The old drawings often
 * disagree with the simulated circuit, so they are never used for
 * connectivity or values. Port of `_seed_from_drawing` of qdonis-core
 * `schematic_sync.py`.
 */

import {
  isDict,
  pyStr,
  toFloat,
  truthy,
  type Dict,
} from '../../simulation/netlist/py';
import type { Placement, SchematicSymbol } from '../schematic.types';
import { pinTable, snap } from './geometry';
import { sortedStr, type Symbols } from './model';
import { TRANSISTOR_SYMBOLS, TWO_TERMINAL } from './symbols';

const FAMILY: Readonly<Record<string, string>> = {
  R: 'R',
  L: 'L',
  C: 'C',
  D: 'D',
  SCR: 'D',
  MOSFET: 'SW',
  MOSFET_BI: 'SW',
  ...Object.fromEntries(TRANSISTOR_SYMBOLS.map((t) => [t, 'SW'])),
  S: 'SW',
  VSW: 'SW',
  'vg-FET': 'SW',
  V: 'SRC',
  AC_V: 'SRC',
  I: 'SRC',
  XFMR: 'X',
  XFMR_CT: 'X',
  XFMR_MULTI: 'X',
  XFMR_DCT: 'X',
};
const familyOf = (type: string) =>
  Object.hasOwn(FAMILY, type) ? FAMILY[type] : type;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** Neighbour sets keyed by part, then by terminal. */
export type TerminalNeighbours = Map<string, Map<string, Set<string>>>;

const samePins = (
  a: ReturnType<typeof pinTable>,
  b: ReturnType<typeof pinTable>,
) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());

/** Positions for the parts the hand-drawn schematic shows. */
export function seedFromDrawing(
  symbols: Symbols,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  terminalNeighbours: TerminalNeighbours,
  drawing: Dict,
): Map<string, Placement> {
  const dcomps = new Map<string, Dict>();
  for (const c of Array.isArray(drawing.components) ? drawing.components : []) {
    if (isDict(c) && truthy(c.id)) dcomps.set(pyStr(c.id), c);
  }
  const seeded = new Map<string, Placement>();
  if (!dcomps.size) return seeded;

  // Drawing connectivity: terminals joined by wires (wire-to-wire taps included).
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
  for (const w of Array.isArray(drawing.wires) ? drawing.wires : []) {
    if (!isDict(w)) continue;
    const wid = JSON.stringify(['w', w.id ?? null]);
    for (const end of [w.from, w.to]) {
      if (!isDict(end)) continue;
      const key =
        end.type === 'pin'
          ? JSON.stringify(['p', end.compId ?? null, end.terminal ?? null])
          : JSON.stringify(['w', end.wireId ?? null]);
      parent.set(find(wid), find(key));
    }
  }
  const netMembers = new Map<string, Array<[string, string]>>();
  for (const key of [...parent.keys()]) {
    const parsed = JSON.parse(key) as unknown[];
    if (parsed[0] !== 'p') continue;
    const root = find(key);
    if (!netMembers.has(root)) netMembers.set(root, []);
    netMembers.get(root)?.push([pyStr(parsed[1]), pyStr(parsed[2])]);
  }
  const dadj = new Map<string, Set<string>>();
  const dtermNeighbours = new Map<string, Set<string>>();
  const add = (
    map: Map<string, Set<string>>,
    key: string,
    ids: Iterable<string>,
    self: string,
  ) => {
    if (!map.has(key)) map.set(key, new Set());
    for (const id of ids) if (id !== self) map.get(key)?.add(id);
  };
  for (const members of netMembers.values()) {
    const ids = new Set(members.map(([cid]) => cid));
    for (const [cid, term] of members) {
      add(dtermNeighbours, JSON.stringify([cid, term]), ids, cid);
      if (ids.size <= 8) add(dadj, cid, ids, cid);
    }
  }

  const candidates = new Set(
    [...symbols]
      .filter(
        ([, s]) =>
          !['LABEL', 'GND', 'SPICE', 'SHEET', 'PORT'].includes(s.type) &&
          !s.meta.bare,
      )
      .map(([cid]) => cid),
  );
  const match = new Map<string, string>();
  const matched = () => new Set(match.values());
  const lower = new Map(
    [...dcomps.keys()].map((dname) => [dname.toLowerCase(), dname]),
  );
  for (const cid of sortedStr(candidates)) {
    const did = lower.get(cid.toLowerCase());
    if (did !== undefined && !matched().has(did)) match.set(cid, did);
  }
  for (const cid of sortedStr([...candidates].filter((c) => !match.has(c)))) {
    const family = new RegExp(`^${escape(cid)}(?:_?[A-Za-z0-9]{1,2})$`, 'i');
    const used = matched();
    const fam = sortedStr(
      [...dcomps.keys()].filter(
        (dname) => !used.has(dname) && family.test(dname),
      ),
    );
    if (fam.length) match.set(cid, fam[0]);
  }

  const symbolFamily = (cid: string) =>
    familyOf((symbols.get(cid) as SchematicSymbol).type);
  const drawingFamily = (did: string) =>
    familyOf(pyStr(dcomps.get(did)?.type ?? null));

  for (;;) {
    const used = matched();
    let best: [string, string] | null = null;
    let bestScore = 0;
    for (const cid of sortedStr([...candidates].filter((c) => !match.has(c)))) {
      for (const did of sortedStr(
        [...dcomps.keys()].filter((dname) => !used.has(dname)),
      )) {
        if (symbolFamily(cid) !== drawingFamily(did)) continue;
        const around = dadj.get(did) ?? new Set<string>();
        let score = 0;
        for (const n of adjacency.get(cid) ?? []) {
          const m = match.get(n);
          if (m !== undefined && around.has(m)) score += 1;
        }
        if (score > bestScore) [best, bestScore] = [[cid, did], score];
      }
    }
    if (!best) break;
    match.set(best[0], best[1]);
  }
  // A family with exactly one part left on each side is the same part.
  const left = new Map<string, string[]>();
  const right = new Map<string, string[]>();
  for (const cid of candidates) {
    if (match.has(cid)) continue;
    const fam = symbolFamily(cid);
    left.set(fam, [...(left.get(fam) ?? []), cid]);
  }
  const used = matched();
  for (const did of dcomps.keys()) {
    if (used.has(did)) continue;
    const fam = drawingFamily(did);
    right.set(fam, [...(right.get(fam) ?? []), did]);
  }
  for (const [fam, cids] of left) {
    const rest = right.get(fam) ?? [];
    if (cids.length === 1 && rest.length === 1) match.set(cids[0], rest[0]);
  }

  for (const [cid, did] of match) {
    const dc = dcomps.get(did) as Dict;
    let x: number;
    let y: number;
    try {
      x = toFloat(Object.hasOwn(dc, 'x') ? dc.x : 0);
      y = toFloat(Object.hasOwn(dc, 'y') ? dc.y : 0);
    } catch {
      continue;
    }
    const rotation =
      ((Math.trunc(toFloat(dc.rotation || 0)) % 360) + 360) % 360;
    const place: Placement = {
      x: snap(x),
      y: snap(y),
      rotation,
      mirrorX: truthy(dc.mirrorX),
      mirrorY: truthy(dc.mirrorY),
    };
    const sym = symbols.get(cid) as SchematicSymbol;
    const drawn = {
      type: pyStr(dc.type ?? null),
      pins: isDict(dc.pins) ? dc.pins : undefined,
    } as unknown as SchematicSymbol;
    // Two-terminal parts: turn the part round if its + side faces the other way.
    if (
      ['R', 'L', 'C', 'D', 'V', 'AC_V', 'VPULSE', 'BSRC'].includes(sym.type) &&
      samePins(pinTable(drawn), TWO_TERMINAL)
    ) {
      const side = (t: string) =>
        terminalNeighbours.get(cid)?.get(t) ?? new Set<string>();
      const dside = (t: string) =>
        dtermNeighbours.get(JSON.stringify([did, t])) ?? new Set<string>();
      const overlap = (mine: Set<string>, theirs: Set<string>) =>
        new Set(
          [...mine]
            .map((n) => match.get(n))
            .filter((m) => m !== undefined && theirs.has(m)),
        ).size;
      const same =
        overlap(side('A'), dside('A')) + overlap(side('B'), dside('B'));
      const swapped =
        overlap(side('A'), dside('B')) + overlap(side('B'), dside('A'));
      if (swapped > same) place.rotation = (rotation + 180) % 360;
    }
    seeded.set(cid, place);
  }
  return seeded;
}
