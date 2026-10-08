import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { Document } from '../../generated/prisma/client';

/**
 * API representation of a document.
 *
 * The raw embedding is never returned: it is large, meaningless to a client, and
 * regenerating it is cheaper than shipping it. `hasEmbedding` conveys the only
 * part callers actually need.
 */
export class DocumentEntity {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  userId: string | null;

  @ApiProperty()
  title: string;

  @ApiProperty()
  content: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  metadata: unknown;

  @ApiProperty({ description: 'Whether a vector is stored for this document' })
  hasEmbedding: boolean;

  @ApiPropertyOptional({
    description:
      'Cosine similarity to the query vector, 1 being identical. Only present ' +
      'on search results.',
  })
  similarity?: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  constructor(
    document: Document,
    options: { hasEmbedding: boolean; similarity?: number },
  ) {
    this.id = document.id;
    this.userId = document.userId;
    this.title = document.title;
    this.content = document.content;
    this.metadata = document.metadata;
    this.hasEmbedding = options.hasEmbedding;
    this.similarity = options.similarity;
    this.createdAt = document.createdAt;
    this.updatedAt = document.updatedAt;
  }
}
