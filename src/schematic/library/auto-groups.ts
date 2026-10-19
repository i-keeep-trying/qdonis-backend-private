/**
 * Automatic grouping proposal for a circuit without a saved grouping: the
 * control circuitry split into functional sheets (the power stage stays on
 * top). First per phase / channel (parts with A/B/C or 1/2/3 suffixes), then
 * the shared control parts by connected cluster (large ones split by
 * modularity), named by function. Links are pin connections plus the nodes
 * behavioural sources read in their expressions. Port of `auto_groups` of
 * qdonis-core `schematic_sheets.py`; the networkx pieces it uses
 * (`connected_components`, `greedy_modularity_communities`) are ported below.
 */

import type { CompNets } from '../../simulation/netlist/comp-nets';
import { pyStr, type Dict } from '../../simulation/netlist/py';
import type { SchematicGroup } from '../schematic.types';
import {
  byRef,
  cmpTuple,
  expressionNets,
  regions,
  sortedStr,
  type Symbols,
} from './model';

/** Undirected weighted graph with networkx's insertion-ordered adjacency. */
class Graph {
  readonly adj = new Map<string, Map<string, number>>();

  addNode(n: string): void {
    if (!this.adj.has(n)) this.adj.set(n, new Map());
  }

  weight(a: string, b: string): number {
    return this.adj.get(a)?.get(b) ?? 0;
  }

  /** `add_edge(a, b, weight=...)`: keeps the edge's place in both adjacencies. */
  setEdge(a: string, b: string, w: number): void {
    this.addNode(a);
    this.addNode(b);
    this.adj.get(a)?.set(b, w);
    this.adj.get(b)?.set(a, w);
  }

  neighbours(n: string): string[] {
    return [...(this.adj.get(n)?.keys() ?? [])];
  }

  /** Induced subgraph, node and adjacency order kept. */
  subgraph(nodes: Iterable<string>): Graph {
    const keep = new Set(nodes);
    const sub = new Graph();
    for (const [n, nbrs] of this.adj) {
      if (!keep.has(n)) continue;
      sub.addNode(n);
      for (const [m, w] of nbrs) if (keep.has(m)) sub.adj.get(n)?.set(m, w);
    }
    return sub;
  }

  connectedComponents(): Array<Set<string>> {
    const seen = new Set<string>();
    const out: Array<Set<string>> = [];
    for (const start of this.adj.keys()) {
      if (seen.has(start)) continue;
      const component = new Set([start]);
      let frontier = [start];
      while (frontier.length) {
        const next: string[] = [];
        for (const n of frontier) {
          for (const m of this.adj.get(n)?.keys() ?? []) {
            if (!component.has(m)) {
              component.add(m);
              next.push(m);
            }
          }
        }
        frontier = next;
      }
      for (const n of component) seen.add(n);
      out.push(component);
    }
    return out;
  }
}

/**
 * networkx `greedy_modularity_communities(G, weight="weight", resolution)`
 * (Clauset-Newman-Moore). Its heaps order by (priority, element), so each
 * step merges the pair with the largest gain, ties to the smallest (u, v);
 * merging stops when the best gain is negative.
 */
