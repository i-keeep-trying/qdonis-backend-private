import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

import { durationToMs } from './duration';

/**
 * Recognised runtime environments.
 */
export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum CookieSameSite {
  Lax = 'lax',
  Strict = 'strict',
  None = 'none',
}

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
}

/**
 * `smtp` sends real mail (Gmail SMTP in this project). `log` writes messages,
 * links included, to the application log and is refused in production.
 */
export enum MailTransportKind {
  Smtp = 'smtp',
  Log = 'log',
}

/** `"1" | "true" | "yes" | "on"` (case-insensitive) become `true`. */
const toBoolean = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

const toInteger = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || value.trim() === '') return value;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  });

/** A duration accepted by `jsonwebtoken`, e.g. `15m`, `7d`, `3600s` or `900`. */
const DURATION_PATTERN = /^\d+(ms|s|m|h|d|w|y)?$/;
const DURATION_MESSAGE = 'must look like 900, 900s, 15m, 2h or 7d';

/** Minimum secret length: 32 chars of base64url is ~192 bits of entropy. */
const SECRET_MIN_LENGTH = 32;

/** An AWS region id, e.g. `us-east-1` or `us-gov-west-1`. */
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/** Values from `.env.example` that must never reach production. */
const PLACEHOLDER_PATTERN = /replace-me|changeme|change-me|example|secret123/i;

/**
 * The complete set of environment variables the application understands.
 *
 * Validation happens once at boot (see {@link validateEnv}); a malformed
 * environment fails fast with a readable report rather than surfacing as an
 * obscure runtime error later on.
 */
export class EnvironmentVariables {
  // --- runtime -------------------------------------------------------------
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @toInteger()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  API_PREFIX: string = 'api/v1';

  /**
   * Public URL of the web app. Used for links in emails and as the landing
   * page after Google sign-in. Must be one of `CORS_ORIGINS`.
   */
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  FRONTEND_URL!: string;

  /**
   * Number of reverse-proxy hops to trust for `X-Forwarded-*`, or `0` when the
   * app is exposed directly. `req.ip` (rate limiting, session audit) and secure
   * cookies depend on this being right.
   */
  @toInteger()
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS: number = 0;

  /** Max JSON / urlencoded body size, in `bytes` format (e.g. `100kb`, `1mb`). */
  @Matches(/^\d+(b|kb|mb)$/i, {
    message: 'BODY_LIMIT must look like 100kb or 1mb',
  })
  BODY_LIMIT: string = '1mb';

  /**
   * DEV-LAYOUT: the developer schematic layout tool (writes library layouts
   * into `assets/`). Development only; never enabled in production.
   */
  @toBoolean()
  @IsBoolean()
  SCHEMATIC_LAYOUT_TOOL: boolean = false;

  /** Server-side request timeout; slow or stalled clients are cut off. */
  @toInteger()
  @IsInt()
  @Min(1_000)
  REQUEST_TIMEOUT_MS: number = 30_000;

  // --- database ------------------------------------------------------------
  @IsString()
  @IsNotEmpty()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL!: string;

  @toInteger()
  @IsInt()
  @Min(1)
  @Max(1000)
  DATABASE_POOL_MAX: number = 10;

  @toInteger()
  @IsInt()
  @Min(0)
  DATABASE_POOL_IDLE_TIMEOUT_MS: number = 30_000;

  @toInteger()
  @IsInt()
  @Min(0)
  DATABASE_CONNECTION_TIMEOUT_MS: number = 10_000;

  @toInteger()
  @IsInt()
  @Min(1)
  @Max(16_000)
  EMBEDDING_DIMENSIONS: number = 1536;

  // --- auth: tokens --------------------------------------------------------
  @IsString()
  @MinLength(SECRET_MIN_LENGTH, {
    message: `JWT_ACCESS_SECRET must be at least ${SECRET_MIN_LENGTH} characters`,
  })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @Matches(DURATION_PATTERN, { message: `JWT_ACCESS_TTL ${DURATION_MESSAGE}` })
  JWT_ACCESS_TTL: string = '15m';

