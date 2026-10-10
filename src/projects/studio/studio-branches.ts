import { AppError, ErrorCode } from '../../common/errors/error-codes';
import {
  ancestry,
  type Branch,
  branchPath,
  newId,
  STAGE_ORDER,
  type StageKind,
  type StageNode,
  stageNodeOnBranch,
  type StudioProject,
} from './studio-graph';
import { MAX_BRANCHES } from './studio-persistence';

/**
 * Branch operations on the Studio graph, ported from the old frontend store
 * (`lib/studio/store.ts`: createBranch, renameBranch, deleteBranch,
 * checkoutNode, branchTopology) and its history view. Pure: each returns a
 * new graph or a derived view and never mutates its input.
 */

export const BRANCH_NAME_MAX = 100;

export const branchNameKey = (name: string): string =>
  name.trim().toLowerCase();

/** `base`, or `base 2`, `base 3`… when the name is taken (case-insensitive). */
export function uniqueBranchName(project: StudioProject, base: string): string {
  const taken = new Set(
    Object.values(project.branches).map((b) => branchNameKey(b.name)),
  );
  const root = base.trim().slice(0, BRANCH_NAME_MAX - 4) || 'branch';
  if (!taken.has(branchNameKey(root))) return root;
  let i = 2;
  while (taken.has(branchNameKey(`${root} ${i}`))) i += 1;
  return `${root} ${i}`;
}

export function requireBranch(
  project: StudioProject,
  branchId: string,
): Branch {
  const branch = project.branches[branchId];
  if (!branch) {
    throw AppError.notFound(ErrorCode.BranchNotFound, 'Branch not found');
  }
  return branch;
}

export interface CreateBranchInput {
  name?: string;
  /** Branch to start from (its head); defaults to the active branch. */
  fromBranchId?: string;
  /** Start at this node instead of the branch head (null: project root). */
  atNodeId?: string | null;
  /** Start just before this stage on the source branch. */
  forkBeforeStage?: StageKind;
}

/**
 * New branch starting at a point of an existing one and made active (old
 * `createBranch`): the source head, a given node, or just before a stage.
 * Names are made unique by adding a number, as before.
 */
export function createBranch(
  project: StudioProject,
  input: CreateBranchInput,
): { project: StudioProject; branch: Branch } {
  if (project.branchOrder.length >= MAX_BRANCHES) {
    throw AppError.conflict(
      ErrorCode.StudioLimitReached,
      `A project can have at most ${MAX_BRANCHES} branches; delete one first`,
    );
  }
  const source = requireBranch(
    project,
    input.fromBranchId ?? project.activeBranchId,
  );
  let base: string | null = source.headId;
  if (input.atNodeId !== undefined) {
    if (input.atNodeId !== null && !project.nodes[input.atNodeId]) {
      throw AppError.notFound(ErrorCode.NodeNotFound, 'Result not found');
    }
    base = input.atNodeId;
  } else if (input.forkBeforeStage) {
    const path = branchPath(project, source.id);
    const index = path.findIndex((n) => n.stage === input.forkBeforeStage);
    if (index >= 0) base = index === 0 ? null : path[index - 1].id;
  }
  const branch: Branch = {
    id: newId('br'),
    name: uniqueBranchName(project, input.name ?? 'branch'),
    headId: base,
    forkedFromId: base,
    createdAt: new Date().toISOString(),
    colorIndex: project.branchOrder.length,
  };
  return {
    branch,
    project: {
      ...project,
      branches: { ...project.branches, [branch.id]: branch },
      branchOrder: [...project.branchOrder, branch.id],
      activeBranchId: branch.id,
    },
  };
}

/** Renames a branch; another branch already using the name is a 409. */
export function renameBranch(
  project: StudioProject,
  branchId: string,
  name: string,
): { project: StudioProject; branch: Branch } {
  const branch = requireBranch(project, branchId);
  const trimmed = name.trim();
  const key = branchNameKey(trimmed);
  const clash = Object.values(project.branches).some(
    (b) => b.id !== branchId && branchNameKey(b.name) === key,
  );
  if (clash) {
    throw AppError.conflict(
      ErrorCode.BranchNameTaken,
      `A branch named "${trimmed}" already exists`,
    );
  }
  const renamed = { ...branch, name: trimmed };
  return {
    branch: renamed,
    project: {
      ...project,
      branches: { ...project.branches, [branchId]: renamed },
    },
  };
}

