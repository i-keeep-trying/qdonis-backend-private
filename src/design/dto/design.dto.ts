import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { TrimmedString } from '../../common/validation/field-rules';
import {
  ENGINEERING_CATEGORY_IDS,
  type EngineeringCategoryId,
  MANDATORY_PARAMETER_IDS,
  type MandatoryParameterId,
} from '../catalog/mandatory-parameters';
import { MAX_DOCUMENTS_PER_STEP } from '../ai/spec-documents.service';

export class DocumentsInputDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Uploaded specification documents (POST /files/documents or /projects/:id/files/documents)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DOCUMENTS_PER_STEP)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  documentIds?: string[];
}

export class AnalyzeDesignIntentDto extends DocumentsInputDto {
  @ApiPropertyOptional({
    maxLength: 20000,
    description: 'Requirements text; defaults to the project prompt',
  })
  @IsOptional()
  @TrimmedString(1, 20_000)
  userInput?: string;
}

export const PARAMETER_ACTIONS = [
  'set',
  'accept_recommendation',
  'approve_assumption',
  'reset',
] as const;
export type ParameterAction = (typeof PARAMETER_ACTIONS)[number];

export class EditDesignParameterDto {
  @ApiProperty({ enum: MANDATORY_PARAMETER_IDS })
  @IsIn(MANDATORY_PARAMETER_IDS)
  id!: MandatoryParameterId;

  @ApiProperty({ enum: PARAMETER_ACTIONS })
  @IsIn(PARAMETER_ACTIONS)
  action!: ParameterAction;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: "For 'set'; empty clears the value",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  value?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reasoning?: string;
}

export class ProcessRequirementsDto extends DocumentsInputDto {
  @ApiPropertyOptional({
    enum: ENGINEERING_CATEGORY_IDS,
    isArray: true,
    description: 'Defaults to every category (as the old flow did)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(ENGINEERING_CATEGORY_IDS, { each: true })
  categories?: EngineeringCategoryId[];

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @TrimmedString(1, 20_000)
  userInput?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Include the reviewed design intent (mandatory parameters)',
  })
  @IsOptional()
  @IsBoolean()
  useReviewedIntent?: boolean;
}

export class RecommendTopologiesDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Confirmed parameter values (name -> value or { value })',
  })
  @IsObject()
  parameters!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Ignore the cache and ask the model again',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class GenerateConstraintsDto {
  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @TrimmedString(1, 4000)
  notes?: string;
}

const SOURCES = ['agent', 'user'] as const;

export class SpecRowInputDto {
  @ApiProperty() @TrimmedString(1, 200) name!: string;
  @ApiProperty() @IsString() @MaxLength(1000) value!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) unit?: string;
  @ApiPropertyOptional({
    enum: [
      'electrical',
      'performance',
      'thermal',
      'mechanical',
      'compliance',
      'other',
    ],
  })
  @IsOptional()
  @IsIn([
    'electrical',
    'performance',
    'thermal',
    'mechanical',
    'compliance',
    'other',
  ])
  category?:
    | 'electrical'
    | 'performance'
    | 'thermal'
    | 'mechanical'
    | 'compliance'
    | 'other';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() required?: boolean;
  @ApiPropertyOptional({ enum: ['user', 'assumed', 'derived'] })
  @IsOptional()
  @IsIn(['user', 'assumed', 'derived'])
  source?: 'user' | 'assumed' | 'derived';
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class UpdateSpecsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  application?: string;

  @ApiPropertyOptional({ type: [SpecRowInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => SpecRowInputDto)
  rows?: SpecRowInputDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  remove?: string[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() requestApproval?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() approved?: boolean;

  @ApiPropertyOptional({ enum: SOURCES, default: 'user' })
  @IsOptional()
  @IsIn(SOURCES)
  source?: (typeof SOURCES)[number];
}

export class ConstraintInputDto {
  @ApiProperty() @TrimmedString(1, 200) name!: string;
  @ApiProperty() @IsString() @MaxLength(1000) value!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reasoning?: string;
}

export class UpdateConstraintsDto {
  @ApiPropertyOptional({ type: [ConstraintInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ConstraintInputDto)
  items?: ConstraintInputDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  remove?: string[];

  @ApiPropertyOptional({ enum: SOURCES, default: 'user' })
  @IsOptional()
  @IsIn(SOURCES)
  source?: (typeof SOURCES)[number];
}