  /**
   * Lifetime of one refresh token. Refresh tokens are opaque random values
   * looked up by hash, so they need no signing secret; each rotation issues a
   * fresh one, bounded by AUTH_SESSION_ABSOLUTE_TTL.
   */
  @IsString()
  @Matches(DURATION_PATTERN, {
    message: `REFRESH_TOKEN_TTL ${DURATION_MESSAGE}`,
  })
  REFRESH_TOKEN_TTL: string = '7d';

  /** Signs the short-lived OAuth state cookie (CSRF state + PKCE verifier). */
  @IsString()
  @MinLength(SECRET_MIN_LENGTH, {
    message: `OAUTH_STATE_SECRET must be at least ${SECRET_MIN_LENGTH} characters`,
  })
  OAUTH_STATE_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ISSUER: string = 'qdonis-api';

  @IsString()
  @IsNotEmpty()
  JWT_AUDIENCE: string = 'qdonis-web';

  // --- auth: policy --------------------------------------------------------
  /** Hard cap on a login's lifetime, however often it is refreshed. */
  @IsString()
  @Matches(DURATION_PATTERN, {
    message: `AUTH_SESSION_ABSOLUTE_TTL ${DURATION_MESSAGE}`,
  })
  AUTH_SESSION_ABSOLUTE_TTL: string = '30d';

  /**
   * Window in which presenting a just-rotated refresh token is treated as a
   * benign race (two tabs refreshing at once) instead of token theft.
   */
  @toInteger()
  @IsInt()
  @Min(0)
  @Max(60)
  AUTH_REFRESH_REUSE_GRACE_SECONDS: number = 10;

  @toInteger()
  @IsInt()
  @Min(1)
  @Max(100)
  AUTH_MAX_SESSIONS_PER_USER: number = 10;

  /** Refuse password login until the email address is verified. */
  @toBoolean()
  @IsBoolean()
  AUTH_REQUIRE_VERIFIED_EMAIL: boolean = true;

  @toInteger()
  @IsInt()
  @Min(1)
  @Max(100)
  AUTH_LOCKOUT_THRESHOLD: number = 5;

  @toInteger()
  @IsInt()
  @Min(1_000)
  AUTH_LOCKOUT_DURATION_MS: number = 15 * 60_000;

  @IsString()
  @Matches(DURATION_PATTERN, {
    message: `AUTH_EMAIL_VERIFICATION_TTL ${DURATION_MESSAGE}`,
  })
  AUTH_EMAIL_VERIFICATION_TTL: string = '24h';

  @IsString()
  @Matches(DURATION_PATTERN, {
    message: `AUTH_PASSWORD_RESET_TTL ${DURATION_MESSAGE}`,
  })
  AUTH_PASSWORD_RESET_TTL: string = '30m';

  /** Minimum gap between two verification/reset emails for one account. */
  @toInteger()
  @IsInt()
  @Min(0)
  AUTH_EMAIL_COOLDOWN_SECONDS: number = 60;

  /** How often expired sessions and tokens are purged. `0` disables it. */
  @toInteger()
  @IsInt()
  @Min(0)
  AUTH_CLEANUP_INTERVAL_MS: number = 60 * 60_000;

  // --- auth: Google OAuth --------------------------------------------------
  @toBoolean()
  @IsBoolean()
  GOOGLE_OAUTH_ENABLED: boolean = true;

  @IsOptional()
  @IsString()
  @Matches(/\.apps\.googleusercontent\.com$/, {
    message: 'GOOGLE_CLIENT_ID must end with .apps.googleusercontent.com',
  })
  GOOGLE_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  GOOGLE_CLIENT_SECRET?: string;

  /**
   * Must exactly match an "Authorized redirect URI" in Google Cloud Console,
   * e.g. https://api.example.com/api/v1/auth/google/callback
   */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  GOOGLE_REDIRECT_URI?: string;

