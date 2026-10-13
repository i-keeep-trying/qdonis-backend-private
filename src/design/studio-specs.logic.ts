import { randomBytes } from 'node:crypto';

import {
  type CommitResult,
  commitStage,
  patchNode,
  type StageNode,
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { asArray, asString, isRecord } from './ai/json-response';
import { ENGINEERING_CATEGORIES } from './catalog/mandatory-parameters';

/**
 * Specs / constraints stage of the Studio (ported from the old frontend
 * `lib/studio/stages.ts`: updateSpecs, updateConstraints, approveSpecs,
 * recordTopologyOptions, generateConstraints post-processing). Pure functions
 * over the graph; ProjectsService.mutateStudio persists them.
 */

export type SpecCategory =
  | 'electrical'
  | 'performance'
  | 'thermal'
  | 'mechanical'
  | 'compliance'
  | 'other';
export type SpecSource = 'user' | 'assumed' | 'derived';

export interface SpecRow {
  id: string;
  name: string;
  value: string;
  unit?: string;
  category?: SpecCategory;
  required?: boolean;
  source?: SpecSource;
  note?: string;
}

export interface ConstraintItem {
  id: string;
  name: string;
  value: string;
  category: string;
  reasoning?: string;
  source: 'ai' | 'user';
}

export interface ConstraintsData {
  items: ConstraintItem[];
  assumptions: string[];
  citations: Array<{ title: string; uri: string }>;
  basis: string;
  generatedAt: string;
  status?: 'running' | 'error';
  error?: string;
  /** Queued generation that owns the `running` status (`simulation_runs.id`). */
  runId?: string;
}

export interface TopologyOption {
  topology_id: string;
  title: string;
  summary: string;
  pros?: string[];
  cons?: string[];
  recommended?: boolean;
}

export interface SpecsData {
  application?: string;
  rows: SpecRow[];
  approved: boolean;
  topologyOptions?: TopologyOption[];
  constraints?: ConstraintsData;
}

export interface StageResult {
  ok: boolean;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface StageOutcome {
  project: StudioProject;
  result: StageResult;
}

const shortId = (prefix: string) =>
  `${prefix}_${randomBytes(5).toString('hex').slice(0, 7)}`;
export const normName = (name: string) =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

export const hasConstraintValue = (v: string | undefined): boolean =>
  !!v && !/^(null|none|n\/a|tbd|-|—)$/i.test(v.trim());

export const constraintCategory = (key: unknown): string =>
  ENGINEERING_CATEGORIES.some((c) => c.id === key)
    ? String(key)
    : 'functional_constraints';

export const constraintValue = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => constraintValue(x)).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
};

const emptyConstraints = (basis = ''): ConstraintsData => ({
  items: [],
  assumptions: [],
  citations: [],
  basis,
  generatedAt: '',
});

/** Signature of the key spec rows; a constraints list built from other rows is stale. */
export function specsSignature(
  rows: Array<{ name: string; value: string; unit?: string }>,
): string {
  return rows
    .map((r) =>
      `${r.name.trim().toLowerCase().replace(/\s+/g, ' ')}=${r.value} ${r.unit || ''}`.trim(),
    )
    .sort()
    .join('|');
}

/** Specs node data, typed (tolerant of legacy shapes). */
export function specsOf(node: StageNode | null): SpecsData | null {
  if (!node) return null;
  const d = node.data;
  return {
    application: asString(d.application) ?? undefined,
    rows: asArray(d.rows).filter(isRecord) as unknown as SpecRow[],
    approved: d.approved === true,
    topologyOptions: Array.isArray(d.topologyOptions)
      ? (d.topologyOptions as TopologyOption[])
      : undefined,
    constraints: isRecord(d.constraints)
      ? (d.constraints as unknown as ConstraintsData)
      : undefined,
  };
}

export function forkNote(
  commit: Pick<CommitResult, 'forked' | 'branchName'>,
): Record<string, unknown> {
  return commit.forked
    ? {
        branch_created: commit.branchName,
        note: `A new branch "${commit.branchName}" was created so earlier results are preserved.`,
      }
    : { branch: commit.branchName };
}

