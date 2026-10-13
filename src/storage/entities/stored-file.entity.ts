import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { StoredFile } from '../../generated/prisma/client';
import { StoredFileKind } from '../../generated/prisma/enums';

/** Public view of a stored object. The S3 key is never exposed. */
export class StoredFileEntity {
  @ApiProperty() id: string;
  @ApiProperty({ enum: StoredFileKind }) kind: StoredFileKind;
  @ApiProperty() name: string;
  @ApiProperty() filename: string;
  @ApiProperty() contentType: string;
  @ApiProperty() sizeBytes: number;
  @ApiPropertyOptional({ type: String, nullable: true })
  projectId: string | null;
  @ApiProperty({ description: 'True when extracted text is available' })
  hasText: boolean;
  @ApiProperty() createdAt: Date;

  constructor(file: StoredFile) {
    this.id = file.id;
    this.kind = file.kind;
    this.name = file.name;
    this.filename = file.filename;
    this.contentType = file.contentType;
    this.sizeBytes = file.sizeBytes;
    this.projectId = file.projectId;
    this.hasText = file.extractedText !== null;
    this.createdAt = file.createdAt;
  }
}

export class DocumentEntity extends StoredFileEntity {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Extracted text (null for PDFs, which the model reads directly)',
  })
  text: string | null;

  constructor(file: StoredFile) {
    super(file);
    this.text = file.extractedText;
  }
}

export class SignedUrlEntity {
  @ApiProperty() url: string;
  @ApiProperty() expiresAt: Date;

  constructor(url: string, expiresAt: Date) {
    this.url = url;
    this.expiresAt = expiresAt;
  }
}

export class UploadTicketEntity {
  @ApiProperty({ type: StoredFileEntity }) file: StoredFileEntity;
  @ApiProperty() uploadUrl: string;
  @ApiProperty({ enum: ['PUT'] }) method: 'PUT';
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Send these headers unchanged with the PUT',
  })
  headers: Record<string, string>;
  @ApiProperty() expiresAt: Date;

  constructor(input: {
    file: StoredFile;
    url: string;
    headers: Record<string, string>;
    expiresAt: Date;
  }) {
    this.file = new StoredFileEntity(input.file);
    this.uploadUrl = input.url;
    this.method = 'PUT';
    this.headers = input.headers;
    this.expiresAt = input.expiresAt;
  }
}