  // --- Stripe --------------------------------------------------------------
  /** `sk_live_...` / `sk_test_...`, or a restricted key `rk_...`. */
  @IsOptional()
  @IsString()
  @Matches(/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/, {
    message: 'STRIPE_SECRET_KEY must look like sk_test_... or sk_live_...',
  })
  STRIPE_SECRET_KEY?: string;

  /** Signing secret of the webhook endpoint (`whsec_...`). */
  @IsOptional()
  @IsString()
  @Matches(/^whsec_[A-Za-z0-9]+$/, {
    message: 'STRIPE_WEBHOOK_SECRET must look like whsec_...',
  })
  STRIPE_WEBHOOK_SECRET?: string;

  // --- AI (AWS Bedrock) ------------------------------------------------------
  /**
   * Auth: the AWS key pair (SigV4) wins when both are set; otherwise
   * BEDROCK_API_KEY (bearer); with neither, AI endpoints answer 503.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{16,128}$/, {
    message: 'AWS_ACCESS_KEY_ID must be 16-128 uppercase letters or digits',
  })
  AWS_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  @MinLength(16)
  AWS_SECRET_ACCESS_KEY?: string;

  /** Region fallback for Bedrock when BEDROCK_REGION is unset. */
  @IsOptional()
  @Matches(REGION_PATTERN, { message: 'AWS_REGION must look like us-east-1' })
  AWS_REGION?: string;

  /** Bedrock API key (bearer), used only when the AWS key pair is unset. */
  @IsOptional()
  @IsString()
  @MinLength(20)
  BEDROCK_API_KEY?: string;

  /** Region precedence: BEDROCK_REGION, then AWS_REGION, then us-east-1. */
  @IsOptional()
  @Matches(REGION_PATTERN, {
    message: 'BEDROCK_REGION must look like us-east-1',
  })
  BEDROCK_REGION?: string;

  /** Comma-separated allowlist; the first is the default model. */
  @IsString()
  @IsNotEmpty()
  BEDROCK_ALLOWED_MODELS: string =
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0,anthropic.claude-sonnet-4-5-20250929-v1:0';

