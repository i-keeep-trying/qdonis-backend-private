import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import { StoredFileKind } from '../../generated/prisma/enums';
import type { ProjectAccess } from '../../projects/project-permissions';
import { StoredFilesService } from '../../storage/stored-files.service';

/** Bedrock accepts documents up to 4.5 MB each. */
const MAX_PDF_BYTES = Math.floor(4.5 * 1024 * 1024);
/** Text sent to the model per request (~75k tokens). */
const MAX_TEXT_CHARS = 300_000;
export const MAX_DOCUMENTS_PER_STEP = 5;

export interface SpecDocuments {
  /** Extracted text of DOCX/TXT/MD documents, joined; null when none. */
  text: string | null;
  /** PDFs as Bedrock document blocks. */
  attachments: ContentBlock[];
  names: string[];
  truncated: boolean;
}

/**
 * Turns uploaded specification documents (by id) into model input. A caller
 * may use their own unattached uploads, or documents of the project they are
 * working on; anything else is reported as not found.
 */
@Injectable()
export class SpecDocumentsService {
  constructor(private readonly files: StoredFilesService) {}

  async resolve(
    actorId: string,
    access: ProjectAccess | null,
    fileIds: string[] | undefined,
  ): Promise<SpecDocuments> {
    const result: SpecDocuments = {
      text: null,
      attachments: [],
      names: [],
      truncated: false,
    };
    const ids = [...new Set(fileIds ?? [])];
    if (ids.length === 0) return result;
    if (ids.length > MAX_DOCUMENTS_PER_STEP) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        `At most ${MAX_DOCUMENTS_PER_STEP} documents per request`,
      );
    }

    const texts: string[] = [];
    for (const [index, id] of ids.entries()) {
      const file = await this.files.findById(id);
      const allowed =
        file?.kind === StoredFileKind.DOCUMENT &&
        ((file.projectId === null && file.ownerId === actorId) ||
          (access !== null && file.projectId === access.projectId));
      if (!file || !allowed) {
        throw AppError.notFound(ErrorCode.FileNotFound, 'Document not found');
      }
      result.names.push(file.filename);
      if (file.extractedText !== null) {
        texts.push(
          ids.length > 1
            ? `[${file.filename}]\n${file.extractedText}`
            : file.extractedText,
        );
        continue;
      }
      if (file.sizeBytes > MAX_PDF_BYTES) {
        throw AppError.tooLarge(
          ErrorCode.FileTooLarge,
          `${file.filename} is larger than 4.5 MB, the limit for PDFs read by the AI. Upload a smaller PDF or a DOCX/TXT export.`,
        );
      }
      const bytes = await this.files.read(file);
      result.attachments.push({
        document: {
          format: 'pdf',
          // Bedrock allows letters, digits, single spaces, hyphens, () and [].
          name: `Specification ${index + 1}`,
          source: { bytes: new Uint8Array(bytes) },
        },
      });
    }

    if (texts.length) {
      let text = texts.join('\n\n');
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
        result.truncated = true;
      }
      result.text = text;
    }
    return result;
  }
}
