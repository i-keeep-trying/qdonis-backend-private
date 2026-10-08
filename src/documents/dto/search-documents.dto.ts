import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class SearchDocumentsDto {
  @ApiProperty({
    type: [Number],
    description:
      'Query embedding. Length must equal EMBEDDING_DIMENSIONS. Results are ' +
      'ordered by cosine distance against the stored embeddings.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16_000)
  @IsNumber({ allowInfinity: false, allowNaN: false }, { each: true })
  @Type(() => Number)
  embedding!: number[];

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description:
      'Discard results whose cosine similarity is below this threshold.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  minSimilarity?: number;
}

/**
 * Body for attaching an embedding to an existing document. Shares the vector
 * validation with {@link SearchDocumentsDto} but drops the search-only options.
 */
export class SetEmbeddingDto extends PickType(SearchDocumentsDto, [
  'embedding',
] as const) {}
