import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { TrimmedString } from '../../common/validation/field-rules';
import type { SpecCategory } from '../../design/studio-specs.logic';

const CATEGORIES: readonly SpecCategory[] = [
  'electrical',
  'performance',
  'thermal',
  'mechanical',
  'compliance',
  'other',
];

/** One row of the spec table as edited in the workspace (qdonis-web `SpecRowInput`). */
export class SpecTableRowDto {
  @ApiPropertyOptional({ description: 'Omitted for new rows', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  id?: string;

  @ApiProperty({ maxLength: 120 })
  @TrimmedString(1, 120)
  name!: string;

  @ApiProperty({ maxLength: 200 })
  @TrimmedString(1, 200)
  value!: string;

  @ApiProperty({ nullable: true, maxLength: 20 })
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  unit!: string | null;

  @ApiProperty({ enum: CATEGORIES })
  @IsIn(CATEGORIES)
  category!: SpecCategory;

  @ApiProperty()
  @IsBoolean()
  required!: boolean;
}

/** Body of `PUT /projects/:projectId/branches/:branchId/stages/specs`: the whole table. */
export class ReplaceSpecsDto {
  @ApiProperty({ nullable: true, maxLength: 200 })
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  application!: string | null;

  @ApiProperty({ type: [SpecTableRowDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SpecTableRowDto)
  rows!: SpecTableRowDto[];
}

export class ConstraintValueDto {
  @ApiProperty({ maxLength: 40 })
  @TrimmedString(1, 40)
  id!: string;

  @ApiProperty({ maxLength: 500 })
  @TrimmedString(1, 500)
  value!: string;
}

/** Body of `PUT /projects/:projectId/branches/:branchId/stages/specs/constraints`. */
export class EditConstraintsDto {
  @ApiProperty({ type: [ConstraintValueDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ConstraintValueDto)
  items!: ConstraintValueDto[];
}
