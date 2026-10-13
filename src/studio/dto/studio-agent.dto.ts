import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * One frontend chat block: `text {text}`, `tool_use {id, name, input}` or
 * `tool_result {tool_use_id, content, is_error}`. Unknown `type` strings are
 * accepted and dropped by the history repair (as in qdonis-core). Sizes are
 * bounded per field; BODY_LIMIT caps the whole request.
 */
export class StudioContentBlockDto {
  @ApiProperty({
    example: 'text',
    description: 'text | tool_use | tool_result',
  })
  @IsString()
  @MaxLength(64)
  type!: string;

  @ApiPropertyOptional({ description: 'For `text` blocks' })
  @IsOptional()
  @IsString()
  @MaxLength(1_000_000)
  text?: string;

  @ApiPropertyOptional({ description: 'Tool use id (`tool_use`)' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  id?: string;

  @ApiPropertyOptional({ description: 'Tool name (`tool_use`)' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  @ApiPropertyOptional({
    description: 'Tool input as returned by the model (`tool_use`)',
    type: 'object',
    additionalProperties: true,
  })
  @Allow()
  input?: unknown;

  @ApiPropertyOptional({ description: 'Answered tool use id (`tool_result`)' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  tool_use_id?: string;

  @ApiPropertyOptional({
    description: 'Tool result payload: any JSON value (`tool_result`)',
  })
  @Allow()
  content?: unknown;

  @ApiPropertyOptional({ description: 'Tool failed (`tool_result`)' })
  @IsOptional()
  @IsBoolean()
  is_error?: boolean;
}

export class StudioMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty({ type: [StudioContentBlockDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StudioContentBlockDto)
  content!: StudioContentBlockDto[];
}

export class StudioAgentRequestDto {
  @ApiProperty({
    type: [StudioMessageDto],
    description: 'Conversation so far, oldest first',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => StudioMessageDto)
  messages!: StudioMessageDto[];

  @ApiPropertyOptional({
    description:
      'Compact snapshot of the active branch; embedded in the system prompt (truncated to 9,000 characters)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  project_state?: Record<string, unknown>;
}
