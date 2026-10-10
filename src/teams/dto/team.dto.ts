import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import { EmailField, TrimmedString } from '../../common/validation/field-rules';
import { TeamRole } from '../../generated/prisma/enums';

const MAX_LIMIT = 100_000_000;

export class CreateTeamDto {
  @ApiProperty({ maxLength: 100 })
  @TrimmedString(1, 100)
  name!: string;

  @ApiPropertyOptional({
    description: 'Cap on tokens the team may spend from your pool',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_LIMIT)
  tokenLimit?: number;
}

export class UpdateTeamDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @TrimmedString(1, 100)
  name?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'null removes the cap',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_LIMIT)
  tokenLimit?: number | null;
}

export class InviteTeamMemberDto {
  @ApiProperty()
  @EmailField()
  email!: string;

  @ApiPropertyOptional({
    enum: [TeamRole.ADMIN, TeamRole.MEMBER],
    default: TeamRole.MEMBER,
  })
  @IsOptional()
  @IsIn([TeamRole.ADMIN, TeamRole.MEMBER])
  role: TeamRole = TeamRole.MEMBER;
}

export class UpdateTeamMemberDto {
  @ApiProperty({ enum: [TeamRole.ADMIN, TeamRole.MEMBER] })
  @IsIn([TeamRole.ADMIN, TeamRole.MEMBER])
  role!: TeamRole;
}

export class TeamUsageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
