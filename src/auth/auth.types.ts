import type { Role } from '../generated/prisma/enums';

/** Cookie carrying the refresh token. Never readable from JavaScript. */
export const REFRESH_TOKEN_COOKIE = 'qd_refresh';

/**
 * Claims carried by the short-lived access token.
 *
 * `sid` binds the stateless token to a `Session` row, which is what lets a
 * token be rejected as soon as its session is revoked. No PII is embedded.
 */
export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  /** Session id. */
  sid: string;
  role: Role;
  type: 'access';
}

/**
 * The value attached to `request.user` by the JWT strategy and surfaced through
 * the `@CurrentUser()` decorator. Loaded from the database on every request,
 * so role and status changes apply immediately.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  /** Session the current request authenticated against. */
  sessionId: string;
  /** Login (rotation chain) that session belongs to. */
  familyId: string;
}

/** Request metadata recorded against a session for auditing. */
export interface SessionContext {
  userAgent?: string;
  ipAddress?: string;
}
