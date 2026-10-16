import {
  applyDecorators,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import { BRANCH_NAME_MAX } from '../studio/studio-branches';
import { STAGE_ORDER, type StageKind } from '../studio/studio-graph';

/** Branch and result ids (`br_…`, `n_…`): the graph's id alphabet. */
export const GRAPH_ID = /^[A-Za-z0-9_-]{1,100}$/;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** No control characters (they would break the branch menu and logs). */
const PRINTABLE = /^[^\p{Cc}\p{Cf}]+$/u;

/** Validates a graph id route parameter (400 instead of a database error). */
@Injectable()
export class ParseGraphIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !GRAPH_ID.test(value)) {
      throw AppError.badRequest(ErrorCode.ValidationFailed, 'Invalid id');
    }
    return value;
  }
}

@Injectable()
export class ParseStagePipe implements PipeTransform<unknown, StageKind> {
  transform(value: unknown): StageKind {
    if (
      typeof value !== 'string' ||
      !(STAGE_ORDER as readonly string[]).includes(value)
    ) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        `stage must be one of ${STAGE_ORDER.join(', ')}`,
      );
    }
    return value as StageKind;
  }
}

/** Branch name: trimmed, 1–100 printable characters. */
const branchName = () =>
  applyDecorators(
    Transform(trim),
    IsString(),
    MinLength(1, { message: 'name must not be empty' }),
    MaxLength(BRANCH_NAME_MAX),
    Matches(PRINTABLE, { message: 'name contains invalid characters' }),
  );

export class WorkspaceQueryDto {
  @ApiPropertyOptional({ description: 'Branch to show; defaults to mine' })
  @IsOptional()
  @Matches(GRAPH_ID)
  branchId?: string;
}

export class SetActiveBranchDto {
  @ApiProperty()
  @Matches(GRAPH_ID)
  branchId!: string;
}

export class SetEntryStepDto {
  @ApiProperty({
    enum: STAGE_ORDER,
    description: '`specs` = start from scratch (full design)',
  })
  @IsIn(STAGE_ORDER)
  step!: StageKind;
}

export class CreateBranchDto {
  @ApiPropertyOptional({
    maxLength: BRANCH_NAME_MAX,
    description: 'Made unique by adding a number when taken',
  })
  @IsOptional()
  @branchName()
  name?: string;

  @ApiPropertyOptional({
    description: 'Start from this branch (its latest result); defaults to mine',
  })
  @IsOptional()
  @Matches(GRAPH_ID)
  fromBranchId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Start at this result instead (null: the project start)',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(GRAPH_ID)
  fromNodeId?: string | null;

  @ApiPropertyOptional({
    enum: STAGE_ORDER,
    description: 'Start just before this stage of the source branch',
  })
  @IsOptional()
  @IsIn(STAGE_ORDER)
  forkBeforeStage?: StageKind;
}

export class RenameBranchDto {
  @ApiProperty({ maxLength: BRANCH_NAME_MAX })
  @branchName()
  name!: string;
}
