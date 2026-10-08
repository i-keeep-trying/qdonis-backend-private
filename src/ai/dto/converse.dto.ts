import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ConverseMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  /** ~1 MB of text per message; the JSON body limit caps the total. */
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(1_000_000)
  content!: string;
}

export class ConverseDto {
  @ApiProperty({ type: [ConverseMessageDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ConverseMessageDto)
  messages!: ConverseMessageDto[];

  @ApiPropertyOptional({
    description: 'Must be in BEDROCK_ALLOWED_MODELS; defaults to the first',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  modelId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1, default: 0.25 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  temperature?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(128_000)
  maxTokens?: number;

  @ApiPropertyOptional({
    description:
      'Pipeline step, for the admin step multiplier and usage reports',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9 _-]{1,64}$/, {
    message: 'step must be 1-64 letters, digits, spaces, _ or -',
  })
  step?: string;
}
