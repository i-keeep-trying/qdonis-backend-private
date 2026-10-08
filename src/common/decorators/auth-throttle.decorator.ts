import { SetMetadata } from '@nestjs/common';

export const AUTH_THROTTLE_KEY = 'throttle:auth';

/** Name of the tighter throttler bucket configured in AppModule. */
export const AUTH_THROTTLER = 'auth';

/**
 * Puts a route in the tight `auth` rate-limit bucket (AUTH_THROTTLE_LIMIT per
 * AUTH_THROTTLE_TTL_MS per IP) on top of the global one. Use on every
 * credential or email-sending endpoint.
 */
export const AuthThrottle = () => SetMetadata(AUTH_THROTTLE_KEY, true);