  /** Model for project-name generation (must be in the allowlist); unset = the default model. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  BEDROCK_NAMING_MODEL?: string;

  @toInteger()
  @IsInt()
  @Min(256)
  @Max(128_000)
  BEDROCK_MAX_OUTPUT_TOKENS: number = 64_000;

  @toInteger()
  @IsInt()
  @Min(10_000)
  @Max(900_000)
  BEDROCK_TIMEOUT_MS: number = 600_000;

  // --- file storage (S3 + CloudFront) ---------------------------------------
  /** Private bucket for uploads, stage payloads and exports. Unset = storage off. */
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, {
    message: 'S3_BUCKET must be a valid S3 bucket name',
  })
  S3_BUCKET?: string;

  /** Bucket region; falls back to AWS_REGION, then us-east-1. */
  @IsOptional()
  @Matches(REGION_PATTERN, { message: 'S3_REGION must look like us-east-1' })
  S3_REGION?: string;

  /** Optional key prefix shared by every object, e.g. `prod/`. */
  @Matches(/^([A-Za-z0-9_-]+\/)*$/, {
    message:
      'S3_KEY_PREFIX must be empty or like `prod/` (segments ending in /)',
  })
  S3_KEY_PREFIX: string = '';

  /** Custom endpoint for S3-compatible stores in development (MinIO, LocalStack). */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  S3_ENDPOINT?: string;

  /** Distribution in front of the bucket (origin access control), e.g. https://cdn.example.com */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['https'] })
  CLOUDFRONT_DOMAIN?: string;

  /** Public key id of the distribution's trusted key group. */
  @IsOptional()
  @Matches(/^[A-Z0-9]{8,32}$/, {
    message: 'CLOUDFRONT_KEY_PAIR_ID must look like K2JCJMDEHXQW5F',
  })
  CLOUDFRONT_KEY_PAIR_ID?: string;

  /** RSA private key (PEM, `\n` escapes allowed, or base64 of the PEM). */
  @IsOptional()
  @IsString()
  @MinLength(64)
  CLOUDFRONT_PRIVATE_KEY?: string;

  /** Lifetime of signed download and upload URLs. */
  @toInteger()
  @IsInt()
  @Min(60)
  @Max(86_400)
  STORAGE_URL_TTL_SECONDS: number = 900;

  /** How often queued S3 deletions and abandoned uploads are cleaned; 0 = off. */
  @toInteger()
  @IsInt()
  @Min(0)
  STORAGE_SWEEP_INTERVAL_MS: number = 300_000;

  // --- component suppliers ----------------------------------------------------
  /** Mouser Search API key (server-side only). Unset = sourcing answers 503. */
  @IsOptional()
  @IsString()
  @MinLength(16)
  MOUSER_API_KEY?: string;

  /** Mouser's per-key limits (fleet-wide, counted in the database). */
  @toInteger()
  @IsInt()
  @Min(1)
  @Max(1_000)
  MOUSER_CALLS_PER_MINUTE: number = 30;

  @toInteger()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  MOUSER_CALLS_PER_DAY: number = 1_000;

  @toInteger()
  @IsInt()
  @Min(0)
  @Max(720)
  MOUSER_CACHE_HOURS: number = 24;

  // --- simulation (ngspice) ---------------------------------------------------
  /** ngspice executable (path or name on PATH). */
  @IsString()
  @MinLength(1)
  NGSPICE_PATH: string = 'ngspice';

  /** Wall-clock limit of one ngspice analysis run. */
  @toInteger()
  @IsInt()
  @Min(10)
  @Max(3_600)
  NGSPICE_TIMEOUT_SECONDS: number = 300;

  /** Simulations running at once on this instance; extra runs wait. */
  @toInteger()
  @IsInt()
  @Min(1)
  @Max(64)
  SIMULATION_CONCURRENCY: number = 2;

  // --- mail ----------------------------------------------------------------
  @IsEnum(MailTransportKind)
  MAIL_TRANSPORT: MailTransportKind = MailTransportKind.Log;

  /** e.g. `Qdonis <no-reply@yourdomain.com>` or the Gmail address itself. */
  @IsOptional()
  @IsString()
  @MaxLength(320)
  MAIL_FROM?: string;

  @IsString()
  SMTP_HOST: string = 'smtp.gmail.com';

  /** 465 = implicit TLS (`SMTP_SECURE=true`), 587 = STARTTLS (`false`). */
  @toInteger()
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number = 465;

  @toBoolean()
  @IsBoolean()
  SMTP_SECURE: boolean = true;

  @IsOptional()
  @IsEmail()
  SMTP_USER?: string;

  /** Gmail: a 16-character App Password, not the account password. */
  @IsOptional()
  @IsString()
  SMTP_PASSWORD?: string;

  // --- cookies -------------------------------------------------------------
  @toBoolean()
  @IsBoolean()
  COOKIE_SECURE: boolean = false;

  @IsEnum(CookieSameSite)
  COOKIE_SAME_SITE: CookieSameSite = CookieSameSite.Lax;

  @IsOptional()
  @IsString()
  COOKIE_DOMAIN?: string;

  // --- CORS ----------------------------------------------------------------
  @IsString()
  CORS_ORIGINS: string = '';

  // --- rate limiting -------------------------------------------------------
  @toInteger()
  @IsInt()
  @Min(1)
  THROTTLE_TTL_MS: number = 60_000;

  @toInteger()
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 100;

  @toInteger()
  @IsInt()
  @Min(1)
  AUTH_THROTTLE_TTL_MS: number = 60_000;

  @toInteger()
  @IsInt()
  @Min(1)
  AUTH_THROTTLE_LIMIT: number = 10;

  // --- logging -------------------------------------------------------------
  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @toBoolean()
  @IsBoolean()
  LOG_PRETTY: boolean = false;

  // --- API docs ------------------------------------------------------------
  @toBoolean()
  @IsBoolean()
  SWAGGER_ENABLED: boolean = true;

  @IsString()
  SWAGGER_PATH: string = 'docs';
}

