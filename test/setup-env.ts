/**
 * Runs before any test module is imported. ConfigModule validates the
 * environment when AppModule is first imported, and never overrides variables
 * that are already set, so these win over `.env`.
 *
 * Point E2E_DATABASE_URL at a disposable, migrated database:
 *   $env:DATABASE_URL="<url>"; npx prisma migrate deploy
 */
import { randomBytes } from 'node:crypto';

const secret = (): string => randomBytes(48).toString('base64url');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5433/qdonis_test?schema=public',
  API_PREFIX: 'api/v1',
  FRONTEND_URL: 'http://localhost:5173',
  CORS_ORIGINS: 'http://localhost:5173',
  JWT_ACCESS_SECRET: secret(),
  OAUTH_STATE_SECRET: secret(),
  JWT_ACCESS_TTL: '15m',
  REFRESH_TOKEN_TTL: '7d',
  AUTH_SESSION_ABSOLUTE_TTL: '30d',
  AUTH_REFRESH_REUSE_GRACE_SECONDS: '1',
  AUTH_REQUIRE_VERIFIED_EMAIL: 'true',
  AUTH_LOCKOUT_THRESHOLD: '5',
  AUTH_LOCKOUT_DURATION_MS: '900000',
  AUTH_MAX_SESSIONS_PER_USER: '3',
  AUTH_EMAIL_COOLDOWN_SECONDS: '0',
  AUTH_THROTTLE_LIMIT: '10000',
  THROTTLE_LIMIT: '10000',
  MAIL_TRANSPORT: 'log',
  GOOGLE_OAUTH_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'e2e-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/google/callback',
  COOKIE_SECURE: 'false',
  COOKIE_SAME_SITE: 'lax',
  SWAGGER_ENABLED: 'false',
  // Fake credentials: API calls are stubbed in tests; the webhook secret is
  // real enough to sign and verify events locally.
  BEDROCK_API_KEY: 'e2e-bedrock-key-000000000000',
  // Set so the real AWS keys in `.env` never load in tests.
  AWS_ACCESS_KEY_ID: 'AKIAE2EFAKEKEY000000',
  AWS_SECRET_ACCESS_KEY: 'e2e-fake-secret-0000000000000000',
  AWS_REGION: 'us-east-1',
  BODY_LIMIT: '5mb',
  STRIPE_SECRET_KEY: 'sk_test_e2eFakeKey000000000000',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2eWebhookSecret0000000000',
});
