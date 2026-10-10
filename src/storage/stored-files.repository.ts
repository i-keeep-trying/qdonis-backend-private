import { Injectable } from '@nestjs/common';

import type { Prisma, StoredFile } from '../generated/prisma/client';
import { StoredFileKind, StoredFileStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export type DbClient = Prisma.TransactionClient;

export interface QueuedDeletion {
  id: string;
  key: string;
  attempts: number;
}

@Injectable()
export class StoredFilesRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { maxWait: 10_000, timeout: 20_000 });
  }

  create(
    data: Prisma.StoredFileUncheckedCreateInput,
    db: DbClient = this.prisma,
  ): Promise<StoredFile> {
    return db.storedFile.create({ data });
  }

  findById(id: string, db: DbClient = this.prisma): Promise<StoredFile | null> {
    return db.storedFile.findUnique({ where: { id } });
  }

  findReadyBlob(projectId: string, name: string): Promise<StoredFile | null> {
    return this.prisma.storedFile.findFirst({
      where: {
        projectId,
        name,
        kind: StoredFileKind.STAGE_BLOB,
        status: StoredFileStatus.READY,
      },
    });
  }

  /**
   * Makes `fileId` the READY blob for its name, replacing (and so queueing for
   * deletion) the previous one. Locks the existing row to serialise racing
   * completions of the same name.
   */
  async promoteBlob(
    fileId: string,
    projectId: string,
    name: string,
    update: { sizeBytes: number; contentType: string },
    tx: DbClient,
  ): Promise<StoredFile> {
    await tx.$queryRaw`
      SELECT id FROM stored_files
      WHERE project_id = ${projectId}::uuid AND name = ${name}
        AND kind = 'STAGE_BLOB' AND status = 'READY'
      FOR UPDATE
    `;
    await tx.storedFile.deleteMany({
      where: {
        projectId,
        name,
        kind: StoredFileKind.STAGE_BLOB,
        status: StoredFileStatus.READY,
        id: { not: fileId },
      },
    });
    return tx.storedFile.update({
      where: { id: fileId },
      data: { status: StoredFileStatus.READY, ...update },
    });
  }

  markReady(
    id: string,
    update: { sizeBytes: number; contentType: string },
    db: DbClient = this.prisma,
  ): Promise<StoredFile> {
    return db.storedFile.update({
      where: { id },
      data: { status: StoredFileStatus.READY, ...update },
    });
  }

  listProjectFiles(
    projectId: string,
    kind?: StoredFileKind,
  ): Promise<StoredFile[]> {
    return this.prisma.storedFile.findMany({
      where: {
        projectId,
        status: StoredFileStatus.READY,
        ...(kind ? { kind } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  listReadyProjectFiles(projectId: string): Promise<StoredFile[]> {
    return this.prisma.storedFile.findMany({
      where: { projectId, status: StoredFileStatus.READY },
    });
  }

  async pageOwnerDocuments(
    ownerId: string,
    skip: number,
    take: number,
  ): Promise<{ items: StoredFile[]; total: number }> {
    const where = {
      ownerId,
      kind: StoredFileKind.DOCUMENT,
      status: StoredFileStatus.READY,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.storedFile.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.storedFile.count({ where }),
    ]);
    return { items, total };
  }

  async delete(id: string, db: DbClient = this.prisma): Promise<void> {
    await db.storedFile.deleteMany({ where: { id } });
  }

  async deleteStalePending(before: Date): Promise<number> {
    const { count } = await this.prisma.storedFile.deleteMany({
      where: { status: StoredFileStatus.PENDING, createdAt: { lt: before } },
    });
    return count;
  }

  /** Queues keys that were never recorded in `stored_files` (failed writes). */
  async enqueueDeletion(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.prisma.storageDeletion.createMany({
      data: keys.map((key) => ({ key })),
    });
  }

  /**
   * Claims due deletions. `SKIP LOCKED` lets several instances drain the
   * queue concurrently without double work; the claim pushes `not_before`
   * forward so a crashed worker's batch is retried later.
   */
  claimDeletions(limit: number, leaseMs: number): Promise<QueuedDeletion[]> {
    const leaseUntil = new Date(Date.now() + leaseMs);
    return this.prisma.$queryRaw<QueuedDeletion[]>`
      UPDATE storage_deletions SET not_before = ${leaseUntil}
      WHERE id IN (
        SELECT id FROM storage_deletions
        WHERE not_before <= NOW()
        ORDER BY not_before
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, key, attempts
    `;
  }

  async completeDeletions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.storageDeletion.deleteMany({
      where: { id: { in: ids } },
    });
  }

  async failDeletion(
    id: string,
    attempts: number,
    error: string,
    retryAt: Date,
  ): Promise<void> {
    await this.prisma.storageDeletion.update({
      where: { id },
      data: { attempts, lastError: error.slice(0, 1_000), notBefore: retryAt },
    });
  }
}
