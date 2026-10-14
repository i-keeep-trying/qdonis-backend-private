import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Body of `POST .../stages/visualization/schematic`. */
export class RenderSchematicDto {
  @ApiPropertyOptional({
    description: 'Group sheet to draw (absent: the top level).',
    maxLength: 256,
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  sheet?: string;

  @ApiPropertyOptional({
    description:
      'Ignore the saved positions and wires (automatic layout; the grouping is kept).',
  })
  @IsOptional()
  @IsBoolean()
  fresh?: boolean;

  @ApiPropertyOptional({
    description: 'Also drop the saved grouping (automatic proposal).',
  })
  @IsOptional()
  @IsBoolean()
  regroup?: boolean;
}

/** Body of `POST .../schematic/check` and `.../schematic/apply`. */
export class SchematicEditDto {
  @ApiProperty({
    description:
      'The edited drawing of one sheet as the engine posts it: `{components, wires}`.',
    type: Object,
  })
  @IsObject()
  schematic!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'The sheet the drawing shows (absent: the top level).',
    maxLength: 256,
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  sheet?: string;

  @ApiPropertyOptional({
    description:
      'The full layout the drawing was rendered with (every sheet, the grouping).',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  layout?: Record<string, unknown>;
}
