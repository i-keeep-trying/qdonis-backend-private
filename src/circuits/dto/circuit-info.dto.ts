import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Body of `POST /studio/circuit-info` (same keys as the qdonis-core route). */
export class CircuitInfoDto {
  @ApiPropertyOptional({ example: 'dcdc_buck', maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  topology_id?: string | null;

  @ApiPropertyOptional({
    description: 'Edited topology dict; used when it has components',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  circuit?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Design values `[{ ref, param, after }]` to apply',
    type: [Object],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsObject({ each: true })
  recalculated_parameters?: Record<string, unknown>[] | null;
}