function greedyModularity(g: Graph, resolution: number): Array<Set<string>> {
  const nodes = [...g.adj.keys()];
  let edges = 0;
  for (const nbrs of g.adj.values()) edges += nbrs.size;
  if (edges === 0) return nodes.map((n) => new Set([n]));

  const degree = new Map<string, number>();
  for (const [n, nbrs] of g.adj) {
    let d = 0;
    for (const w of nbrs.values()) d += w;
    degree.set(n, d);
  }
  let total = 0;
  for (const d of degree.values()) total += d;
  const m = total / 2;
  const q0 = 1 / m;
  const a = new Map(
    nodes.map((n) => [n, (degree.get(n) as number) * q0 * 0.5]),
  );
  const av = (n: string) => a.get(n) as number;

  const dq = new Map<string, Map<string, number>>();
  const row = (u: string) => {
    if (!dq.has(u)) dq.set(u, new Map());
    return dq.get(u) as Map<string, number>;
  };
  const seen = new Set<string>();
  for (const [u, nbrs] of g.adj) {
    for (const [v, wt] of nbrs) {
      if (seen.has(v) || u === v) continue;
      row(u).set(v, (row(u).get(v) ?? 0) + wt);
      row(v).set(u, (row(v).get(u) ?? 0) + wt);
    }
    seen.add(u);
  }
  for (const [u, nbrs] of dq) {
    for (const [v, wt] of nbrs) {
      nbrs.set(v, q0 * wt - resolution * (av(u) * av(v) + av(u) * av(v)));
    }
  }

  const communities = new Map(nodes.map((n) => [n, new Set([n])]));
  for (;;) {
    let best: [number, string, string] | null = null;
    for (const [u, nbrs] of dq) {
      for (const [v, value] of nbrs) {
        const key: [number, string, string] = [-value, u, v];
        if (best === null || cmpTuple(key, best) < 0) best = key;
      }
    }
    if (best === null) break;
    const [negdq, u, v] = best;
    if (-negdq < 0) break;

    communities.set(
      v,
      new Set([...(communities.get(u) ?? []), ...(communities.get(v) ?? [])]),
    );
    communities.delete(u);
    const uNbrs = new Set(row(u).keys());
    const vNbrs = new Set(row(v).keys());
    for (const w of new Set([...uNbrs, ...vNbrs])) {
      if (w === u || w === v) continue;
      let dqvw: number;
      if (uNbrs.has(w) && vNbrs.has(w)) {
        dqvw = (row(v).get(w) as number) + (row(u).get(w) as number);
      } else if (vNbrs.has(w)) {
        dqvw =
          (row(v).get(w) as number) -
          resolution * (av(u) * av(w) + av(w) * av(u));
      } else {
        dqvw =
          (row(u).get(w) as number) -
          resolution * (av(v) * av(w) + av(w) * av(v));
      }
      row(v).set(w, dqvw);
      row(w).set(v, dqvw);
    }
    for (const w of row(u).keys()) row(w).delete(u);
    dq.delete(u);
    for (const nbrs of dq.values()) nbrs.delete(u);
    for (const [k, nbrs] of [...dq]) if (!nbrs.size) dq.delete(k);
    a.set(v, av(v) + av(u));
    a.set(u, 0);
  }
  return [...communities.values()].sort((x, y) => y.size - x.size);
}

const CATEGORIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'PLL',
    ['pll', 'theta', 'omega', 'angle', 'sin', 'cos', 'park', 'clarke', 'dq'],
  ],
  [
    'Modulator',
    ['pwm', 'tri', 'carrier', 'saw', 'mod', 'duty', 'comparator', 'dead'],
  ],
  ['Gate drive', ['gate', 'drv', 'drive', 'gs', 'boot']],
  [
    'Voltage loop',
    [
      'vref',
      'vfb',
      'v_comp',
      'v_clamp',
      'v_err',
      'verr',
      'e_v',
      'r_v',
      'c_v',
      'vloop',
      'v_raw',
      'voltage',
    ],
  ],
  [
    'Current loop',
    [
      'i_act',
      'iref',
      'i_ref',
      'i_target',
      'c_comp',
      'c_clamp',
      'c_raw',
      'e_c',
      'r_c',
      'c_c',
      'iloop',
      'i_err',
      'current',
    ],
  ],
  ['Multiplier', ['mult', 'multiplier']],
  [
    'Sensing',
    [
      'sense',
      'sens',
      'meas',
      'vs_',
      'is_',
      'probe',
      'isense',
      'vsense',
      'shunt',
    ],
  ],
  ['Balancing', ['balanc', 'npb', 'neutral', 'mid']],
  ['Reference', ['ref', 'sine', 'setpoint']],
];

function category(tokens: Map<string, number>): string {
  let best = 'Control';
  let score = 0;
  for (const [name, keys] of CATEGORIES) {
    let s = 0;
    for (const [tok, n] of tokens)
      for (const k of keys) if (tok.includes(k)) s += n;
    if (s > score) [best, score] = [name, s];
  }
  return best;
}

const SUFFIX = /([A-Ca-c]|[1-9])$/;
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'group';
const isAlpha = (s: string) => /^[A-Za-z]+$/.test(s);

