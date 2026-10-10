import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { DbClient } from '../projects.repository';
import {
  type Branch,
  type JsonObject,
  type StageNode,
  type StudioProject,
} from './studio-graph';
import { branchNameKey } from './studio-branches';

/** Rows of a project's graph; `data` is `{}` when loaded without it. */
export interface GraphRows {
  nodes: Record<string, StageNode>;
  branches: Record<string, Branch>;
  branchOrder: string[];
}

/** Lightweight Studio keys of `projects.data.studio` (no nodes/branches). */
export interface StudioHeader {
  name: string;
  revision: number;
  initialPrompt: string | null;
  focus: string | null;
}

const NODE_LIGHT = {
  id: true,
  parentId: true,
  stage: true,
  status: true,
  error: true,
  rev: true,
  source: true,
  summary: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.StudioNodeSelect;

type NodeRow = Prisma.StudioNodeGetPayload<{ select: typeof NODE_LIGHT }> & {
  data?: Prisma.JsonValue;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toNode(row: NodeRow): StageNode {
  return {
    id: row.id,
    parentId: row.parentId,
    stage: row.stage,
    status: row.status,
    error: row.error,
    rev: row.rev,
    data: isObject(row.data) ? row.data : {},
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.summary !== null ? { summary: row.summary } : {}),
  };
}

const sameData = (a: JsonObject, b: JsonObject): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

function nodeChanged(a: StageNode, b: StageNode): boolean {
  return (
    a.parentId !== b.parentId ||
    a.stage !== b.stage ||
    a.status !== b.status ||
    (a.error ?? null) !== (b.error ?? null) ||
    a.rev !== b.rev ||
    a.source !== b.source ||
    (a.summary ?? null) !== (b.summary ?? null) ||
    a.updatedAt !== b.updatedAt ||
    !sameData(a.data, b.data)
  );
}

const nodeColumns = (node: StageNode) => ({
  parentId: node.parentId,
  stage: node.stage,
  status: node.status,
  error: node.error ?? null,
  rev: node.rev,
  data: node.data as Prisma.InputJsonObject,
  source: node.source,
  summary: node.summary ?? null,
  createdAt: new Date(node.createdAt),
  updatedAt: new Date(node.updatedAt),
});

const branchColumns = (branch: Branch, position: number) => ({
  name: branch.name,
  nameKey: branchNameKey(branch.name),
  headNodeId: branch.headId,
  forkedFromNodeId: branch.forkedFromId ?? null,
  colorIndex: branch.colorIndex,
  position,
});

/**
 * Prisma access for the Studio graph tables. Graph writes go through
 * {@link writeDiff} inside the caller's transaction, after the caller has
 * row-locked the project, so concurrent writers are serialised.
 */
@Injectable()
export class StudioGraphRepository {
  constructor(private readonly prisma: PrismaService) {}

  countBranches(projectId: string, db: DbClient = this.prisma) {
    return db.studioBranch.count({ where: { projectId } });
  }

  /** Name, revision and the small Studio header keys, without the data blob. */
  async header(projectId: string): Promise<StudioHeader | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        name: string;
        revision: number;
        initialPrompt: string | null;
        focus: string | null;
      }>
    >`
      SELECT name, revision,
             data->'studio'->>'initialPrompt' AS "initialPrompt",
             data->'studio'->>'focus' AS focus
      FROM projects WHERE id = ${projectId}::uuid
    `;
    return rows[0] ?? null;
  }

  async load(
    projectId: string,
    options: { withData: boolean },
    db: DbClient = this.prisma,
  ): Promise<GraphRows> {
    const [nodeRows, branchRows] = await Promise.all([
      db.studioNode.findMany({
        where: { projectId },
        select: options.withData ? { ...NODE_LIGHT, data: true } : NODE_LIGHT,
      }),
      db.studioBranch.findMany({
        where: { projectId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const nodes: Record<string, StageNode> = {};
    for (const row of nodeRows) nodes[row.id] = toNode(row);
    const branches: Record<string, Branch> = {};
    for (const row of branchRows) {
      branches[row.id] = {
        id: row.id,
        name: row.name,
        headId: row.headNodeId,
        forkedFromId: row.forkedFromNodeId,
        createdAt: row.createdAt.toISOString(),
        colorIndex: row.colorIndex,
      };
    }
    return { nodes, branches, branchOrder: branchRows.map((b) => b.id) };
  }

  async nodeWithData(
    projectId: string,
    nodeId: string,
  ): Promise<StageNode | null> {
    const row = await this.prisma.studioNode.findUnique({
      where: { projectId_id: { projectId, id: nodeId } },
      select: { ...NODE_LIGHT, data: true },
    });
    return row ? toNode(row) : null;
  }

  async cursor(
    projectId: string,
    userId: string,
    db: DbClient = this.prisma,
  ): Promise<string | null> {
    const row = await db.studioBranchCursor.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { branchId: true },
    });
    return row?.branchId ?? null;
  }

  async setCursor(
    projectId: string,
    userId: string,
    branchId: string,
    db: DbClient = this.prisma,
  ): Promise<void> {
    await db.studioBranchCursor.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId, branchId },
      update: { branchId },
    });
  }

  branchExists(projectId: string, branchId: string): Promise<boolean> {
    return this.prisma.studioBranch
      .count({ where: { projectId, id: branchId } })
      .then((count) => count > 0);
  }

  /**
   * Writes the difference between two graphs of one project. Order keeps
   * every foreign key valid: new nodes first, then branches (removed ones
   * before new ones so names can be reused), then results nothing reaches.
   */
  async writeDiff(
    projectId: string,
    actorId: string | null,
    before: GraphRows,
    after: StudioProject,
    tx: DbClient,
  ): Promise<{ removedNodeIds: string[] }> {
    const added = Object.values(after.nodes).filter((n) => !before.nodes[n.id]);
    if (added.length) {
      await tx.studioNode.createMany({
        data: added.map((node) => ({
          id: node.id,
          projectId,
          createdById: actorId,
          ...nodeColumns(node),
        })),
      });
    }
    for (const node of Object.values(after.nodes)) {
      const old = before.nodes[node.id];
      if (!old || !nodeChanged(old, node)) continue;
      await tx.studioNode.update({
        where: { projectId_id: { projectId, id: node.id } },
        data: nodeColumns(node),
      });
    }

    const removedBranches = before.branchOrder.filter(
      (id) => !after.branches[id],
    );
    if (removedBranches.length) {
      await tx.studioBranch.deleteMany({
        where: { projectId, id: { in: removedBranches } },
      });
    }
    const renamed = after.branchOrder.filter((id) => {
      const old = before.branches[id];
      return (
        old &&
        branchNameKey(old.name) !== branchNameKey(after.branches[id].name)
      );
    });
    // Free the old names first, so two branches can swap names.
    for (const id of renamed) {
      await tx.studioBranch.update({
        where: { projectId_id: { projectId, id } },
        data: { nameKey: `~${id}`.slice(0, 100) },
      });
    }
    const newBranches = after.branchOrder.filter((id) => !before.branches[id]);
    if (newBranches.length) {
      await tx.studioBranch.createMany({
        data: newBranches.map((id) => ({
          id,
          projectId,
          createdById: actorId,
          createdAt: new Date(after.branches[id].createdAt),
          ...branchColumns(after.branches[id], after.branchOrder.indexOf(id)),
        })),
      });
    }
    const beforePosition = new Map(before.branchOrder.map((id, i) => [id, i]));
    for (const [position, id] of after.branchOrder.entries()) {
      const old = before.branches[id];
      if (!old) continue;
      const next = after.branches[id];
      const changed =
        renamed.includes(id) ||
        old.name !== next.name ||
        old.headId !== next.headId ||
        (old.forkedFromId ?? null) !== (next.forkedFromId ?? null) ||
        old.colorIndex !== next.colorIndex ||
        beforePosition.get(id) !== position;
      if (!changed) continue;
      await tx.studioBranch.update({
        where: { projectId_id: { projectId, id } },
        data: { ...branchColumns(next, position), updatedAt: new Date() },
      });
    }

    const removedNodeIds = Object.keys(before.nodes).filter(
      (id) => !after.nodes[id],
    );
    if (removedNodeIds.length) {
      await tx.studioNode.deleteMany({
        where: { projectId, id: { in: removedNodeIds } },
      });
    }
    return { removedNodeIds };
  }

  /** Copies a project's graph rows into another project (ids are per project). */
  async copy(fromProjectId: string, toProjectId: string, tx: DbClient) {
    await tx.$executeRaw`
      INSERT INTO studio_nodes (id, project_id, parent_id, stage, status, error, rev, data, source, summary, created_by_id, created_at, updated_at)
      SELECT id, ${toProjectId}::uuid, parent_id, stage, status, error, rev, data, source, summary, created_by_id, created_at, updated_at
      FROM studio_nodes WHERE project_id = ${fromProjectId}::uuid
    `;
    await tx.$executeRaw`
      INSERT INTO studio_branches (id, project_id, name, name_key, head_node_id, forked_from_node_id, color_index, position, created_by_id, created_at, updated_at)
      SELECT id, ${toProjectId}::uuid, name, name_key, head_node_id, forked_from_node_id, color_index, position, created_by_id, created_at, updated_at
      FROM studio_branches WHERE project_id = ${fromProjectId}::uuid
    `;
  }

  /** Replaces text in every node's data (file ids after a project copy). */
  async rewriteNodeData(
    projectId: string,
    replacements: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (replacements.size === 0) return;
    const rows = await this.prisma.studioNode.findMany({
      where: { projectId },
      select: { id: true, data: true },
    });
    for (const row of rows) {
      const before = JSON.stringify(row.data);
      let after = before;
      for (const [from, to] of replacements) after = after.split(from).join(to);
      if (after === before) continue;
      await this.prisma.studioNode.update({
        where: { projectId_id: { projectId, id: row.id } },
        data: { data: JSON.parse(after) as Prisma.InputJsonObject },
      });
    }
  }
}
