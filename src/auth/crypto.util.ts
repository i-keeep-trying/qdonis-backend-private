import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits from the CSPRNG, base64url encoded (43 chars). */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 hex digest. Appropriate for high-entropy random tokens (not
 * passwords): they cannot be brute-forced, so no salt or stretching is needed,
 * and the digest can be looked up through a unique index.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that tolerates different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/** RFC 7636 S256 code challenge for a PKCE verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
