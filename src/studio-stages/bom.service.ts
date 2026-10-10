import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import {
  bomCsv,
  bomFilename,
  type BomRow,
  bomRows,
  type BomSourcePart,
  bomSummary,
  bomXlsx,
} from '../engines/bom/bom';
import { ProjectActivityType } from '../generated/prisma/enums';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { ProjectsService } from '../projects/projects.service';
import { StoredFileEntity } from '../storage/entities/stored-file.entity';
import { StoredFilesService } from '../storage/stored-files.service';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

const MAX_QUANTITY = 1_000_000;

const partsOf = (
  data: Record<string, unknown>,
): Array<BomSourcePart & { id?: string }> =>
  Array.isArray(data.selectedParts)
    ? (data.selectedParts as unknown[]).filter(
        (p): p is BomSourcePart & { id?: string } =>
          typeof p === 'object' && p !== null,
      )
    : [];

/** Bill of materials of a project's selected parts, and its exports. */
@Injectable()
export class BomService {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly repository: ProjectsRepository,
    private readonly files: StoredFilesService,
  ) {}

  async get(
    user: Actor,
    projectId: string,
  ): Promise<{ rows: BomRow[]; summary: ReturnType<typeof bomSummary> }> {
    await this.access.require(user, projectId);
    const rows = bomRows(partsOf(await this.dataOf(projectId)));
    return { rows, summary: bomSummary(rows) };
  }

  async setQuantity(
    user: Actor,
    projectId: string,
    partId: string,
    quantity: number,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        `quantity must be 1-${MAX_QUANTITY}`,
      );
    }
    let rows: BomRow[] = [];
    const meta = await this.projects.mutateData(projectId, (current) => {
      const parts = partsOf(current);
      if (!parts.some((p) => p.id === partId)) {
        throw AppError.notFound(
          ErrorCode.FileNotFound,
          'Part not found in the selected parts',
        );
      }
      const selectedParts = parts.map((p) =>
        p.id === partId ? { ...p, quantity } : p,
      );
      rows = bomRows(selectedParts);
      return { ...current, selectedParts, bomData: rows };
    });
    return { rows, summary: bomSummary(rows), revision: meta.revision };
  }

  async export(user: Actor, projectId: string, format: 'xlsx' | 'csv') {
    const access = await this.access.require(user, projectId, 'canExport');
    const rows = bomRows(partsOf(await this.dataOf(projectId)));
    if (rows.length === 0) {
      throw AppError.badRequest(
        ErrorCode.StageInputMissing,
        'No selected parts to export',
      );
    }
    const now = new Date();
    const body =
      format === 'xlsx'
        ? await bomXlsx(rows, access.projectName, now)
        : bomCsv(rows);
    const file = await this.files.putExport({
      projectId,
      actorId: user.id,
      filename: bomFilename(access.projectName, format, now),
      contentType:
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8',
      body,
    });
    await this.repository.logActivity({
      projectId,
      userId: user.id,
      type: ProjectActivityType.EXPORT,
      details: { kind: 'bom', format, file_id: file.id },
    });
    const { url, expiresAt } = await this.files.downloadUrl(file);
    return { file: new StoredFileEntity(file), url, expiresAt };
  }

  private async dataOf(projectId: string): Promise<Record<string, unknown>> {
    const project = await this.repository.findWithData(projectId);
    if (!project)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    return typeof project.data === 'object' &&
      project.data !== null &&
      !Array.isArray(project.data)
      ? project.data
      : {};
  }
}
