import { randomUUID } from 'node:crypto';

/**
 * The Studio project graph (ported from the old frontend `lib/studio/store.ts`).
 * Stage results are nodes; branches are named heads; a stage re-run with work
 * on top of it forks a new branch so earlier results are never overwritten.
 *
 * Functions here are pure: they return a new project and never mutate input.
 */
export const STAGE_ORDER = [
  'specs',
  'visualization',
  'design',
  'simulation',
  'magnetics',
  'thermal',
  'mtbf',
  'bom',
  'emc',
  'components',
] as const;
/**
 * Stages a stored node can have: the workspace stages plus `devices`, a
 * former stage (device selection now lives on the simulation node). Old
 * `devices` nodes stay in the history; nothing creates new ones.
 */
export const STAGE_KINDS = [...STAGE_ORDER, 'devices'] as const;
export type WorkspaceStage = (typeof STAGE_ORDER)[number];
export type StageKind = (typeof STAGE_KINDS)[number];

/** The stages of the full-design flow (always shown for full projects). */
export const CORE_STAGES = [
  'specs',
  'visualization',
  'design',
  'simulation',
  'magnetics',
  'thermal',
  'mtbf',
  'bom',
] as const satisfies readonly WorkspaceStage[];

export function isWorkspaceStage(value: unknown): value is WorkspaceStage {
  return (
    typeof value === 'string' &&
    (STAGE_ORDER as readonly string[]).includes(value)
  );
}

export const STAGE_LABEL: Record<StageKind, string> = {
  specs: 'Specs',
  visualization: 'Circuit',
  design: 'Design',
  simulation: 'Simulation',
  devices: 'Devices',
  magnetics: 'Magnetics',
  thermal: 'Thermal',
  mtbf: 'MTBF',
  bom: 'BOM',
  emc: 'EMC',
  components: 'Components',
};

export type NodeStatus = 'running' | 'ready' | 'error';
export type NodeSource = 'agent' | 'user' | 'upload' | 'legacy';

export type JsonObject = Record<string, unknown>;

export interface StageNode {
  id: string;
  parentId: string | null;
  stage: StageKind;
  status: NodeStatus;
  error?: string | null;
  rev: number;
  data: JsonObject;
  source: NodeSource;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

export interface Branch {
  id: string;
  name: string;
  headId: string | null;
  forkedFromId?: string | null;
  createdAt: string;
  colorIndex: number;
}

export interface StudioProject {
  version: 1;
  nodes: Record<string, StageNode>;
  branches: Record<string, Branch>;
  branchOrder: string[];
  activeBranchId: string;
  focus: StageKind | null;
  messages: JsonObject[];
  initialPrompt?: string;
  /** Entry step of the project; absent on projects made before it existed (= full). */
  scope?: StudioScope;
  createdAt: string;
}

/**
 * Which part of the flow a project covers. `undecided`: a new project whose
 * first step is not chosen yet. `entry`: the project starts at `entry` and
 * may only continue downstream of it; `entry: 'specs'` is the full flow.
 * `locked` turns true when the entry step first runs: until then the user
 * may still pick another entry step.
 */
export type StudioScope =
  | { mode: 'undecided' }
  | { mode: 'entry'; entry: WorkspaceStage; locked: boolean };

export const newId = (prefix = ''): string =>
  prefix ? `${prefix}_${randomUUID()}` : randomUUID();

const now = (): string => new Date().toISOString();

export function isStageKind(value: unknown): value is StageKind {
  return (
    typeof value === 'string' &&
    (STAGE_KINDS as readonly string[]).includes(value)
  );
}

export function createEmptyProject(
  initialPrompt?: string,
  scope?: StudioScope,
): StudioProject {
  const main: Branch = {
    id: newId('br'),
    name: 'main',
    headId: null,
    createdAt: now(),
    colorIndex: 0,
  };
  return {
    version: 1,
    nodes: {},
    branches: { [main.id]: main },
    branchOrder: [main.id],
    activeBranchId: main.id,
    focus: null,
    messages: [],
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(scope ? { scope } : {}),
    createdAt: now(),
  };
}

/** Nodes from the root to `headId` (inclusive), oldest first. Cycle-safe. */
export function ancestry(
  project: StudioProject,
  headId: string | null,
): StageNode[] {
  const out: StageNode[] = [];
  let cursor = headId;
  const seen = new Set<string>();
  while (cursor && project.nodes[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    out.push(project.nodes[cursor]);
    cursor = project.nodes[cursor].parentId;
  }
  return out.reverse();
}

export function branchPath(
  project: StudioProject,
  branchId?: string,
): StageNode[] {
  const branch = project.branches[branchId ?? project.activeBranchId];
  return branch ? ancestry(project, branch.headId) : [];
}

/** Latest node of `stage` on the branch (closest to the head). */
export function stageNodeOnBranch(
  project: StudioProject,
  stage: StageKind,
  branchId?: string,
): StageNode | null {
  const path = branchPath(project, branchId);
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i].stage === stage) return path[i];
  }
  return null;
}