const asData = (data: SpecsData): Record<string, unknown> =>
  JSON.parse(JSON.stringify(data)) as Record<string, unknown>;

export interface SpecRowInput {
  name: string;
  value: string;
  unit?: string;
  category?: SpecCategory;
  required?: boolean;
  source?: SpecSource;
  note?: string;
}

/** Merge rows by name; a content change voids an earlier approval. */
export function updateSpecs(
  project: StudioProject,
  input: {
    application?: string;
    rows?: SpecRowInput[];
    remove?: string[];
    requestApproval?: boolean;
    approved?: boolean;
  },
  source: 'agent' | 'user',
): StageOutcome {
  const currentNode = stageNodeOnBranch(project, 'specs');
  const current = specsOf(currentNode);
  const removed = new Set((input.remove ?? []).map(normName));
  let merged: SpecRow[] = (current?.rows ?? [])
    .map((r) => ({ ...r }))
    .filter((r) => !removed.has(normName(r.name)));

  for (const incoming of input.rows ?? []) {
    if (!incoming?.name) continue;
    const idx = merged.findIndex(
      (r) => normName(r.name) === normName(incoming.name),
    );
    const prev = idx >= 0 ? merged[idx] : null;
    const row: SpecRow = {
      id: prev?.id ?? shortId('row'),
      name: incoming.name.trim(),
      value: String(incoming.value ?? '').trim(),
      unit: incoming.unit ?? prev?.unit ?? '',
      category: incoming.category ?? prev?.category ?? 'electrical',
      required: incoming.required ?? prev?.required ?? false,
      source: incoming.source ?? 'user',
      note: incoming.note ?? prev?.note ?? '',
    };
    if (idx >= 0) merged[idx] = row;
    else merged = [...merged, row];
  }

  const changed =
    JSON.stringify(merged) !== JSON.stringify(current?.rows ?? []) ||
    Boolean(input.application && input.application !== current?.application);
  return writeSpecRows(project, currentNode, current, {
    rows: merged,
    application: input.application ?? current?.application,
    changed,
    source,
    approved: input.approved,
    requestApproval: input.requestApproval,
  });
}

/**
 * The whole spec table as edited in the workspace: rows keep their id, an
 * unchanged row keeps its source (assumed / derived), every other row
 * becomes the user's. Rows left out are removed.
 */
export function replaceSpecs(
  project: StudioProject,
  input: {
    application: string | null;
    rows: Array<{
      id?: string;
      name: string;
      value: string;
      unit: string | null;
      category: SpecCategory;
      required: boolean;
    }>;
  },
): StageOutcome {
  const currentNode = stageNodeOnBranch(project, 'specs');
  const current = specsOf(currentNode);
  const byId = new Map((current?.rows ?? []).map((r) => [r.id, r]));
  const rows: SpecRow[] = input.rows.map((incoming) => {
    const prev = incoming.id ? byId.get(incoming.id) : undefined;
    const name = incoming.name.trim();
    const value = incoming.value.trim();
    const unit = incoming.unit?.trim() ?? '';
    const same =
      prev !== undefined &&
      normName(prev.name) === normName(name) &&
      prev.value === value &&
      (prev.unit ?? '') === unit;
    return {
      id: prev?.id ?? shortId('row'),
      name,
      value,
      unit,
      category: incoming.category,
      required: incoming.required,
      source: same ? (prev.source ?? 'user') : 'user',
      note: prev?.note ?? '',
    };
  });
  const application = input.application?.trim() || undefined;
  const changed =
    JSON.stringify(rows) !== JSON.stringify(current?.rows ?? []) ||
    application !== current?.application;
  return writeSpecRows(project, currentNode, current, {
    rows,
    application,
    changed,
    source: 'user',
  });
}

