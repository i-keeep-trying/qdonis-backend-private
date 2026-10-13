import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, base64url (43 characters). */
export const newOpaqueToken = (): string =>
  randomBytes(32).toString('base64url');

/**
 * Lookup hash of a high-entropy token. A fast hash is fine here (unlike
 * passwords): the input is 256 random bits, so it cannot be brute-forced.
 */
export const hashOpaqueToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;
