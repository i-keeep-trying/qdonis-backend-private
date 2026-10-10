/// <reference types="multer" />
import {
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
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { StoredFile } from '../generated/prisma/client';
import { StoredFileKind } from '../generated/prisma/enums';
import {
  DocumentEntity,
  SignedUrlEntity,
  StoredFileEntity,
} from './entities/stored-file.entity';
import { MAX_DOCUMENT_BYTES } from './storage.constants';
import { StoredFilesService } from './stored-files.service';

/** One file per request; multer rejects bigger bodies with 413 before parsing. */
export const documentUpload = () =>
  FileInterceptor('file', {
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 5 },
  });

export function requireFile(
  file: Express.Multer.File | undefined,
): Express.Multer.File {
  if (!file) {
    throw AppError.badRequest(
      ErrorCode.ValidationFailed,
      'Attach the document as multipart field "file"',
    );
  }
  return file;
}

/**
 * The caller's own specification documents (uploaded before a project
 * exists, e.g. from the home page). Project-scoped files live under
 * `/projects/:id/files`.
 */
@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly files: StoredFilesService) {}

  @Post('documents')
  @UseInterceptors(documentUpload())
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Upload a specification document (.pdf, .docx, .txt, .md; 10 MB)',
  })
  @ApiCreatedResponse({ type: DocumentEntity })
  async upload(
    @CurrentUser('id') userId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<DocumentEntity> {
    const uploaded = requireFile(file);
    const stored = await this.files.uploadDocument({
      ownerId: userId,
      file: uploaded,
    });
    return new DocumentEntity(stored);
  }

  @Get('documents')
  @ApiOperation({ summary: 'My uploaded documents' })
  @ApiOkResponse({ type: PaginatedResultDto })
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<StoredFileEntity>> {
    const { items, total } = await this.files.pageDocuments(
      userId,
      query.skip,
      query.take,
    );
    return new PaginatedResultDto(
      items.map((f) => new StoredFileEntity(f)),
      total,
      query.skip,
      query.take,
    );
  }

  @Get('documents/:id')
  @ApiOperation({ summary: 'A document with its extracted text' })
  @ApiOkResponse({ type: DocumentEntity })
  async findOne(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentEntity> {
    return new DocumentEntity(await this.ownDocument(userId, id));
  }

  @Get('documents/:id/download')
  @ApiOperation({ summary: 'Short-lived signed download URL' })
  @ApiOkResponse({ type: SignedUrlEntity })
  async download(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SignedUrlEntity> {
    const { url, expiresAt } = await this.files.downloadUrl(
      await this.ownDocument(userId, id),
    );
    return new SignedUrlEntity(url, expiresAt);
  }

  @Delete('documents/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete one of my documents' })
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.files.remove(await this.ownDocument(userId, id));
  }

  /** 404 (not 403) for other users' files, so ids cannot be probed. */
  private async ownDocument(userId: string, id: string): Promise<StoredFile> {
    const file = await this.files.findById(id);
    if (
      !file ||
      file.ownerId !== userId ||
      file.kind !== StoredFileKind.DOCUMENT ||
      file.projectId !== null
    ) {
      throw AppError.notFound(ErrorCode.FileNotFound, 'Document not found');
    }
    return file;
  }
}
