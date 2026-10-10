import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { TrimmedString } from '../../common/validation/field-rules';

export class KeywordSearchDto {
  @ApiProperty({ maxLength: 200 }) @TrimmedString(1, 200) keyword!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  records: number = 50;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  startingRecord: number = 0;

  @ApiPropertyOptional({ enum: ['', 'Category', 'InStock', 'RohsAndReach', 'Rohs', 'None'] })
  @IsOptional()
  @IsIn(['', 'Category', 'InStock', 'RohsAndReach', 'Rohs', 'None'])
  searchOptions?: string;

  @ApiPropertyOptional({ description: 'Project the search is for (usage attribution)' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class SpecsDto {
  @ApiProperty() @TrimmedString(1, 60) type!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) voltageRating?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) currentRating?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) powerRating?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) inductance?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) capacitance?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) resistance?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) packageType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) mountingType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) operatingTempRange?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) efficiency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) tolerance?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) saturationCurrent?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) coreType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) applicationNotes?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  designConstraints?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) partNumber?: string;
}

export class SpecSearchItemDto {
  @ApiProperty({ description: 'Designator / name, e.g. "Q1 (2N7002 N-channel) mosfet"' })
  @TrimmedString(1, 200)
  name!: string;

  @ApiProperty({ type: SpecsDto })
  @ValidateNested()
  @Type(() => SpecsDto)
  specs!: SpecsDto;

  @ApiPropertyOptional({ description: 'Search with exactly this keyword' })
  @IsOptional()
  @TrimmedString(1, 200)
  keyword?: string;
}

export class SpecSearchDto {
  @ApiProperty({ type: [SpecSearchItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => SpecSearchItemDto)
  components!: SpecSearchItemDto[];

  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxResults: number = 10;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() forceRefresh?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
}

export const MOUSER_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/#+]{0,79}$/;

export class PartNumberParamDto {
  @ApiProperty()
  @IsString()
  @Matches(MOUSER_PART_PATTERN, { message: 'invalid part number' })
  mouserPartNumber!: string;
}
