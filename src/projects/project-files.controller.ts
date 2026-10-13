/// <reference types="multer" />
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { StoredFile } from '../generated/prisma/client';
import { StoredFileKind } from '../generated/prisma/enums';
import {
  DocumentEntity,
  SignedUrlEntity,
  StoredFileEntity,
  UploadTicketEntity,
} from '../storage/entities/stored-file.entity';
import { documentUpload, requireFile } from '../storage/files.controller';
import { StoredFilesService } from '../storage/stored-files.service';
import { BlobNameQueryDto, CreateBlobUploadDto } from './dto/project.dto';
import { ProjectAccessService } from './project-access.service';
import type { Permission } from './project-permissions';

/**
 * Files belonging to a project: specification documents, heavy stage blobs
 * (simulation plots, waveforms) and generated exports. Bytes live in S3;
 * downloads are short-lived CloudFront signed URLs.
 */
@ApiTags('project files')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class ProjectFilesController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly files: StoredFilesService,
  ) {}

  @Get('files')
  @ApiQuery({ name: 'kind', enum: StoredFileKind, required: false })
  @ApiOkResponse({ type: StoredFileEntity, isArray: true })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('kind') kind?: string,
  ): Promise<StoredFileEntity[]> {
    if (
      kind !== undefined &&
      !(Object.values(StoredFileKind) as string[]).includes(kind)
    ) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Unknown file kind',
      );
    }
    await this.access.require(user, projectId);
    const files = await this.files.listProjectFiles(
      projectId,
      kind as StoredFileKind | undefined,
    );
    return files.map((f) => new StoredFileEntity(f));
  }

  @Post('files/documents')
  @UseInterceptors(documentUpload())
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Attach a specification document to the project' })
  @ApiCreatedResponse({ type: DocumentEntity })
  async uploadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<DocumentEntity> {
    const uploaded = requireFile(file);
    await this.access.require(user, projectId, 'canEdit');
    const stored = await this.files.uploadDocument({
      ownerId: user.id,
      projectId,
      file: uploaded,
    });
    return new DocumentEntity(stored);
  }

  @Get('files/:fileId')
  @ApiOkResponse({ type: DocumentEntity })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<DocumentEntity> {
    return new DocumentEntity(await this.projectFile(user, projectId, fileId));
  }

  @Get('files/:fileId/download')
  @ApiOkResponse({ type: SignedUrlEntity })
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<SignedUrlEntity> {
    const file = await this.projectFile(user, projectId, fileId);
    if (file.kind === StoredFileKind.EXPORT) {
      await this.access.require(user, projectId, 'canExport');
    }
    const { url, expiresAt } = await this.files.downloadUrl(file);
    return new SignedUrlEntity(url, expiresAt);
  }

  @Delete('files/:fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<void> {
    const file = await this.projectFile(user, projectId, fileId, 'canEdit');
    await this.files.remove(file);
  }

  // --- stage blobs (presigned direct-to-S3 upload) -----------------------------

  @Post('blobs/uploads')
  @ApiOperation({
    summary:
      'Start a large upload: returns a presigned PUT URL (then call complete)',
  })
  @ApiCreatedResponse({ type: UploadTicketEntity })
  async createUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateBlobUploadDto,
  ): Promise<UploadTicketEntity> {
    await this.access.require(user, projectId, 'canEdit');
    const { file, upload } = await this.files.createStageBlobUpload({
      projectId,
      actorId: user.id,
      name: dto.name,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
    });
    return new UploadTicketEntity({
      file,
      url: upload.url,
      headers: upload.headers,
      expiresAt: upload.expiresAt,
    });
  }

  @Post('blobs/uploads/:fileId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify the uploaded object and make it current' })
  @ApiOkResponse({ type: StoredFileEntity })
  async completeUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<StoredFileEntity> {
    await this.access.require(user, projectId, 'canEdit');
    const file = await this.files.findById(fileId);
    if (
      !file ||
      file.projectId !== projectId ||
      file.kind !== StoredFileKind.STAGE_BLOB
    ) {
      throw AppError.notFound(ErrorCode.FileNotFound, 'Upload not found');
    }
    return new StoredFileEntity(await this.files.completeStageBlob(file));
  }

  @Get('blobs/download')
  @ApiOperation({ summary: 'Signed URL of the current blob with this name' })
  @ApiOkResponse({ type: SignedUrlEntity })
  async downloadBlob(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: BlobNameQueryDto,
  ): Promise<SignedUrlEntity> {
    await this.access.require(user, projectId);
    const file = await this.files.findStageBlob(projectId, query.name);
    if (!file)
      throw AppError.notFound(ErrorCode.FileNotFound, 'Blob not found');
    const { url, expiresAt } = await this.files.downloadUrl(file);
    return new SignedUrlEntity(url, expiresAt);
  }

  /** The file must belong to the project; 404 otherwise (no probing). */
  private async projectFile(
    user: AuthenticatedUser,
    projectId: string,
    fileId: string,
    permission: Permission = 'canView',
  ): Promise<StoredFile> {
    await this.access.require(user, projectId, permission);
    const file = await this.files.findById(fileId);
    if (!file || file.projectId !== projectId) {
      throw AppError.notFound(ErrorCode.FileNotFound, 'File not found');
    }
    return file;
  }
}
