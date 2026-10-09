import { durationToMs, durationToSeconds } from './duration';
import {
  type CookieSameSite,
  type LogLevel,
  type MailTransportKind,
  NodeEnvironment,
  parseOrigins,
  validateEnv,
} from './env.validation';

/**
 * Shape of the validated, structured configuration exposed through
 * `ConfigService<AppConfiguration, true>`.
 *
 * Grouping values by concern keeps injection sites readable and means a
 * feature module never has to know the underlying environment variable names.
 */
export interface AppConfiguration {
  app: {
    nodeEnv: NodeEnvironment;
    isProduction: boolean;
    isTest: boolean;
    port: number;
    /** No leading or trailing slash, e.g. `api/v1`. */
    apiPrefix: string;
    /** No trailing slash. */
    frontendUrl: string;
    trustProxyHops: number;
    bodyLimit: string;
    requestTimeoutMs: number;
  };
  database: {
    url: string;
    poolMax: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
    embeddingDimensions: number;
  };
  auth: {
    accessSecret: string;
    accessTtlSeconds: number;
    refreshTtlMs: number;
    oauthStateSecret: string;
    issuer: string;
    audience: string;
    sessionAbsoluteTtlMs: number;
    refreshReuseGraceMs: number;
    maxSessionsPerUser: number;
    requireVerifiedEmail: boolean;
    lockoutThreshold: number;
    lockoutDurationMs: number;
    emailVerificationTtlMs: number;
    passwordResetTtlMs: number;
    emailCooldownMs: number;
    cleanupIntervalMs: number;
  };
  google: {
    enabled: boolean;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  stripe: {
    secretKey?: string;
    webhookSecret?: string;
  };
  bedrock: {
    /** `sigv4` = AWS key pair, `bearer` = BEDROCK_API_KEY, `none` = AI off. */
    authMode: BedrockAuthMode;
    accessKeyId?: string;
    secretAccessKey?: string;
    apiKey?: string;
    /** BEDROCK_REGION, else AWS_REGION, else `us-east-1`. */
    region: string;
    allowedModels: string[];
    maxOutputTokens: number;
    timeoutMs: number;
  };
  mail: {
    transport: MailTransportKind;
    from?: string;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
    };
  };
  cookies: {
    secure: boolean;
    sameSite: CookieSameSite;
    domain?: string;
  };
  cors: {
    origins: string[];
  };
  throttle: {
    ttlMs: number;
    limit: number;
    authTtlMs: number;
    authLimit: number;
  };
  logging: {
    level: LogLevel;
    pretty: boolean;
  };
  swagger: {
    enabled: boolean;
    path: string;
  };
}

export type BedrockAuthMode = 'sigv4' | 'bearer' | 'none';

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

/** The AWS key pair wins over the bearer API key; neither means AI is off. */
function bedrockAuthMode(env: {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  BEDROCK_API_KEY?: string;
}): BedrockAuthMode {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return 'sigv4';
  if (env.BEDROCK_API_KEY) return 'bearer';
  return 'none';
}

/**
 * Maps the environment onto {@link AppConfiguration}.
 *
 * Re-runs the (pure, cheap) validation so every value here is typed and
 * defaulted by `EnvironmentVariables`, rather than re-parsing raw strings.
 */
export function configuration(): AppConfiguration {
  const env = validateEnv(process.env);

  return {
    app: {
      nodeEnv: env.NODE_ENV,
      isProduction: env.NODE_ENV === NodeEnvironment.Production,
      isTest: env.NODE_ENV === NodeEnvironment.Test,
      port: env.PORT,
      apiPrefix: trimSlashes(env.API_PREFIX),
      frontendUrl: env.FRONTEND_URL.replace(/\/+$/, ''),
      trustProxyHops: env.TRUST_PROXY_HOPS,
      bodyLimit: env.BODY_LIMIT,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    },
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      idleTimeoutMs: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
      embeddingDimensions: env.EMBEDDING_DIMENSIONS,
    },
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtlSeconds: durationToSeconds(env.JWT_ACCESS_TTL),
      refreshTtlMs: durationToMs(env.REFRESH_TOKEN_TTL),
      oauthStateSecret: env.OAUTH_STATE_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      sessionAbsoluteTtlMs: durationToMs(env.AUTH_SESSION_ABSOLUTE_TTL),
      refreshReuseGraceMs: env.AUTH_REFRESH_REUSE_GRACE_SECONDS * 1_000,
      maxSessionsPerUser: env.AUTH_MAX_SESSIONS_PER_USER,
      requireVerifiedEmail: env.AUTH_REQUIRE_VERIFIED_EMAIL,
      lockoutThreshold: env.AUTH_LOCKOUT_THRESHOLD,
      lockoutDurationMs: env.AUTH_LOCKOUT_DURATION_MS,
      emailVerificationTtlMs: durationToMs(env.AUTH_EMAIL_VERIFICATION_TTL),
      passwordResetTtlMs: durationToMs(env.AUTH_PASSWORD_RESET_TTL),
      emailCooldownMs: env.AUTH_EMAIL_COOLDOWN_SECONDS * 1_000,
      cleanupIntervalMs: env.AUTH_CLEANUP_INTERVAL_MS,
    },
    google: {
      enabled: env.GOOGLE_OAUTH_ENABLED,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    },
    bedrock: {
      authMode: bedrockAuthMode(env),
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      apiKey: env.BEDROCK_API_KEY,
      region: env.BEDROCK_REGION ?? env.AWS_REGION ?? 'us-east-1',
      allowedModels: env.BEDROCK_ALLOWED_MODELS.split(',')
        .map((m) => m.trim())
        .filter(Boolean),
      maxOutputTokens: env.BEDROCK_MAX_OUTPUT_TOKENS,
      timeoutMs: env.BEDROCK_TIMEOUT_MS,
    },
    mail: {
      transport: env.MAIL_TRANSPORT,
      from: env.MAIL_FROM,
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
      },
    },
    cookies: {
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAME_SITE,
      domain: env.COOKIE_DOMAIN?.trim() ? env.COOKIE_DOMAIN.trim() : undefined,
    },
    cors: {
      origins: parseOrigins(env.CORS_ORIGINS),
    },
    throttle: {
      ttlMs: env.THROTTLE_TTL_MS,
      limit: env.THROTTLE_LIMIT,
      authTtlMs: env.AUTH_THROTTLE_TTL_MS,
      authLimit: env.AUTH_THROTTLE_LIMIT,
    },
    logging: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY,
    },
    swagger: {
      enabled: env.SWAGGER_ENABLED,
      path: trimSlashes(env.SWAGGER_PATH),
    },
  };
}