/**
 * Rules spanning several variables, which decorators cannot express. Returns
 * human-readable problems; an empty list means the configuration is coherent.
 */
export function crossValidate(env: EnvironmentVariables): string[] {
  const problems: string[] = [];
  const isProduction = env.NODE_ENV === NodeEnvironment.Production;

  if (env.JWT_ACCESS_SECRET === env.OAUTH_STATE_SECRET) {
    problems.push('JWT_ACCESS_SECRET and OAUTH_STATE_SECRET must be different');
  }

  const accessMs = durationToMs(env.JWT_ACCESS_TTL);
  const refreshMs = durationToMs(env.REFRESH_TOKEN_TTL);
  const absoluteMs = durationToMs(env.AUTH_SESSION_ABSOLUTE_TTL);
  if (accessMs < 60_000 || accessMs > 60 * 60_000) {
    problems.push('JWT_ACCESS_TTL must be between 1m and 1h');
  }
  if (refreshMs <= accessMs) {
    problems.push('REFRESH_TOKEN_TTL must be longer than JWT_ACCESS_TTL');
  }
  if (absoluteMs < refreshMs) {
    problems.push(
      'AUTH_SESSION_ABSOLUTE_TTL must be at least REFRESH_TOKEN_TTL',
    );
  }

  if (env.COOKIE_SAME_SITE === CookieSameSite.None && !env.COOKIE_SECURE) {
    problems.push(
      'COOKIE_SAME_SITE=none requires COOKIE_SECURE=true (browsers reject it otherwise)',
    );
  }

  const origins = parseOrigins(env.CORS_ORIGINS);
  if (origins.includes('*')) {
    problems.push(
      'CORS_ORIGINS cannot contain "*" because credentials are enabled',
    );
  }
  const frontendOrigin = safeOrigin(env.FRONTEND_URL);
  if (frontendOrigin && !origins.includes(frontendOrigin)) {
    problems.push(
      `FRONTEND_URL origin (${frontendOrigin}) must be listed in CORS_ORIGINS`,
    );
  }

  if (env.GOOGLE_OAUTH_ENABLED) {
    const googleVars = {
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI,
    };
    const missing = Object.entries(googleVars)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    // Outside production a half-configured Google login only disables the
    // endpoints (they answer 503), so local work is not blocked on credentials.
    if (isProduction && missing.length > 0) {
      problems.push(
        `GOOGLE_OAUTH_ENABLED=true requires ${missing.join(', ')} (or set GOOGLE_OAUTH_ENABLED=false)`,
      );
    }
  }

  if (env.MAIL_TRANSPORT === MailTransportKind.Smtp) {
    for (const [key, value] of Object.entries({
      SMTP_USER: env.SMTP_USER,
      SMTP_PASSWORD: env.SMTP_PASSWORD,
      MAIL_FROM: env.MAIL_FROM,
    })) {
      if (!value) problems.push(`MAIL_TRANSPORT=smtp requires ${key}`);
    }
  }

  if (Boolean(env.STRIPE_SECRET_KEY) !== Boolean(env.STRIPE_WEBHOOK_SECRET)) {
    problems.push(
      'Set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or neither',
    );
  }

  if (env.BEDROCK_ALLOWED_MODELS.split(',').every((model) => !model.trim())) {
    problems.push('BEDROCK_ALLOWED_MODELS must list at least one model id');
  }

  if (
    env.BEDROCK_NAMING_MODEL &&
    !env.BEDROCK_ALLOWED_MODELS.split(',')
      .map((model) => model.trim())
      .includes(env.BEDROCK_NAMING_MODEL.trim())
  ) {
    problems.push('BEDROCK_NAMING_MODEL must be one of BEDROCK_ALLOWED_MODELS');
  }

  if (Boolean(env.AWS_ACCESS_KEY_ID) !== Boolean(env.AWS_SECRET_ACCESS_KEY)) {
    problems.push(
      'Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither',
    );
  }

  const cloudFront = [
    env.CLOUDFRONT_DOMAIN,
    env.CLOUDFRONT_KEY_PAIR_ID,
    env.CLOUDFRONT_PRIVATE_KEY,
  ].filter(Boolean).length;
  if (cloudFront !== 0 && cloudFront !== 3) {
    problems.push(
      'Set all of CLOUDFRONT_DOMAIN, CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY, or none',
    );
  }
  if (cloudFront === 3 && !env.S3_BUCKET) {
    problems.push('CLOUDFRONT_* requires S3_BUCKET');
  }

  if (isProduction) {
    if (!env.S3_BUCKET || cloudFront !== 3) {
      problems.push(
        'File storage is required in production: S3_BUCKET and CLOUDFRONT_DOMAIN, CLOUDFRONT_KEY_PAIR_ID, CLOUDFRONT_PRIVATE_KEY',
      );
    }
    if (env.S3_ENDPOINT) {
      problems.push('S3_ENDPOINT is for local development only');
    }
    if (!env.BEDROCK_API_KEY && !env.AWS_ACCESS_KEY_ID) {
      problems.push(
        'Bedrock credentials are required in production: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or BEDROCK_API_KEY',
      );
    }
    if (!env.STRIPE_SECRET_KEY) {
      problems.push(
        'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required in production',
      );
    } else if (env.STRIPE_SECRET_KEY.includes('_test_')) {
      problems.push(
        'STRIPE_SECRET_KEY is a test-mode key; use a live key in production',
      );
    }
    if (env.MAIL_TRANSPORT !== MailTransportKind.Smtp) {
      problems.push(
        'MAIL_TRANSPORT must be smtp in production (the log transport would write reset links to logs)',
      );
    }
    if (!env.COOKIE_SECURE) {
      problems.push('COOKIE_SECURE must be true in production');
    }
    for (const [key, value] of Object.entries({
      JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET,
      OAUTH_STATE_SECRET: env.OAUTH_STATE_SECRET,
    })) {
      if (PLACEHOLDER_PATTERN.test(value)) {
        problems.push(
          `${key} still holds a placeholder value; generate a random secret`,
        );
      }
    }
    if (!env.FRONTEND_URL.startsWith('https://')) {
      problems.push('FRONTEND_URL must use https in production');
    }
    if (
      env.GOOGLE_REDIRECT_URI &&
      !env.GOOGLE_REDIRECT_URI.startsWith('https://')
    ) {
      problems.push('GOOGLE_REDIRECT_URI must use https in production');
    }
  }

  return problems;
}

export function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Optional variables for which an empty value is meaningful. */
const BLANK_ALLOWED = new Set(['COOKIE_DOMAIN']);

/**
 * `validate` hook for `ConfigModule.forRoot`.
 *
 * Empty strings are stripped so that a blank entry in `.env` falls back to the
 * class default instead of failing an `@IsInt()` style check.
 */
export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const isBlank = typeof value === 'string' && value.trim() === '';
    if (isBlank && !BLANK_ALLOWED.has(key)) continue;
    cleaned[key] = value;
  }

  const config = plainToInstance(EnvironmentVariables, cleaned, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, {
    skipMissingProperties: false,
    whitelist: false,
    forbidNonWhitelisted: false,
  });

  const report = errors.map((error) => {
    const constraints = Object.values(error.constraints ?? {}).join('; ');
    return `  - ${error.property}: ${constraints || 'invalid value'}`;
  });

  // Cross-field rules only make sense once every field is individually valid.
  if (report.length === 0) {
    report.push(...crossValidate(config).map((problem) => `  - ${problem}`));
  }

  if (report.length > 0) {
    throw new Error(`Invalid environment configuration:\n${report.join('\n')}`);
  }

  return config;
}
