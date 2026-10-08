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
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import {
  SearchDocumentsDto,
  SetEmbeddingDto,
} from './dto/search-documents.dto';
import { DocumentEntity } from './entities/document.entity';

/**
 * Exercises the pgvector integration end to end.
 *
 * Embeddings are supplied by the caller rather than generated here — wiring in a
 * specific embedding provider is an application decision, and keeping it out
 * means this boilerplate has no third-party API dependency.
 */
@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @ApiOperation({ summary: 'Store a document, optionally with its embedding' })
  @ApiCreatedResponse({ type: DocumentEntity })
  create(
    @Body() dto: CreateDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DocumentEntity> {
    return this.documentsService.create(dto, user);
  }

  @Get()
  @ApiOperation({ summary: 'List documents visible to the current user' })
  @ApiOkResponse({ type: PaginatedResultDto })
  findAll(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<DocumentEntity>> {
    return this.documentsService.findAll(query, user);
  }

  /**
   * Declared before `:id` so that `/documents/search` is not captured by the
   * parameterised route.
   */
  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Nearest-neighbour search by cosine similarity' })
  @ApiOkResponse({ type: DocumentEntity, isArray: true })
  search(
    @Body() dto: SearchDocumentsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DocumentEntity[]> {
    return this.documentsService.search(dto, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single document' })
  @ApiOkResponse({ type: DocumentEntity })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DocumentEntity> {
    return this.documentsService.findOne(id, user);
  }

  @Put(':id/embedding')
  @ApiOperation({ summary: 'Attach or replace a document embedding' })
  @ApiOkResponse({ type: DocumentEntity })
  setEmbedding(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetEmbeddingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DocumentEntity> {
    return this.documentsService.setEmbedding(id, dto.embedding, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a document' })
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.documentsService.remove(id, user);
  }
}
