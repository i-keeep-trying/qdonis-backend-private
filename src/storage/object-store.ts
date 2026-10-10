/**
 * Minimal object-store surface the app needs. The production implementation is
 * {@link S3ObjectStore}; tests bind an in-memory one. Keys are full object keys
 * (prefix included).
 */
export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  /** e.g. `attachment; filename="bom.xlsx"` */
  contentDisposition?: string;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType?: string;
}

export interface UploadUrl {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the PUT, exactly as given. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DeleteResult {
  failed: Array<{ key: string; error: string }>;
}

export abstract class ObjectStore {
  abstract put(input: PutObjectInput): Promise<void>;
  /** Null when the object does not exist. */
  abstract head(key: string): Promise<ObjectHead | null>;
  /** Throws {@link ObjectNotFoundError} when missing. */
  abstract get(key: string): Promise<Buffer>;
  abstract copy(sourceKey: string, targetKey: string): Promise<void>;
  /** Missing keys count as deleted. */
  abstract delete(keys: string[]): Promise<DeleteResult>;
  abstract uploadUrl(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<UploadUrl>;
  abstract downloadUrl(input: {
    key: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }>;
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}
