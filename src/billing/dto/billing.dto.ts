import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { BillingInterval } from '../../generated/prisma/enums';
import { MAX_TOKEN_AMOUNT } from '../tokens.service';

export class PackageSelectionDto {
  @ApiProperty({ example: 'pro-basic' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  packageId!: string;

  @ApiProperty({ enum: BillingInterval })
  @IsEnum(BillingInterval)
  interval!: BillingInterval;
}

export class AddonCheckoutDto {
  @ApiPropertyOptional({
    description: 'Fixed add-on package. Exactly one of addonId / amountCents.',
  })
  @ValidateIf((dto: AddonCheckoutDto) => dto.amountCents === undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  addonId?: string;

  @ApiPropertyOptional({
    description: 'Custom top-up amount in cents (limits in addon_pricing).',
  })
  @ValidateIf((dto: AddonCheckoutDto) => dto.addonId === undefined)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  amountCents?: number;
}

export class ReportUsageDto {
  @ApiProperty({ minimum: 1, maximum: MAX_TOKEN_AMOUNT })
  @IsInt()
  @Min(1)
  @Max(MAX_TOKEN_AMOUNT)
  amount!: number;

  @ApiProperty({
    description:
      'Client-generated unique id for this usage (e.g. a UUID per LLM call). Retrying with the same key never charges twice.',
  })
  @Matches(/^[A-Za-z0-9._:-]{8,128}$/, {
    message: 'idempotencyKey must be 8-128 characters of [A-Za-z0-9._:-]',
  })
  idempotencyKey!: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'design.generate' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({
    description: 'Small JSON object stored with the ledger entry',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class AdminGrantTokensDto {
  @ApiProperty({ minimum: 1, maximum: MAX_TOKEN_AMOUNT })
  @IsInt()
  @Min(1)
  @Max(MAX_TOKEN_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 3650,
    description: 'Omit for tokens that never expire',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;

  @ApiProperty({ maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note!: string;
}

export class AdminDeductTokensDto {
  @ApiProperty({ minimum: 1, maximum: MAX_TOKEN_AMOUNT })
  @IsInt()
  @Min(1)
  @Max(MAX_TOKEN_AMOUNT)
  amount!: number;

  @ApiProperty({ maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note!: string;
}

export class AdminBatchExpiryDto {
  @ApiProperty({
    nullable: true,
    format: 'date-time',
    description: 'null = never expires',
  })
  @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true })
  expiresAt!: string | null;
}

export class AdminAssignPlanDto {
  @ApiProperty({ example: 'enterprise' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  planId!: string;

  @ApiPropertyOptional({
    description: 'Package of the plan, if it has packages',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  packageId?: string;

  @ApiProperty({ enum: BillingInterval })
  @IsEnum(BillingInterval)
  interval!: BillingInterval;

  @ApiProperty({
    description:
      'Tokens granted for this period (custom amount for enterprise)',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_AMOUNT)
  tokenAllocation!: number;
}

export class AdminUserQueryDto {
  @ApiPropertyOptional({
    description: 'Matches email or name (case-insensitive)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number(value) : value,
  )
  @IsInt()
  @Min(0)
  skip: number = 0;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;
}
