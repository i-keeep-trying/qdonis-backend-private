import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { TrimmedString } from '../../common/validation/field-rules';
import { ProjectActivityType } from '../../generated/prisma/enums';
import { STAGE_BLOB_CONTENT_TYPES } from '../../storage/storage.constants';
import type { ProjectScope } from '../projects.repository';
import { STAGE_ORDER, type WorkspaceStage } from '../studio/studio-graph';

export const DEFAULT_PROJECT_NAME = 'My Project';

export class CreateProjectDto {
  @ApiPropertyOptional({ maxLength: 200, default: DEFAULT_PROJECT_NAME })
  @IsOptional()
  @TrimmedString(1, 200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @TrimmedString(0, 2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Create inside this team (you must be a member)',
  })
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @ApiPropertyOptional({
    maxLength: 20000,
    description: 'The requirement prompt that starts the project',
  })
  @IsOptional()
  @TrimmedString(1, 20_000)
  prompt?: string;

  @ApiPropertyOptional({
    enum: STAGE_ORDER,
    description:
      'The step the project starts at (`specs` = the full design flow). Omitted: the agent helps choose it.',
  })
  @IsOptional()
  @IsIn(STAGE_ORDER)
  entryStep?: WorkspaceStage;
}

export class UpdateProjectDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @TrimmedString(1, 200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @TrimmedString(0, 2000)
  description?: string | null;
}

const SCOPES: ProjectScope[] = ['all', 'personal', 'shared', 'team'];

export class ListProjectsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SCOPES, default: 'all' })
  @IsOptional()
  @IsIn(SCOPES)
  scope: ProjectScope = 'all';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @TrimmedString(1, 100)
  search?: string;
}

export class AdminProjectsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Project name or owner email',
  })
  @IsOptional()
  @TrimmedString(1, 100)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

export class SaveStudioDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The Studio graph (version 1)',
  })
  @IsObject()
  studio!: Record<string, unknown>;

  @ApiProperty({
    description:
      'Revision the edit was based on; a newer stored revision answers 409',
  })
  @IsInt()
  @Min(0)
  revision!: number;
}

export class DuplicateProjectDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @TrimmedString(1, 200)
  name?: string;
}

export class CreateVersionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @TrimmedString(0, 500)
  description?: string;
}

const toList = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim()) : value;

export class ActivityQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ProjectActivityType,
    isArray: true,
    description: 'Comma-separated',
  })
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsEnum(ProjectActivityType, { each: true })
  types?: ProjectActivityType[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class CreateBlobUploadDto {
  @ApiProperty({ example: 'studio/n_123', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+){0,4}$/, {
    message: 'name must be path-like, e.g. studio/<nodeId>',
  })
  name!: string;

  @ApiProperty({ enum: STAGE_BLOB_CONTENT_TYPES })
  @IsIn(STAGE_BLOB_CONTENT_TYPES)
  contentType!: (typeof STAGE_BLOB_CONTENT_TYPES)[number];

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes!: number;
}

export class BlobNameQueryDto {
  @ApiProperty({ example: 'studio/n_123' })
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+){0,4}$/, {
    message: 'name must be path-like, e.g. studio/<nodeId>',
  })
  name!: string;
}
