import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRICE_ID = /^price_[A-Za-z0-9]+$/;
const MAX_CENTS = 100_000_000;
const MAX_TOKENS = 100_000_000;

export class UpdatePlanDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  features?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPopular?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isContactOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class CreatePackageDto {
  @ApiProperty({ example: 'pro-ultra', description: 'Lowercase slug' })
  @Matches(SLUG, { message: 'id must be a lowercase slug like pro-ultra' })
  @MaxLength(50)
  id!: string;

  @ApiProperty({ example: 'pro' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  planId!: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: 'Tokens per month' })
  @IsInt()
  @Min(0)
  @Max(MAX_TOKENS)
  tokenAllocation!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  monthlyPriceCents!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  yearlyPriceCents!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @Matches(PRICE_ID, {
    message: 'stripePriceIdMonthly must look like price_...',
  })
  stripePriceIdMonthly?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @Matches(PRICE_ID, {
    message: 'stripePriceIdYearly must look like price_...',
  })
  stripePriceIdYearly?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdatePackageDto extends PartialType(
  OmitType(CreatePackageDto, ['id', 'planId'] as const),
) {}

export class CreateAddonDto {
  @ApiProperty({ example: 'topup-100k' })
  @Matches(SLUG, { message: 'id must be a lowercase slug like topup-100k' })
  @MaxLength(50)
  id!: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(MAX_TOKENS)
  tokenAmount!: number;

  @ApiProperty({ minimum: 50 })
  @IsInt()
  @Min(50)
  @Max(MAX_CENTS)
  priceCents!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @Matches(PRICE_ID, { message: 'stripePriceId must look like price_...' })
  stripePriceId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateAddonDto extends PartialType(
  OmitType(CreateAddonDto, ['id'] as const),
) {}
