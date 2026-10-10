import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { AppConfiguration } from '../config/configuration';
import type { StoredFile } from '../generated/prisma/client';
import { StoredFileKind, StoredFileStatus } from '../generated/prisma/enums';
import {
  attachmentDisposition,
  parseDocument,
  sanitizeFilename,
} from './document-text';
import {
  ObjectNotFoundError,
  ObjectStore,
  type UploadUrl,
} from './object-store';
import {
  BLOB_NAME_PATTERN,
  KIND_LIMITS,
  MAX_DOCUMENT_BYTES,
  STAGE_BLOB_CONTENT_TYPES,
} from './storage.constants';
import { StoredFilesRepository } from './stored-files.repository';

export interface UploadedBinary {
  originalname: string;
  buffer: Buffer;
  size: number;
}

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Stored objects: S3 bytes + a `stored_files` row. Callers (controllers in
 * the storage and projects modules) authorise access first; this service only
 * enforces limits, formats and consistency between S3 and the database.
 */
@Injectable()
export class StoredFilesService {
  private readonly logger = new Logger(StoredFilesService.name);

  constructor(
    private readonly repository: StoredFilesRepository,
    private readonly store: ObjectStore,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  private settings(): AppConfiguration['storage'] {
    return this.config.get('storage', { infer: true });
  }

  assertEnabled(): void {
    if (!this.settings().enabled) {
      throw AppError.unavailable(
        ErrorCode.StorageNotConfigured,
        'File storage is not configured on this server',
      );
    }
  }

  private key(...parts: string[]): string {
    return `${this.settings().keyPrefix}${parts.join('/')}`;
  }

  // --- documents -------------------------------------------------------------

  /**
   * Validates and parses a specification document, stores the original in S3
   * and its extracted text in the database.
   */
  async uploadDocument(input: {
    ownerId: string;
    projectId?: string | null;
    file: UploadedBinary;
  }): Promise<StoredFile> {
    this.assertEnabled();
    const { file } = input;
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw AppError.tooLarge(
        ErrorCode.FileTooLarge,
        `File size exceeds the maximum of ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`,
      );
    }
    const filename = sanitizeFilename(file.originalname);
    const parsed = await parseDocument(filename, file.buffer);

    const id = randomUUID();
    const key = input.projectId
      ? this.key('projects', input.projectId, 'documents', id)
      : this.key('users', input.ownerId, 'documents', id);

    await this.store.put({
      key,
      body: file.buffer,
      contentType: parsed.contentType,
      contentDisposition: attachmentDisposition(filename),
    });
    try {
      return await this.repository.create({
        id,
        ownerId: input.ownerId,
        projectId: input.projectId ?? null,
        kind: StoredFileKind.DOCUMENT,
        status: StoredFileStatus.READY,
        name: filename,
        key,
        filename,
        contentType: parsed.contentType,
        sizeBytes: file.size,
        sha256: sha256(file.buffer),
        extractedText: parsed.text,
      });
    } catch (error) {
      await this.repository
        .enqueueDeletion([key])
        .catch((e: unknown) =>
          this.logger.error(`Could not queue orphan ${key}: ${describe(e)}`),
        );
      throw error;
    }
  }

  async pageDocuments(ownerId: string, skip: number, take: number) {
    return this.repository.pageOwnerDocuments(ownerId, skip, take);
  }

  findById(id: string): Promise<StoredFile | null> {
    return this.repository.findById(id);
  }