/** Stores spec rows: in place when nothing changed, else a new version. */
function writeSpecRows(
  project: StudioProject,
  currentNode: StageNode | null,
  current: SpecsData | null,
  input: {
    rows: SpecRow[];
    application: string | undefined;
    changed: boolean;
    source: 'agent' | 'user';
    approved?: boolean;
    requestApproval?: boolean;
  },
): StageOutcome {
  const { rows: merged, changed } = input;
  const data: SpecsData = {
    application: input.application,
    rows: merged,
    approved: input.approved
      ? true
      : changed
        ? false
        : Boolean(current?.approved),
    topologyOptions: changed ? undefined : current?.topologyOptions,
    constraints: current?.constraints,
  };
  const source = input.source;

  let next: StudioProject;
  let commit: Pick<CommitResult, 'nodeId' | 'forked' | 'branchName'>;
  if (!changed && currentNode) {
    next = patchNode(project, currentNode.id, { data: asData(data) });
    commit = {
      nodeId: currentNode.id,
      forked: false,
      branchName: project.branches[project.activeBranchId].name,
    };
  } else {
    const c = commitStage(project, 'specs', asData(data), {
      source,
      summary: `${merged.length} spec rows`,
    });
    next = c.project;
    commit = c;
  }
  next = { ...next, focus: 'specs' };

  return {
    project: next,
    result: {
      ok: true,
      summary: input.requestApproval
        ? `Specs table ready for review (${merged.length} rows)`
        : `Specs updated (${merged.length} rows)`,
      payload: {
        rows: merged.length,
        approved: data.approved,
        ...forkNote(commit),
        ...(input.requestApproval
          ? {
              note: 'The table is shown in the workspace with an Approve button. Ask the user to review it (approve, edit cells directly, or tell you what to change). Do NOT continue to topology/design until they approve.',
            }
          : {}),
      },
    },
  };
}

export function approveSpecs(project: StudioProject): StageOutcome {
  const node = stageNodeOnBranch(project, 'specs');
  if (!node)
    return { project, result: { ok: false, summary: 'No specification yet.' } };
  return {
    project: patchNode(project, node.id, {
      data: { ...node.data, approved: true },
    }),
    result: { ok: true, summary: 'Specs approved' },
  };
}

export function updateConstraints(
  project: StudioProject,
  input: {
    items?: Array<{
      name: string;
      value: string;
      category?: string;
      reasoning?: string;
    }>;
    remove?: string[];
  },
  source: 'agent' | 'user',
): StageOutcome {
  const node = stageNodeOnBranch(project, 'specs');
  const specs = specsOf(node);
  if (!node || !specs)
    return { project, result: { ok: false, summary: 'No specification yet.' } };
  const current = specs.constraints ?? {
    ...emptyConstraints(specsSignature(specs.rows)),
    generatedAt: new Date().toISOString(),
  };
  const removed = new Set((input.remove ?? []).map(normName));
  let items = current.items.filter((c) => !removed.has(normName(c.name)));
  for (const incoming of input.items ?? []) {
    if (!incoming?.name) continue;
    const idx = items.findIndex(
      (c) => normName(c.name) === normName(incoming.name),
    );
    const prev = idx >= 0 ? items[idx] : null;
    const item: ConstraintItem = {
      id: prev?.id ?? shortId('con'),
      name: incoming.name.trim(),
      value: String(incoming.value ?? '').trim(),
      category: constraintCategory(incoming.category ?? prev?.category),
      reasoning: incoming.reasoning ?? prev?.reasoning ?? '',
      source: 'user',
    };
    if (idx >= 0) items[idx] = item;
    else items = [...items, item];
  }
  const data: SpecsData = {
    ...specs,
    constraints: {
      ...current,
      items,
      status: undefined,
      error: undefined,
      runId: undefined,
    },
  };
  const commit = commitStage(project, 'specs', asData(data), {
    source,
    summary: `${specs.rows.length} spec rows · ${items.length} constraints`,
  });
  return {
    project: { ...commit.project, focus: 'specs' },
    result: {
      ok: true,
      summary: `Constraints updated (${items.length})`,
      payload: { total: items.length, ...forkNote(commit) },
    },
  };
}

