import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { Document } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** A search hit: the document plus its similarity to the query vector. */
export interface DocumentSearchHit {
  document: Document;
  similarity: number;
}

/**
 * Serialises a JS array into pgvector's text input format, `[1,2,3]`.
 *
 * Non-finite values are rejected because pgvector has no representation for
 * them and Postgres would fail with a less obvious error.
 */
export function toVectorLiteral(embedding: number[]): string {
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error('Embedding values must all be finite numbers');
    }
  }
  return `[${embedding.join(',')}]`;
}

/**
 * Data access for documents, including the pgvector operations.
 *
 * Prisma cannot see the `embedding` column — it is declared `Unsupported` in the
 * schema — so anything touching it goes through raw SQL. Every raw query below
 * uses tagged-template interpolation, which Prisma turns into bound parameters
 * rather than string concatenation, so user input cannot alter the statement.
 */
@Injectable()
export class DocumentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserts a document and, when provided, its embedding in a single statement.
   *
   * The id is generated here so the row can be read back without a second
   * round trip to discover it.
   */
  async create(input: {
    userId: string | null;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
    embedding?: number[];
  }): Promise<Document> {
    const id = randomUUID();
    const metadata = JSON.stringify(input.metadata);

    if (input.embedding) {
      const vector = toVectorLiteral(input.embedding);
      await this.prisma.$executeRaw`
        INSERT INTO documents (id, user_id, title, content, embedding, metadata, created_at, updated_at)
        VALUES (
          ${id}::uuid,
          ${input.userId}::uuid,
          ${input.title},
          ${input.content},
          ${vector}::vector,
          ${metadata}::jsonb,
          NOW(),
          NOW()
        )
      `;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO documents (id, user_id, title, content, metadata, created_at, updated_at)
        VALUES (
          ${id}::uuid,
          ${input.userId}::uuid,
          ${input.title},
          ${input.content},
          ${metadata}::jsonb,
          NOW(),
          NOW()
        )
      `;
    }

    // Non-null: the row was just inserted in this same connection pool.
    return (await this.findById(id)) as Document;
  }

  findById(id: string): Promise<Document | null> {
    return this.prisma.document.findUnique({ where: { id } });
  }

  async hasEmbedding(id: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ present: boolean }>>`
      SELECT embedding IS NOT NULL AS present FROM documents WHERE id = ${id}::uuid
    `;
    return rows[0]?.present ?? false;
  }

  /** Replaces the embedding on an existing row. */
  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    const vector = toVectorLiteral(embedding);
    await this.prisma.$executeRaw`
      UPDATE documents
      SET embedding = ${vector}::vector, updated_at = NOW()
      WHERE id = ${id}::uuid
    `;
  }

  /**
   * Nearest-neighbour search using pgvector's cosine distance operator `<=>`.
   *
   * Cosine distance is in [0, 2], so similarity is `1 - distance`, giving 1 for
   * an identical direction. Ordering by the bare operator expression is what
   * allows the HNSW index to serve the query; wrapping it in arithmetic would
   * force a sequential scan, so the ORDER BY deliberately repeats the raw
   * distance rather than reusing the computed similarity column.
   */
  async searchByEmbedding(params: {
    embedding: number[];
    limit: number;
    minSimilarity?: number;
    userId?: string | null;
  }): Promise<DocumentSearchHit[]> {
    const vector = toVectorLiteral(params.embedding);
    // 1 - similarity, because the SQL filters on distance.
    const maxDistance =
      params.minSimilarity === undefined ? null : 1 - params.minSimilarity;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        user_id: string | null;
        title: string;
        content: string;
        metadata: unknown;
        created_at: Date;
        updated_at: Date;
        distance: number;
      }>
    >`
      SELECT
        id,
        user_id,
        title,
        content,
        metadata,
        created_at,
        updated_at,
        embedding <=> ${vector}::vector AS distance
      FROM documents
      WHERE embedding IS NOT NULL
        AND (${params.userId ?? null}::uuid IS NULL OR user_id = ${params.userId ?? null}::uuid)
        AND (${maxDistance}::double precision IS NULL
             OR embedding <=> ${vector}::vector <= ${maxDistance}::double precision)
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${params.limit}
    `;

    return rows.map((row) => ({
      document: {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        content: row.content,
        metadata: row.metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } as Document,
      // Clamped because floating-point error can nudge an exact match past 1.
      similarity: Math.min(1, Math.max(-1, 1 - Number(row.distance))),
    }));
  }

  async paginate(
    skip: number,
    take: number,
    userId?: string,
  ): Promise<{ items: Document[]; total: number }> {
    const where = userId ? { userId } : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.document.count({ where }),
    ]);

    return { items, total };
  }

  async delete(id: string): Promise<void> {
    await this.prisma.document.delete({ where: { id } });
  }

  /** Ids of the rows in `ids` that currently hold an embedding. */
  async findIdsWithEmbedding(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM documents
      WHERE embedding IS NOT NULL AND id = ANY(${ids}::uuid[])
    `;

    return new Set(rows.map((row) => row.id));
  }
}