  /** Raw bytes, e.g. a PDF to hand to the model. */
  async read(file: StoredFile): Promise<Buffer> {
    this.assertEnabled();
    if (file.status !== StoredFileStatus.READY) {
      throw AppError.conflict(
        ErrorCode.UploadIncomplete,
        'This file has not finished uploading',
      );
    }
    try {
      return await this.store.get(file.key);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        this.logger.error(`Object for file ${file.id} is missing from storage`);
        throw AppError.notFound(
          ErrorCode.FileNotFound,
          'File content is missing',
        );
      }
      throw error;
    }
  }

  async downloadUrl(
    file: StoredFile,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.assertEnabled();
    if (file.status !== StoredFileStatus.READY) {
      throw AppError.conflict(
        ErrorCode.UploadIncomplete,
        'This file has not finished uploading',
      );
    }
    return this.store.downloadUrl({
      key: file.key,
      expiresInSeconds: this.settings().urlTtlSeconds,
    });
  }

  /** Deletes the row; the trigger queues the S3 object for deletion. */
  async remove(file: StoredFile): Promise<void> {
    await this.repository.delete(file.id);
  }

  // --- stage blobs -------------------------------------------------------------

  /**
   * Step 1 of a large upload: a PENDING row and a presigned PUT URL. The
   * current READY blob of the same name keeps being served until
   * {@link completeStageBlob} swaps them.
   */
  async createStageBlobUpload(input: {
    projectId: string;
    actorId: string;
    name: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<{ file: StoredFile; upload: UploadUrl }> {
    this.assertEnabled();
    this.assertBlob(input.name, input.contentType, input.sizeBytes);
    const id = randomUUID();
    const key = this.key('projects', input.projectId, 'blobs', id);
    const file = await this.repository.create({
      id,
      ownerId: input.actorId,
      projectId: input.projectId,
      kind: StoredFileKind.STAGE_BLOB,
      status: StoredFileStatus.PENDING,
      name: input.name,
      key,
      filename: `${input.name.replace(/\//g, '_')}.json`,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    });
    const upload = await this.store.uploadUrl({
      key,
      contentType: input.contentType,
      expiresInSeconds: this.settings().urlTtlSeconds,
    });
    return { file, upload };
  }

  /**
   * Step 2: verifies the object really landed (size within limits, declared
   * content type), then promotes it. A bad upload is discarded.
   */
  async completeStageBlob(file: StoredFile): Promise<StoredFile> {
    this.assertEnabled();
    if (file.kind !== StoredFileKind.STAGE_BLOB || !file.projectId) {
      throw AppError.notFound(ErrorCode.FileNotFound, 'Upload not found');
    }
    if (file.status === StoredFileStatus.READY) return file;

    const head = await this.store.head(file.key);
    if (!head) {
      throw AppError.conflict(
        ErrorCode.UploadIncomplete,
        'The file has not been uploaded yet',
      );
    }
    const contentType = (head.contentType ?? '').split(';')[0].trim();
    if (
      head.sizeBytes === 0 ||
      head.sizeBytes > KIND_LIMITS[StoredFileKind.STAGE_BLOB] ||
      contentType !== file.contentType
    ) {
      await this.repository.delete(file.id);
      throw AppError.badRequest(
        ErrorCode.UploadIncomplete,
        'The uploaded object does not match the declared size or content type',
      );
    }
    const projectId = file.projectId;
    return this.repository.transaction((tx) =>
      this.repository.promoteBlob(
        file.id,
        projectId,
        file.name,
        { sizeBytes: head.sizeBytes, contentType },
        tx,
      ),
    );
  }

  /** Server-side write of a stage blob (JSON), replacing any previous one. */
  async putStageBlob(input: {
    projectId: string;
    actorId: string | null;
    name: string;
    value: unknown;
  }): Promise<StoredFile> {
    this.assertEnabled();
    const body = Buffer.from(JSON.stringify(input.value ?? null), 'utf8');
    this.assertBlob(input.name, 'application/json', body.length);
    const id = randomUUID();
    const key = this.key('projects', input.projectId, 'blobs', id);
    await this.store.put({ key, body, contentType: 'application/json' });
    try {
      return await this.repository.transaction(async (tx) => {
        await this.repository.create(
          {
            id,
            ownerId: input.actorId,
            projectId: input.projectId,
            kind: StoredFileKind.STAGE_BLOB,
            status: StoredFileStatus.PENDING,
            name: input.name,
            key,
            filename: `${input.name.replace(/\//g, '_')}.json`,
            contentType: 'application/json',
            sizeBytes: body.length,
            sha256: sha256(body),
          },
          tx,
        );
        return this.repository.promoteBlob(
          id,
          input.projectId,
          input.name,
          { sizeBytes: body.length, contentType: 'application/json' },
          tx,
        );
      });
    } catch (error) {
      await this.repository.enqueueDeletion([key]).catch(() => undefined);
      throw error;
    }
  }

  findStageBlob(projectId: string, name: string): Promise<StoredFile | null> {
    return this.repository.findReadyBlob(projectId, name);
  }

  listProjectFiles(projectId: string, kind?: StoredFileKind) {
    return this.repository.listProjectFiles(projectId, kind);
  }

  // --- exports -----------------------------------------------------------------

  /** Stores a generated export (BOM spreadsheet, report PDF). */
  async putExport(input: {
    projectId: string;
    actorId: string;
    filename: string;
    contentType: string;
    body: Buffer;
  }): Promise<StoredFile> {
    this.assertEnabled();
    if (input.body.length > KIND_LIMITS[StoredFileKind.EXPORT]) {
      throw AppError.tooLarge(
        ErrorCode.FileTooLarge,
        'The export is too large',
      );
    }
    const filename = sanitizeFilename(input.filename);
    const id = randomUUID();
    const key = this.key('projects', input.projectId, 'exports', id);
    await this.store.put({
      key,
      body: input.body,
      contentType: input.contentType,
      contentDisposition: attachmentDisposition(filename),
    });
    try {
      return await this.repository.create({
        id,
        ownerId: input.actorId,
        projectId: input.projectId,
        kind: StoredFileKind.EXPORT,
        status: StoredFileStatus.READY,
        name: filename,
        key,
        filename,
        contentType: input.contentType,
        sizeBytes: input.body.length,
        sha256: sha256(input.body),
      });
    } catch (error) {
      await this.repository.enqueueDeletion([key]).catch(() => undefined);
      throw error;
    }
  }

  // --- duplication ---------------------------------------------------------------

  /**
   * Copies every READY object of `sourceProjectId` to `targetProjectId`
   * (S3 server-side copy, outside any transaction: copies can be slow). On
   * failure the error is rethrown; the caller deletes the target project,
   * which cascades to the copied rows and queues their objects for deletion.
   */
  async copyProjectFiles(
    sourceProjectId: string,
    targetProjectId: string,
    actorId: string,
  ): Promise<Map<string, string>> {
    /** source file id -> copy's file id */
    const copied = new Map<string, string>();
    const files = await this.repository.listReadyProjectFiles(sourceProjectId);
    if (files.length === 0) return copied;
    this.assertEnabled();
    // Copied object whose row is not written yet (only it could be orphaned).
    let unrecorded: string | null = null;
    try {
      for (const file of files) {
        const id = randomUUID();
        const folder =
          file.kind === StoredFileKind.STAGE_BLOB
            ? 'blobs'
            : file.kind === StoredFileKind.EXPORT
              ? 'exports'
              : 'documents';
        const key = this.key('projects', targetProjectId, folder, id);
        await this.store.copy(file.key, key);
        unrecorded = key;
        await this.repository.create({
          id,
          ownerId: actorId,
          projectId: targetProjectId,
          kind: file.kind,
          status: StoredFileStatus.READY,
          name: file.name,
          key,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          extractedText: file.extractedText,
        });
        unrecorded = null;
        copied.set(file.id, id);
      }
      return copied;
    } catch (error) {
      if (unrecorded) {
        await this.repository
          .enqueueDeletion([unrecorded])
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private assertBlob(
    name: string,
    contentType: string,
    sizeBytes: number,
  ): void {
    if (!BLOB_NAME_PATTERN.test(name) || name.length > 200) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Blob name must be path-like, e.g. studio/<nodeId>',
      );
    }
    if (
      !(STAGE_BLOB_CONTENT_TYPES as readonly string[]).includes(contentType)
    ) {
      throw AppError.badRequest(
        ErrorCode.UnsupportedFileType,
        `Content type must be one of ${STAGE_BLOB_CONTENT_TYPES.join(', ')}`,
      );
    }
    if (sizeBytes <= 0 || sizeBytes > KIND_LIMITS[StoredFileKind.STAGE_BLOB]) {
      throw AppError.tooLarge(
        ErrorCode.FileTooLarge,
        `Blob size must be between 1 byte and ${KIND_LIMITS[StoredFileKind.STAGE_BLOB] / 1024 / 1024} MB`,
      );
    }
  }
}
