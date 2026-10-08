import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Upper bound on the embedding array, matching pgvector's own limit for indexed
 * columns. The exact expected dimension is checked in the service against
 * `EMBEDDING_DIMENSIONS`, since it is configuration rather than a static rule.
 */
const MAX_DIMENSIONS = 16_000;

export class CreateDocumentDto {
  @ApiProperty({ maxLength: 300, example: 'Vector search in Postgres' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @ApiProperty({ example: 'pgvector adds a vector column type to Postgres.' })
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  content!: string;

  @ApiPropertyOptional({
    type: [Number],
    description:
      'Embedding for the content. Length must equal EMBEDDING_DIMENSIONS. ' +
      'Omit to store the document without an embedding and add one later.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DIMENSIONS)
  @IsNumber({ allowInfinity: false, allowNaN: false }, { each: true })
  @Type(() => Number)
  embedding?: number[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Arbitrary JSON stored alongside the document.',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
