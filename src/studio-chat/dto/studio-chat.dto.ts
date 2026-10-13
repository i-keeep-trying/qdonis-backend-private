import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateBy,
  ValidateNested,
} from 'class-validator';

export const CHAT_MESSAGE_MAX = 8_000;
export const ATTACHMENTS_PER_MESSAGE = 5;

/** Body of `POST /projects/:projectId/chat/messages` (qdonis-web `SendMessageInput`). */
export class SendChatMessageDto {
  @ApiProperty({ description: 'Client-generated UUID; the stored message id' })
  @IsUUID('4')
  clientMessageId!: string;

  @ApiProperty({ maxLength: CHAT_MESSAGE_MAX })
  @IsString()
  @MaxLength(CHAT_MESSAGE_MAX)
  text!: string;

  @ApiProperty({ type: [String], maxItems: ATTACHMENTS_PER_MESSAGE })
  @IsArray()
  @ArrayMaxSize(ATTACHMENTS_PER_MESSAGE)
  @IsUUID('4', { each: true })
  attachmentIds!: string[];

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  branchId!: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  initialPromptId?: string;
}

const KINDS = ['question', 'fields', 'topologies', 'spec_approval'] as const;

/** `{ name: value }` with short keys and values (at most 40 entries). */
function IsValueMap(): PropertyDecorator {
  return ValidateBy({
    name: 'isValueMap',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 40 &&
        Object.entries(value).every(
          ([k, v]) =>
            k.length <= 60 && typeof v === 'string' && v.length <= 200,
        ),
      defaultMessage: () => 'values must map field names to short strings',
    },
  });
}

/** One answer; the fields used depend on `kind` (qdonis-web `WidgetAnswer`). */
export class WidgetAnswerDto {
  @ApiProperty({ enum: KINDS })
  @IsIn(KINDS)
  kind!: (typeof KINDS)[number];

  @ApiPropertyOptional({ type: [String], description: 'question' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  optionIds?: string[];

  @ApiPropertyOptional({ description: 'fields: name -> value' })
  @IsOptional()
  @IsObject()
  @IsValueMap()
  values?: Record<string, string>;

  @ApiPropertyOptional({ description: 'topologies' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  topologyId?: string;

  @ApiPropertyOptional({ description: 'spec_approval' })
  @IsOptional()
  @IsBoolean()
  approve?: boolean;
}

/** Body of `POST /projects/:projectId/chat/widgets/:widgetId/answer`. */
export class AnswerWidgetDto {
  @ApiProperty()
  @IsUUID('4')
  messageId!: string;

  @ApiProperty({ type: WidgetAnswerDto })
  @IsObject()
  @ValidateNested()
  @Type(() => WidgetAnswerDto)
  answer!: WidgetAnswerDto;
}

/** Multipart fields of `POST /projects/:projectId/attachments` (besides `file`). */
export class UploadAttachmentDto {
  @ApiProperty({ enum: ['netlist', 'document'] })
  @IsIn(['netlist', 'document'])
  kind!: 'netlist' | 'document';
}
