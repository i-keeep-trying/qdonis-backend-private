import mammoth from 'mammoth';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import { MAX_EXTRACTED_TEXT_CHARS } from './storage.constants';

export type DocumentFormat = 'pdf' | 'docx' | 'text';

export interface ParsedDocument {
  format: DocumentFormat;
  contentType: string;
  /** Null for PDFs: they are sent to the model as documents, not text. */
  text: string | null;
}

const CONTENT_TYPES: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  text: 'text/plain; charset=utf-8',
};

const extensionOf = (filename: string): string =>
  (filename.toLowerCase().split('.').pop() ?? '').trim();

/**
 * Format from the extension, confirmed by the file's magic bytes so a renamed
 * binary cannot pass as a document. Legacy `.doc` is refused: it cannot be
 * read reliably (the old frontend failed on it too).
 */
export function detectDocumentFormat(
  filename: string,
  bytes: Buffer,
): DocumentFormat {
  const ext = extensionOf(filename);
  const unsupported = () =>
    AppError.badRequest(
      ErrorCode.UnsupportedFileType,
      'Unsupported file type. Upload a .pdf, .docx, .txt or .md file',
    );

  if (ext === 'pdf') {
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw unsupported();
    return 'pdf';
  }
  if (ext === 'docx') {
    // DOCX is a ZIP container.
    if (!(
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04
    )) {
      throw unsupported();
    }
    return 'docx';
  }
  if (ext === 'txt' || ext === 'md') {
    if (bytes.includes(0)) throw unsupported();
    return 'text';
  }
  throw unsupported();
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, '');
  } catch {
    throw AppError.badRequest(
      ErrorCode.DocumentUnreadable,
      'The text file is not valid UTF-8',
    );
  }
}

export async function parseDocument(
  filename: string,
  bytes: Buffer,
): Promise<ParsedDocument> {
  if (bytes.length === 0) {
    throw AppError.badRequest(ErrorCode.FileEmpty, 'File is empty');
  }
  const format = detectDocumentFormat(filename, bytes);
  if (format === 'pdf') {
    return { format, contentType: CONTENT_TYPES.pdf, text: null };
  }

  let text: string;
  if (format === 'docx') {
    try {
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } catch {
      throw AppError.badRequest(
        ErrorCode.DocumentUnreadable,
        'The DOCX file could not be read; it may be corrupted',
      );
    }
  } else {
    text = decodeUtf8(bytes);
  }

  text = text.trim();
  if (!text) {
    throw AppError.badRequest(
      ErrorCode.DocumentUnreadable,
      'No text could be extracted from this file. The file may be empty, corrupted, or contain only images.',
    );
  }
  if (text.length > MAX_EXTRACTED_TEXT_CHARS) {
    throw AppError.tooLarge(
      ErrorCode.FileTooLarge,
      `The document text exceeds ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString('en-US')} characters`,
    );
  }
  return { format, contentType: CONTENT_TYPES[format], text };
}

/** RFC 6266 `Content-Disposition` with an ASCII fallback and UTF-8 name. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Display name: no path parts or control characters, at most 200 chars. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = [...base]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 200);
  return clean || 'file';
}