/** Nodes some branch still reaches (from its head to the root). */
export function reachableNodeIds(
  project: StudioProject,
  branchIds: readonly string[] = project.branchOrder,
): Set<string> {
  const reachable = new Set<string>();
  for (const id of branchIds) {
    const branch = project.branches[id];
    if (!branch) continue;
    for (const node of ancestry(project, branch.headId)) reachable.add(node.id);
  }
  return reachable;
}

/**
 * Deletes a branch and every result only it could reach (old `deleteBranch`).
 * The last branch cannot be deleted. Whoever was on it moves to the first
 * remaining branch.
 */
export function deleteBranch(
  project: StudioProject,
  branchId: string,
): { project: StudioProject; removedNodeIds: string[] } {
  requireBranch(project, branchId);
  if (project.branchOrder.length <= 1) {
    throw AppError.conflict(
      ErrorCode.LastBranch,
      'A project needs at least one branch',
    );
  }
  const branches = { ...project.branches };
  delete branches[branchId];
  const branchOrder = project.branchOrder.filter((id) => id !== branchId);
  const kept = reachableNodeIds({ ...project, branches }, branchOrder);
  const nodes: Record<string, StageNode> = {};
  const removedNodeIds: string[] = [];
  for (const [id, node] of Object.entries(project.nodes)) {
    if (kept.has(id)) nodes[id] = node;
    else removedNodeIds.push(id);
  }
  return {
    removedNodeIds,
    project: {
      ...project,
      nodes,
      branches,
      branchOrder,
      activeBranchId:
        project.activeBranchId === branchId
          ? branchOrder[0]
          : project.activeBranchId,
    },
  };
}

/**
 * Branch to open for a history node (old `checkoutNode`): one whose head is
 * the node, else the first branch whose history contains it.
 */
export function checkoutTarget(
  project: StudioProject,
  nodeId: string,
): { branchId: string; stage: StageKind } {
  const node = project.nodes[nodeId];
  if (!node)
    throw AppError.notFound(ErrorCode.NodeNotFound, 'Result not found');
  const atHead = project.branchOrder.find(
    (id) => project.branches[id]?.headId === nodeId,
  );
  const containing =
    atHead ??
    project.branchOrder.find((id) =>
      ancestry(project, project.branches[id]?.headId ?? null).some(
        (n) => n.id === nodeId,
      ),
    );
  if (!containing) {
    throw AppError.notFound(ErrorCode.NodeNotFound, 'Result not found');
  }
  return { branchId: containing, stage: node.stage };
}

export interface BranchTopology {
  branchId: string;
  /** Results first introduced by this branch, oldest first. */
  ownNodes: StageNode[];
  /** Result the branch grew out of; null at the project root. */
  forkNodeId: string | null;
  /** Branch that owns the fork result (null for the first branch). */
  parentBranchId: string | null;
  /** History lane; branches without own results share their parent's. */
  lane: number;
}

/**
 * Git-style ownership (old `branchTopology`): walking branches in order, each
 * result belongs to the first branch reaching it, so a branch's fork point is
 * the parent of its first own result and the branches form a tree.
 */
export function branchTopology(
  project: StudioProject,
): Record<string, BranchTopology> {
  const ownerOf: Record<string, string> = {};
  const out: Record<string, BranchTopology> = {};
  let lanes = 0;
  const first = project.branchOrder[0];
  for (const id of project.branchOrder) {
    const branch = project.branches[id];
    if (!branch) continue;
    const ownNodes = ancestry(project, branch.headId).filter(
      (n) => ownerOf[n.id] === undefined,
    );
    for (const n of ownNodes) ownerOf[n.id] = id;
    const forkNodeId = ownNodes.length ? ownNodes[0].parentId : branch.headId;
    const parent = forkNodeId
      ? (ownerOf[forkNodeId] ?? null)
      : id === first
        ? null
        : first;
    const lane =
      ownNodes.length || !parent ? lanes++ : (out[parent]?.lane ?? 0);
    out[id] = {
      branchId: id,
      ownNodes,
      forkNodeId,
      parentBranchId: parent === id ? null : parent,
      lane,
    };
  }
  return out;
}

export interface BranchView {
  id: string;
  name: string;
  headId: string | null;
  colorIndex: number;
  parentBranchId: string | null;
  depth: number;
  forkStage: StageKind | null;
  ownStages: StageKind[];
  createdAt: string;
}