/** New values for constraints picked by id (the workspace table); edited items become the user's. */
export function editConstraintValues(
  project: StudioProject,
  edits: Array<{ id: string; value: string }>,
): StageOutcome {
  const specs = specsOf(stageNodeOnBranch(project, 'specs'));
  const items = specs?.constraints?.items ?? [];
  if (!specs || items.length === 0) {
    return {
      project,
      result: { ok: false, summary: 'Generate the constraints list first.' },
    };
  }
  const byId = new Map(items.map((c) => [c.id, c]));
  const unknown = edits.filter((e) => !byId.has(e.id)).map((e) => e.id);
  if (unknown.length) {
    return {
      project,
      result: {
        ok: false,
        summary: `Unknown constraint: ${unknown.join(', ')}`,
      },
    };
  }
  return updateConstraints(
    project,
    {
      items: edits.map((e) => {
        const item = byId.get(e.id)!;
        return { name: item.name, value: e.value, category: item.category };
      }),
    },
    'user',
  );
}

export function recordTopologyOptions(
  project: StudioProject,
  options: TopologyOption[],
): StudioProject {
  const node = stageNodeOnBranch(project, 'specs');
  if (node)
    return patchNode(project, node.id, {
      data: { ...node.data, topologyOptions: options },
    });
  return commitStage(
    project,
    'specs',
    { rows: [], approved: false, topologyOptions: options },
    { summary: 'Topology options' },
  ).project;
}

/** Marks the constraints of a specs node as being generated by queued run `runId`. */
export function markConstraintsRunning(
  project: StudioProject,
  nodeId: string,
  runId: string,
): StudioProject {
  const node = project.nodes[nodeId];
  const specs = specsOf(node ?? null);
  if (!node || !specs) return project;
  const constraints: ConstraintsData = {
    ...(specs.constraints ?? emptyConstraints(specsSignature(specs.rows))),
    status: 'running',
    error: undefined,
    runId,
  };
  return patchNode(project, nodeId, {
    data: asData({ ...specs, constraints }),
  });
}

/**
 * Ends run `runId` on a specs node: clears the running marker, or records
 * `error`. Null when the node is gone or another run owns it.
 */
export function settleConstraints(
  project: StudioProject,
  nodeId: string,
  runId: string,
  error: string | null,
): StudioProject | null {
  const node = project.nodes[nodeId];
  const specs = specsOf(node ?? null);
  if (!node || !specs?.constraints || specs.constraints.runId !== runId) {
    return null;
  }
  const rest: ConstraintsData = { ...specs.constraints };
  delete rest.status;
  delete rest.error;
  delete rest.runId;
  const constraints: ConstraintsData | undefined = error
    ? { ...rest, status: 'error', error }
    : rest.items.length || rest.generatedAt
      ? rest
      : undefined;
  return patchNode(project, nodeId, {
    data: asData({ ...specs, constraints }),
  });
}

/** The prompt text the constraints generation sends (old generateConstraints). */
export function constraintsPromptInput(
  specs: SpecsData,
  notes?: string,
): string {
  const handSet = (specs.constraints?.items ?? []).filter(
    (c) => c.source === 'user',
  );
  return [
    specs.application ? `Application: ${specs.application}` : '',
    'Key specifications agreed with the engineer (treat these as fixed; derive everything else from them):',
    ...specs.rows.map(
      (r) =>
        `- ${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ''} [${r.source || 'user'}]${r.note ? ` — ${r.note}` : ''}`,
    ),
    handSet.length
      ? `Constraints the engineer set by hand (keep them as they are):\n${handSet.map((c) => `- ${c.name}: ${c.value}`).join('\n')}`
      : '',
    notes ? `Engineer's notes: ${notes}` : '',
    'Produce a comprehensive industrial constraints list: cover EVERY category with several concrete, quantified items.',
  ]
    .filter(Boolean)
    .join('\n');
}

function constraintsPayload(data: ConstraintsData): Record<string, unknown> {
  const byCategory: Record<string, string[]> = {};
  for (const c of data.items)
    (byCategory[c.category] ||= []).push(
      `${c.name}: ${c.value || 'unspecified'}`,
    );
  return {
    total: data.items.length,
    by_category: byCategory,
    assumptions: data.assumptions.slice(0, 12),
    citations: data.citations.length,
  };
}

