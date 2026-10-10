/** Stored project size cap (data blob + Studio graph). Heavy payloads go to S3. */
export const MAX_PROJECT_DATA_BYTES = 4 * 1024 * 1024;

export const byteSize = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');