/** Branches in order with their tree position (what the branch menu shows). */
export function branchViews(project: StudioProject): BranchView[] {
  const topology = branchTopology(project);
  const depthOf = (id: string): number => {
    let depth = 0;
    const seen = new Set<string>([id]);
    let parent = topology[id]?.parentBranchId ?? null;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = topology[parent]?.parentBranchId ?? null;
    }
    return depth;
  };
  return project.branchOrder
    .filter((id) => project.branches[id])
    .map((id) => {
      const branch = project.branches[id];
      const t = topology[id];
      const forkNode = t?.forkNodeId ? project.nodes[t.forkNodeId] : undefined;
      return {
        id,
        name: branch.name,
        headId: branch.headId,
        colorIndex: branch.colorIndex,
        parentBranchId: t?.parentBranchId ?? null,
        depth: depthOf(id),
        forkStage: t?.parentBranchId && forkNode ? forkNode.stage : null,
        ownStages: (t?.ownNodes ?? []).map((n) => n.stage),
        createdAt: branch.createdAt,
      };
    });
}

export type StageState = 'empty' | 'running' | 'ready' | 'error';

export interface StageView {
  status: StageState;
  nodeId: string | null;
  updatedAt: string | null;
  error: string | null;
}

/**
 * State of every stage on a branch (old StageRail). Devices also count as
 * ready when the branch's simulation selected them (`hasSimDevices`).
 */
export function stageViews(
  project: StudioProject,
  branchId: string,
  hasSimDevices: boolean,
): Record<StageKind, StageView> {
  const out = {} as Record<StageKind, StageView>;
  for (const stage of STAGE_ORDER) {
    const node = stageNodeOnBranch(project, stage, branchId);
    out[stage] = node
      ? {
          status: node.status,
          nodeId: node.id,
          updatedAt: node.updatedAt,
          error: node.error ?? null,
        }
      : {
          status: stage === 'devices' && hasSimDevices ? 'ready' : 'empty',
          nodeId: null,
          updatedAt: null,
          error: null,
        };
  }
  return out;
}

export interface HistoryNodeView {
  id: string;
  parentId: string | null;
  stage: StageKind;
  status: StageNode['status'];
  summary: string;
  updatedAt: string;
  lane: number;
  row: number;
  colorIndex: number;
  onActivePath: boolean;
}

export interface HistoryView {
  nodes: HistoryNodeView[];
  heads: Array<{
    nodeId: string;
    branchId: string;
    name: string;
    colorIndex: number;
    active: boolean;
  }>;
  laneCount: number;
  initialPrompt: string | null;
}

const ROOT = 'root';

/**
 * `git log --graph` layout of the whole project (old HistoryGraph): one row
 * per result in creation order, one lane per branch, coloured by the branch
 * owning each result.
 */
export function historyView(
  project: StudioProject,
  activeBranchId: string,
): HistoryView {
  const topology = branchTopology(project);
  const laneOf: Record<string, number> = {};
  const colorOf: Record<string, number> = {};
  let laneCount = 1;
  for (const id of project.branchOrder) {
    const t = topology[id];
    if (!t) continue;
    laneCount = Math.max(laneCount, t.lane + 1);
    for (const n of t.ownNodes) {
      laneOf[n.id] = t.lane;
      colorOf[n.id] = project.branches[id].colorIndex;
    }
  }
  const onPath = new Set(branchPath(project, activeBranchId).map((n) => n.id));
  const nodes = Object.values(project.nodes)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    .map((n, row) => ({
      id: n.id,
      parentId: n.parentId,
      stage: n.stage,
      status: n.status,
      summary: n.summary ?? n.stage,
      updatedAt: n.updatedAt,
      lane: laneOf[n.id] ?? 0,
      row,
      colorIndex: colorOf[n.id] ?? 0,
      onActivePath: onPath.has(n.id),
    }));
  const heads = project.branchOrder
    .filter((id) => project.branches[id])
    .map((id) => {
      const b = project.branches[id];
      return {
        nodeId: b.headId ?? ROOT,
        branchId: id,
        name: b.name,
        colorIndex: b.colorIndex,
        active: id === activeBranchId,
      };
    });
  return {
    nodes,
    heads,
    laneCount,
    initialPrompt: project.initialPrompt ?? null,
  };
}
