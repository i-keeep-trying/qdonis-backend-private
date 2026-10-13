import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDate,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { TrimmedString } from '../../common/validation/field-rules';
import { ProjectRole, ShareLinkType } from '../../generated/prisma/enums';

const lowerList = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? (value as unknown[]).map((v: unknown) =>
        typeof v === 'string' ? v.trim().toLowerCase() : v,
      )
    : value;

export class CreateInvitationsDto {
  @ApiProperty({ type: [String], maxItems: 20 })
  @Transform(lowerList)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsEmail({}, { each: true, message: 'every email must be valid' })
  @MaxLength(255, { each: true })
  emails!: string[];

  @ApiProperty({ enum: ProjectRole })
  @IsEnum(ProjectRole)
  role!: ProjectRole;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @TrimmedString(0, 1000)
  message?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 30, default: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays: number = 7;
}

const DOMAIN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class CreateShareLinkDto {
  @ApiProperty({ enum: ShareLinkType })
  @IsEnum(ShareLinkType)
  type!: ShareLinkType;

  @ApiProperty({ enum: [ProjectRole.VIEWER, ProjectRole.EDITOR] })
  @IsIn([ProjectRole.VIEWER, ProjectRole.EDITOR])
  role!: ProjectRole;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;

  @ApiPropertyOptional({
    minLength: 8,
    maxLength: 128,
    description: 'PASSWORD_PROTECTED only',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'DOMAIN_RESTRICTED only, e.g. acme.com',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? (value as unknown[]).map((v: unknown) =>
          typeof v === 'string' ? v.trim().toLowerCase().replace(/^@/, '') : v,
        )
      : value,
  )
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(DOMAIN, {
    each: true,
    message: 'every domain must look like example.com',
  })
  allowedDomains?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxUses?: number;
}

export class AccessShareLinkDto {
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: ProjectRole })
  @IsEnum(ProjectRole)
  role!: ProjectRole;
}
