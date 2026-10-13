import { StoredFileKind } from '../generated/prisma/enums';

const MB = 1024 * 1024;

/** Specification documents (same limit as the old frontend parser). */
export const MAX_DOCUMENT_BYTES = 10 * MB;
/** Heavy stage payloads (simulation plots, waveforms). */
export const MAX_STAGE_BLOB_BYTES = 200 * MB;
export const MAX_EXPORT_BYTES = 50 * MB;
/** Extracted document text kept in the database. */
export const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;
/** PENDING uploads older than this are abandoned and removed by the sweeper. */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;

export const KIND_LIMITS: Record<StoredFileKind, number> = {
  [StoredFileKind.DOCUMENT]: MAX_DOCUMENT_BYTES,
  [StoredFileKind.STAGE_BLOB]: MAX_STAGE_BLOB_BYTES,
  [StoredFileKind.EXPORT]: MAX_EXPORT_BYTES,
};

export const STAGE_BLOB_CONTENT_TYPES = [
  'application/json',
  'application/gzip',
] as const;

/** `studio/<nodeId>`, `simulation/plots` ... : path-like, no traversal. */
export const BLOB_NAME_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+){0,4}$/;
