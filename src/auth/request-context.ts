import type { Request } from 'express';

import type { SessionContext } from './auth.types';

/** Audit metadata for a session. `req.ip` honours the `trust proxy` setting. */
export function sessionContext(request: Request): SessionContext {
  return {
    userAgent: request.get('user-agent') ?? undefined,
    ipAddress: request.ip,
  };
}

/** Raw bearer token from the Authorization header, if any. */
export function bearerToken(request: Request): string | null {
  const header = request.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** First string value of a query parameter; repeated or nested values are ignored. */
export function queryString(
  value: unknown,
  maxLength = 2048,
): string | undefined {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.length <= maxLength
    ? first
    : undefined;
}

/**
 * Accepts only same-site relative paths ("/projects/1?tab=x"), so the OAuth
 * return target can never become an open redirect to another host.
 */
export function safeReturnTo(value: unknown): string {
  const path = queryString(value, 512);
  if (!path) return '/';
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\'))
    return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return '/';
  return path;
}