/**
 * Attaches a generated constraints list to the specs node. The first list is
 * stored in place; a regenerated list is a new version of the specs (it forks
 * when later stages were built on the old one). Hand-set items are kept.
 */
export function applyGeneratedConstraints(
  project: StudioProject,
  nodeId: string,
  generated: {
    derivedParametersList: unknown[];
    assumptionsMade: string[];
    citations: Array<{ title: string; uri: string }>;
  },
): StageOutcome {
  const node = project.nodes[nodeId];
  const specs = specsOf(node ?? null);
  if (!node || !specs) {
    return {
      project,
      result: {
        ok: false,
        summary:
          'The specification changed while the constraints were generated; run it again.',
      },
    };
  }
  const previous = specs.constraints?.items.length
    ? specs.constraints
    : undefined;
  const handSet = (previous?.items ?? []).filter((c) => c.source === 'user');
  const handNames = new Set(handSet.map((c) => normName(c.name)));
  const aiItems: ConstraintItem[] = generated.derivedParametersList
    .filter(isRecord)
    .filter(
      (p) =>
        typeof p.name === 'string' &&
        p.name.trim() &&
        !handNames.has(normName(p.name)),
    )
    .map((p) => ({
      id: shortId('con'),
      name: String(p.name as string).trim(),
      value: constraintValue(p.value),
      category: constraintCategory(p.categoryKey),
      reasoning: asString(p.reasoning) ?? '',
      source: 'ai' as const,
    }));
  const data: ConstraintsData = {
    items: [...aiItems, ...handSet],
    assumptions: generated.assumptionsMade,
    citations: generated.citations,
    basis: specsSignature(specs.rows),
    generatedAt: new Date().toISOString(),
  };
  const specsData = asData({ ...specs, constraints: data });

  let next: StudioProject;
  let commit: Pick<CommitResult, 'forked' | 'branchName'>;
  if (!previous) {
    next = patchNode(project, nodeId, { data: specsData });
    commit = {
      forked: false,
      branchName: project.branches[project.activeBranchId].name,
    };
  } else {
    const c = commitStage(project, 'specs', specsData, {
      source: 'agent',
      summary: `${data.items.length} constraints`,
    });
    next = c.project;
    commit = c;
  }
  return {
    project: { ...next, focus: 'specs' },
    result: {
      ok: true,
      summary: `${data.items.length} engineering constraints generated`,
      payload: {
        ...constraintsPayload(data),
        ...forkNote(commit),
        note: 'The full list is shown in the Specs tab under Constraints. run_design receives it automatically.',
      },
    },
  };
}

/**
 * Specs -> the parameter object the design/sizing stage expects (old
 * `specsToParameters`). Exported for the simulation/design providers.
 */
export function specsToParameters(
  specs: SpecsData | null,
): Record<string, unknown> | undefined {
  if (!specs || specs.rows.length === 0) return undefined;
  const derivedParametersList = specs.rows
    .filter((r) => r.value && r.value.toUpperCase() !== 'TBD')
    .map((r) => ({
      name: r.name,
      value: r.unit ? `${r.value} ${r.unit}` : r.value,
      unit: r.unit || '',
      notes: r.note || '',
    }));
  const flat: Record<string, string> = {};
  for (const p of derivedParametersList) flat[p.name] = p.value;
  const keyNames = new Set(specs.rows.map((r) => normName(r.name)));
  const designConstraints = (specs.constraints?.items ?? [])
    .filter(
      (c) => hasConstraintValue(c.value) && !keyNames.has(normName(c.name)),
    )
    .map((c) => ({ name: c.name, value: c.value, category: c.category }));
  return {
    ...flat,
    application: specs.application || '',
    derivedParametersList,
    ...(designConstraints.length ? { designConstraints } : {}),
    assumptionsMade: specs.rows
      .filter((r) => r.source === 'assumed')
      .map(
        (r) =>
          `${r.name} = ${r.value} ${r.unit || ''} (${r.note || 'assumed'})`,
      ),
  };
}
