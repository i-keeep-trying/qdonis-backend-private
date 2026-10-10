import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as signCloudFrontUrl } from '@aws-sdk/cloudfront-signer';
import { getSignedUrl as presignS3 } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { AppConfiguration } from '../config/configuration';
import {
  type DeleteResult,
  type ObjectHead,
  ObjectNotFoundError,
  ObjectStore,
  type PutObjectInput,
  type UploadUrl,
} from './object-store';

/** S3 accepts at most 1,000 keys per DeleteObjects call. */
const DELETE_BATCH = 1_000;

const encodeKey = (key: string): string =>
  key.split('/').map(encodeURIComponent).join('/');

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Private S3 bucket. Downloads are CloudFront signed URLs (canned policy);
 * without CloudFront (development only, enforced by env validation) they fall
 * back to S3 presigned GETs. Uploads are S3 presigned PUTs.
 */
@Injectable()
export class S3ObjectStore extends ObjectStore implements OnModuleDestroy {
  private readonly logger = new Logger(S3ObjectStore.name);
  private client?: S3Client;

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {
    super();
  }

  onModuleDestroy(): void {
    this.client?.destroy();
  }

  private settings(): AppConfiguration['storage'] {
    return this.config.get('storage', { infer: true });
  }

  private bucket(): string {
    const { bucket } = this.settings();
    if (!bucket) {
      throw AppError.unavailable(
        ErrorCode.StorageNotConfigured,
        'File storage is not configured on this server',
      );
    }
    return bucket;
  }

  private s3(): S3Client {
    if (this.client) return this.client;
    const s = this.settings();
    this.client = new S3Client({
      region: s.region,
      maxAttempts: 3,
      ...(s.endpoint ? { endpoint: s.endpoint, forcePathStyle: true } : {}),
      // Explicit key pair when configured; otherwise the default chain
      // (instance/task role), which is the recommended setup on AWS.
      ...(s.accessKeyId && s.secretAccessKey
        ? {
            credentials: {
              accessKeyId: s.accessKeyId,
              secretAccessKey: s.secretAccessKey,
            },
          }
        : {}),
    });
    return this.client;
  }

  private fail(operation: string, key: string, error: unknown): never {
    this.logger.error(`S3 ${operation} failed for ${key}: ${describe(error)}`);
    throw AppError.badGateway(
      ErrorCode.StorageError,
      'File storage is temporarily unavailable; please retry',
    );
  }

  async put(input: PutObjectInput): Promise<void> {
    const Bucket = this.bucket();
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.body.length,
          ContentDisposition: input.contentDisposition,
          ServerSideEncryption: 'AES256',
        }),
      );
    } catch (error) {
      this.fail('put', input.key, error);
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const Bucket = this.bucket();
    try {
      const output = await this.s3().send(
        new HeadObjectCommand({ Bucket, Key: key }),
      );
      return {
        sizeBytes: output.ContentLength ?? 0,
        contentType: output.ContentType,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      this.fail('head', key, error);
    }
  }

  async get(key: string): Promise<Buffer> {
    const Bucket = this.bucket();
    try {
      const output = await this.s3().send(
        new GetObjectCommand({ Bucket, Key: key }),
      );
      if (!output.Body) throw new ObjectNotFoundError(key);
      return Buffer.from(await output.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw error;
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      this.fail('get', key, error);
    }
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    const Bucket = this.bucket();
    try {
      await this.s3().send(
        new CopyObjectCommand({
          Bucket,
          Key: targetKey,
          CopySource: `${Bucket}/${encodeKey(sourceKey)}`,
          ServerSideEncryption: 'AES256',
        }),
      );
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(sourceKey);
      this.fail('copy', sourceKey, error);
    }
  }

  async delete(keys: string[]): Promise<DeleteResult> {
    const Bucket = this.bucket();
    const failed: DeleteResult['failed'] = [];
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      try {
        const output = await this.s3().send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        for (const e of output.Errors ?? []) {
          if (e.Key && e.Code !== 'NoSuchKey') {
            failed.push({ key: e.Key, error: e.Code ?? 'unknown' });
          }
        }
      } catch (error) {
        const message = describe(error);
        for (const key of batch) failed.push({ key, error: message });
      }
    }
    return { failed };
  }

  async uploadUrl(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<UploadUrl> {
    const Bucket = this.bucket();
    const command = new PutObjectCommand({
      Bucket,
      Key: input.key,
      ContentType: input.contentType,
      ServerSideEncryption: 'AES256',
    });
    try {
      const url = await presignS3(this.s3(), command, {
        expiresIn: input.expiresInSeconds,
        // Keep these as signed headers so the client cannot change them.
        unhoistableHeaders: new Set([
          'content-type',
          'x-amz-server-side-encryption',
        ]),
      });
      return {
        url,
        method: 'PUT',
        headers: {
          'Content-Type': input.contentType,
          'x-amz-server-side-encryption': 'AES256',
        },
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000),
      };
    } catch (error) {
      this.fail('presign-put', input.key, error);
    }
  }

  async downloadUrl(input: {
    key: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }> {
    const Bucket = this.bucket();
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000);
    const { cloudFront } = this.settings();
    if (cloudFront) {
      const url = signCloudFrontUrl({
        url: `${cloudFront.domain}/${encodeKey(input.key)}`,
        keyPairId: cloudFront.keyPairId,
        privateKey: cloudFront.privateKey,
        dateLessThan: expiresAt.toISOString(),
      });
      return { url, expiresAt };
    }
    try {
      const url = await presignS3(
        this.s3(),
        new GetObjectCommand({ Bucket, Key: input.key }),
        { expiresIn: input.expiresInSeconds },
      );
      return { url, expiresAt };
    } catch (error) {
      this.fail('presign-get', input.key, error);
    }
  }
}
