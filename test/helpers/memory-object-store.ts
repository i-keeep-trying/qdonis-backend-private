import {
  type DeleteResult,
  type ObjectHead,
  ObjectNotFoundError,
  ObjectStore,
  type PutObjectInput,
  type UploadUrl,
} from '../../src/storage/object-store';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/** In-memory stand-in for S3 + CloudFront. */
export class MemoryObjectStore extends ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  /** Keys handed out as presigned upload targets, newest last. */
  readonly uploadKeys: string[] = [];
  failDeletes = false;

  put(input: PutObjectInput): Promise<void> {
    this.objects.set(input.key, {
      body: Buffer.from(input.body),
      contentType: input.contentType,
    });
    return Promise.resolve();
  }

  /** What a browser PUT to the presigned URL would do. */
  simulateUpload(key: string, body: Buffer, contentType: string): void {
    this.objects.set(key, { body, contentType });
  }

  head(key: string): Promise<ObjectHead | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object
        ? { sizeBytes: object.body.length, contentType: object.contentType }
        : null,
    );
  }

  get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) return Promise.reject(new ObjectNotFoundError(key));
    return Promise.resolve(object.body);
  }

  copy(sourceKey: string, targetKey: string): Promise<void> {
    const object = this.objects.get(sourceKey);
    if (!object) return Promise.reject(new ObjectNotFoundError(sourceKey));
    this.objects.set(targetKey, { ...object });
    return Promise.resolve();
  }

  delete(keys: string[]): Promise<DeleteResult> {
    if (this.failDeletes) {
      return Promise.resolve({
        failed: keys.map((key) => ({ key, error: 'InternalError' })),
      });
    }
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve({ failed: [] });
  }

  uploadUrl(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<UploadUrl> {
    this.uploadKeys.push(input.key);
    return Promise.resolve({
      url: `https://bucket.test/${input.key}?signed=1`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    });
  }

  downloadUrl(input: {
    key: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }> {
    return Promise.resolve({
      url: `https://cdn.test/${input.key}?Signature=fake`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    });
  }

  keysUnder(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
}
