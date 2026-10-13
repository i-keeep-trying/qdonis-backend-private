import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import {
  SimulationRunKind,
  SimulationRunStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** A run claimed by this worker. `attempts` includes this claim. */
export interface ClaimedRun {
  id: string;
  projectId: string;
  nodeId: string;
  kind: SimulationRunKind;
  input: unknown;
  attempts: number;
}

@Injectable()
export class SimulationRunsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    id: string;
    projectId: string;
    nodeId: string;
    kind: SimulationRunKind;
    input: Prisma.InputJsonObject;
    createdById: string;
  }) {
    return this.prisma.simulationRun.create({ data });
  }

  /**
   * Claims queued runs, and running ones whose lease expired (their worker
   * died). `SKIP LOCKED` keeps instances from claiming the same run.
   */
  claim(limit: number, leaseMs: number): Promise<ClaimedRun[]> {
    const leaseUntil = new Date(Date.now() + leaseMs);
    return this.prisma.$queryRaw<ClaimedRun[]>`
      UPDATE simulation_runs
      SET status = 'running',
          attempts = attempts + 1,
          lease_until = ${leaseUntil},
          started_at = COALESCE(started_at, NOW())
      WHERE id IN (
        SELECT id FROM simulation_runs
        WHERE status = 'queued'
           OR (status = 'running' AND lease_until < NOW())
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, project_id AS "projectId", node_id AS "nodeId", kind, input, attempts
    `;
  }

  /** Extends a running claim; false when the run is no longer ours to finish. */
  async renew(id: string, leaseMs: number): Promise<boolean> {
    const { count } = await this.prisma.simulationRun.updateMany({
      where: { id, status: SimulationRunStatus.running },
      data: { leaseUntil: new Date(Date.now() + leaseMs) },
    });
    return count === 1;
  }

  async finish(id: string, error: string | null): Promise<void> {
    await this.prisma.simulationRun.update({
      where: { id },
      data: {
        status: error
          ? SimulationRunStatus.failed
          : SimulationRunStatus.succeeded,
        error: error ? error.slice(0, 2_000) : null,
        leaseUntil: null,
        finishedAt: new Date(),
      },
    });
  }
}