/** Proposed groups `{id: {label, members}}` (empty: draw on one sheet). */
export function autoGroups(
  circuit: Dict,
  compNets: CompNets,
  symbols: Symbols,
  drawnIds: ReadonlySet<string>,
): Map<string, SchematicGroup> {
  const groups = new Map<string, SchematicGroup>();
  const lowerDrawn = new Set([...drawnIds].map((d) => d.toLowerCase()));
  const main = new Set(
    [...symbols.keys()].filter((cid) => lowerDrawn.has(cid.toLowerCase())),
  );
  const region = regions(circuit, compNets, symbols, main);
  const control = sortedStr(
    [...region]
      .filter(([cid, r]) => {
        const s = symbols.get(cid);
        return (
          r === 'control' &&
          s &&
          s.type !== 'LABEL' &&
          s.type !== 'GND' &&
          !s.meta.bare
        );
      })
      .map(([cid]) => cid),
  );
  if (control.length < 4) return groups;
  const parts = [...symbols.values()].filter(
    (s) => s.type !== 'LABEL' && s.type !== 'GND' && !s.meta.bare,
  ).length;
  if (parts < 24) return groups; // a small circuit reads best on one sheet
  const refs = byRef(circuit);
  const cset = new Set(control);

  // Links between control parts.
  const netMembers = new Map<string, Set<string>>();
  for (const [ref, pins] of compNets) {
    for (const net of pins.values()) {
      if (net === '0') continue;
      if (!netMembers.has(net)) netMembers.set(net, new Set());
      netMembers.get(net)?.add(ref);
    }
  }
  const graph = new Graph();
  for (const ref of control) graph.addNode(ref);
  const link = (x: string, y: string, w: number) => {
    if (x !== y && cset.has(x) && cset.has(y))
      graph.setEdge(x, y, graph.weight(x, y) + w);
  };
  for (const members of netMembers.values()) {
    const inside = sortedStr([...members].filter((r) => cset.has(r)));
    inside.forEach((x, i) => {
      for (const y of inside.slice(i + 1))
        link(x, y, 1 / Math.max(1, members.size - 1));
    });
  }
  for (const ref of control) {
    for (const net of expressionNets(refs.get(ref) ?? {})) {
      for (const other of netMembers.get(net) ?? []) link(ref, other, 1);
    }
  }

  // 1. Phases / channels.
  const suffixOf = new Map<string, string>();
  for (const ref of control) {
    const m = SUFFIX.exec(ref);
    if (m) suffixOf.set(ref, m[1].toUpperCase());
  }
  const counts = new Map<string, number>();
  for (const sfx of suffixOf.values())
    counts.set(sfx, (counts.get(sfx) ?? 0) + 1);
  let phases = sortedStr(
    [...counts].filter(([, n]) => n >= 3).map(([sfx]) => sfx),
  );
  if (phases.filter(isAlpha).length >= 2) phases = phases.filter(isAlpha); // A/B/C win over numbers
  if (phases.length > 4) phases = []; // numbered per switch (S1..S6), not channels
  let assigned = new Map<string, string>();
  if (phases.length >= 2) {
    assigned = new Map([...suffixOf].filter(([, sfx]) => phases.includes(sfx)));
    for (let pass = 0; pass < 3; pass += 1) {
      // a part stays in its phase only if it is linked to another part of that phase
      const current = assigned;
      assigned = new Map(
        [...current].filter(([ref, sfx]) =>
          graph.neighbours(ref).some((n) => current.get(n) === sfx),
        ),
      );
    }
    // Unsuffixed parts linked only to one phase belong to it.
    for (const ref of control) {
      if (assigned.has(ref)) continue;
      const nbrs = graph.neighbours(ref);
      const linked = new Set(
        nbrs
          .filter((n) => assigned.has(n))
          .map((n) => assigned.get(n) as string),
      );
      const others = nbrs.filter((n) => !assigned.has(n));
      if (linked.size === 1 && !others.length)
        assigned.set(ref, [...linked][0]);
    }
  }

  const tokensOf = (members: string[]) => {
    const tokens = new Map<string, number>();
    for (const ref of members) {
      const comp = refs.get(ref) ?? {};
      const texts = [
        ref,
        comp.role || '',
        ...(compNets.get(ref)?.values() ?? []),
      ];
      for (const text of texts) {
        for (const tok of pyStr(text)
          .toLowerCase()
          .split(/[^a-z0-9_]+/)) {
          if (tok) tokens.set(tok, (tokens.get(tok) ?? 0) + 1);
        }
      }
    }
    return tokens;
  };
  /** The cluster's nets reach switch gates / control inputs outside it. */
  const drivesGates = (members: string[]) => {
    const inside = new Set(members);
    for (const ref of members) {
      for (const net of compNets.get(ref)?.values() ?? []) {
        for (const other of netMembers.get(net) ?? []) {
          if (inside.has(other)) continue;
          const type = refs.get(other)?.type;
          const pins = [...(compNets.get(other) ?? [])]
            .filter(([, n]) => n === net)
            .map(([p]) => p);
          if (
            ['transistor', 'mosfet', 'igbt'].includes(pyStr(type)) &&
            pins.includes('gate')
          )
            return true;
          if (type === 'switch' && pins.some((p) => p.startsWith('ctrl')))
            return true;
        }
      }
    }
    return false;
  };
  const nameCluster = (members: string[]) => {
    const label = category(tokensOf(members));
    return drivesGates(members) && label !== 'Modulator' && label !== 'PLL'
      ? 'Gate drive'
      : label;
  };

  let named: Array<[string, string[]]> = [];
  const letters = phases.every(isAlpha);
  for (const sfx of phases) {
    const members = sortedStr(
      [...assigned].filter(([, x]) => x === sfx).map(([r]) => r),
    );
    if (members.length >= 2) {
      named.push([`${letters ? 'Phase' : 'Channel'} ${sfx} control`, members]);
    } else {
      for (const r of members) assigned.delete(r);
    }
  }

  // 2. Shared control parts: connected clusters (large ones split by modularity).
  const shared = control.filter((r) => !assigned.has(r));
  const sub = graph.subgraph(shared);
  const clusters: Array<Set<string>> = [];
  for (const component of sub.connectedComponents()) {
    if (component.size <= 14) clusters.push(component);
    else clusters.push(...greedyModularity(sub.subgraph(component), 0.5));
  }
  for (const cluster of clusters) {
    const members = sortedStr(cluster);
    if (members.length < 2) {
      // A lone shared part joins the group it is most linked to.
      const ref = members[0];
      let best: number | null = null;
      let weight = 0;
      named.forEach(([, groupMembers], i) => {
        let w = 0;
        for (const mm of groupMembers) w += graph.weight(ref, mm);
        if (w > weight) [best, weight] = [i, w];
      });
      if (best !== null) named[best][1].push(ref);
      continue;
    }
    named.push([nameCluster(members), members]);
  }

  // Small groups of the same kind (one gate driver per switch ...) are one group.
  const merged: Array<[string, string[]]> = [];
  const byLabel = new Map<string, number>();
  for (const [label, members] of named) {
    const at = byLabel.get(label);
    if (members.length <= 5 && at !== undefined && merged[at][1].length <= 40) {
      merged[at][1].push(...members);
      continue;
    }
    if (members.length <= 5) byLabel.set(label, merged.length);
    merged.push([label, [...members]]);
  }
  named = merged;

  // SPICE directives / comments (no pins) on a sheet of their own.
  const spice = sortedStr(
    [...symbols]
      .filter(
        ([cid, s]) =>
          s.type === 'SPICE' &&
          !assigned.has(cid) &&
          !named.some(([, members]) => members.includes(cid)),
      )
      .map(([cid]) => cid),
  );
  if (spice.length >= 2) named.push(['SPICE directives', spice]);

  const labels = new Map<string, number>();
  for (const [label] of named) labels.set(label, (labels.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const ordered = [...named].sort((x, y) =>
    cmpTuple([x[0], sortedStr(x[1])[0]], [y[0], sortedStr(y[1])[0]]),
  );
  for (const [base, members] of ordered) {
    let label = base;
    if ((labels.get(base) ?? 0) > 1) {
      seen.set(base, (seen.get(base) ?? 0) + 1);
      label = `${base} ${seen.get(base)}`;
    }
    let gid = slug(label);
    while (groups.has(gid)) gid += '_';
    groups.set(gid, { label, members: sortedStr(members) });
  }
  return groups;
}