export function childrenOf(
  project: StudioProject,
  nodeId: string,
): StageNode[] {
  return Object.values(project.nodes).filter((n) => n.parentId === nodeId);
}

function uniqueBranchName(project: StudioProject, base: string): string {
  const names = new Set(
    Object.values(project.branches).map((b) => b.name.toLowerCase()),
  );
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}

function autoBranchName(project: StudioProject, stage: StageKind): string {
  const count =
    Object.values(project.nodes).filter((n) => n.stage === stage).length + 1;
  return uniqueBranchName(project, `${STAGE_LABEL[stage]} v${count}`);
}

export interface CommitOptions {
  source?: NodeSource;
  summary?: string;
  status?: NodeStatus;
  error?: string | null;
  /** Always fork a new branch, even if the node could be updated in place. */
  forceFork?: boolean;
  branchName?: string;
}

export interface CommitResult {
  project: StudioProject;
  nodeId: string;
  forked: boolean;
  branchName: string;
}

/**
 * Records a stage result on the active branch:
 * 1. in place, when the stage is the branch head and nothing builds on it;
 * 2. as a fork (new branch), when later work exists on top of it;
 * 3. appended to the branch otherwise.
 */
export function commitStage(
  project: StudioProject,
  stage: StageKind,
  data: JsonObject,
  opts: CommitOptions = {},
): CommitResult {
  const branch = project.branches[project.activeBranchId];
  if (!branch) throw new Error('The active branch does not exist');
  const path = branchPath(project);
  const existing = [...path].reverse().find((n) => n.stage === stage);
  const timestamp = now();

  if (
    existing &&
    !opts.forceFork &&
    childrenOf(project, existing.id).length === 0 &&
    branch.headId === existing.id
  ) {
    const updated: StageNode = {
      ...existing,
      data,
      rev: existing.rev + 1,
      status: opts.status ?? 'ready',
      error: opts.error ?? null,
      source: opts.source ?? existing.source,
      summary: opts.summary ?? existing.summary,
      updatedAt: timestamp,
    };
    return {
      project: {
        ...project,
        nodes: { ...project.nodes, [existing.id]: updated },
        focus: stage,
      },
      nodeId: existing.id,
      forked: false,
      branchName: branch.name,
    };
  }

  const node: StageNode = {
    id: newId('n'),
    parentId: existing ? existing.parentId : branch.headId,
    stage,
    status: opts.status ?? 'ready',
    error: opts.error ?? null,
    rev: 1,
    data,
    source: opts.source ?? 'agent',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(opts.summary ? { summary: opts.summary } : {}),
  };

  if (existing || opts.forceFork) {
    const newBranch: Branch = {
      id: newId('br'),
      name: opts.branchName
        ? uniqueBranchName(project, opts.branchName)
        : autoBranchName(project, stage),
      headId: node.id,
      forkedFromId: node.parentId,
      createdAt: timestamp,
      colorIndex: project.branchOrder.length,
    };
    return {
      project: {
        ...project,
        nodes: { ...project.nodes, [node.id]: node },
        branches: { ...project.branches, [newBranch.id]: newBranch },
        branchOrder: [...project.branchOrder, newBranch.id],
        activeBranchId: newBranch.id,
        focus: stage,
      },
      nodeId: node.id,
      forked: true,
      branchName: newBranch.name,
    };
  }

  return {
    project: {
      ...project,
      nodes: { ...project.nodes, [node.id]: node },
      branches: {
        ...project.branches,
        [branch.id]: { ...branch, headId: node.id },
      },
      focus: stage,
    },
    nodeId: node.id,
    forked: false,
    branchName: branch.name,
  };
}

/** Shallow-merges `patch` into a node (no-op when the node is gone). */
export function patchNode(
  project: StudioProject,
  nodeId: string,
  patch: Partial<Omit<StageNode, 'id' | 'stage'>>,
): StudioProject {
  const node = project.nodes[nodeId];
  if (!node) return project;
  return {
    ...project,
    nodes: {
      ...project.nodes,
      [nodeId]: { ...node, ...patch, updatedAt: now() },
    },
  };
}
