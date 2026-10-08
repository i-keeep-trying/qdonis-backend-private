import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AppConfiguration } from '../config/configuration';
import type { Document } from '../generated/prisma/client';
import { Role } from '../generated/prisma/enums';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DocumentsRepository } from './documents.repository';
import type { CreateDocumentDto } from './dto/create-document.dto';
import type { SearchDocumentsDto } from './dto/search-documents.dto';
import { DocumentEntity } from './entities/document.entity';

@Injectable()
export class DocumentsService {
  private readonly expectedDimensions: number;

  constructor(
    private readonly documentsRepository: DocumentsRepository,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.expectedDimensions = config.get('database', {
      infer: true,
    }).embeddingDimensions;
  }

  async create(
    dto: CreateDocumentDto,
    user: AuthenticatedUser,
  ): Promise<DocumentEntity> {
    if (dto.embedding) this.assertDimensions(dto.embedding);

    const document = await this.documentsRepository.create({
      userId: user.id,
      title: dto.title,
      content: dto.content,
      metadata: dto.metadata ?? {},
      embedding: dto.embedding,
    });

    return new DocumentEntity(document, {
      hasEmbedding: dto.embedding !== undefined,
    });
  }

  async findAll(
    query: PaginationQueryDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<DocumentEntity>> {
    // Administrators see everything; everyone else sees only their own rows.
    const scopeToUser = user.role === Role.ADMIN ? undefined : user.id;

    const { items, total } = await this.documentsRepository.paginate(
      query.skip,
      query.take,
      scopeToUser,
    );

    // One query for the whole page rather than one per row.
    const withEmbedding = await this.documentsRepository.findIdsWithEmbedding(
      items.map((item) => item.id),
    );

    return new PaginatedResultDto(
      items.map(
        (item) =>
          new DocumentEntity(item, {
            hasEmbedding: withEmbedding.has(item.id),
          }),
      ),
      total,
      query.skip,
      query.take,
    );
  }

  async findOne(id: string, user: AuthenticatedUser): Promise<DocumentEntity> {
    const document = await this.authorise(id, user);
    return new DocumentEntity(document, {
      hasEmbedding: await this.documentsRepository.hasEmbedding(id),
    });
  }

  /**
   * Vector similarity search.
   *
   * Non-administrators are scoped to their own documents, so the endpoint cannot
   * be used to probe other users' content by embedding proximity.
   */
  async search(
    dto: SearchDocumentsDto,
    user: AuthenticatedUser,
  ): Promise<DocumentEntity[]> {
    this.assertDimensions(dto.embedding);

    const hits = await this.documentsRepository.searchByEmbedding({
      embedding: dto.embedding,
      limit: dto.limit,
      minSimilarity: dto.minSimilarity,
      userId: user.role === Role.ADMIN ? null : user.id,
    });

    return hits.map(
      (hit) =>
        new DocumentEntity(hit.document, {
          hasEmbedding: true,
          similarity: hit.similarity,
        }),
    );
  }

  async setEmbedding(
    id: string,
    embedding: number[],
    user: AuthenticatedUser,
  ): Promise<DocumentEntity> {
    this.assertDimensions(embedding);
    const document = await this.authorise(id, user);

    await this.documentsRepository.setEmbedding(id, embedding);

    return new DocumentEntity(document, { hasEmbedding: true });
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    await this.authorise(id, user);
    await this.documentsRepository.delete(id);
  }

  /**
   * A vector column has a fixed width, so a mismatched embedding would be
   * rejected by Postgres. Checking here turns that into a clear 400 instead of
   * a database error.
   */
  private assertDimensions(embedding: number[]): void {
    if (embedding.length !== this.expectedDimensions) {
      throw new BadRequestException(
        `Embedding must have exactly ${this.expectedDimensions} dimensions, received ${embedding.length}`,
      );
    }
  }

  /** Loads a document, enforcing ownership unless the caller is an admin. */
  private async authorise(
    id: string,
    user: AuthenticatedUser,
  ): Promise<Document> {
    const document = await this.documentsRepository.findById(id);
    if (!document) {
      throw new NotFoundException(`Document ${id} was not found`);
    }

    if (user.role !== Role.ADMIN && document.userId !== user.id) {
      throw new ForbiddenException('This document belongs to another user');
    }

    return document;
  }
}
