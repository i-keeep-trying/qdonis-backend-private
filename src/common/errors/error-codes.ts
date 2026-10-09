import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Machine-readable error codes returned in the `code` field of the error
 * envelope. Clients branch on these, never on the human-readable message.
 */
export const ErrorCode = {
  InvalidCredentials: 'INVALID_CREDENTIALS',
  EmailNotVerified: 'EMAIL_NOT_VERIFIED',
  EmailTaken: 'EMAIL_TAKEN',
  InvalidToken: 'INVALID_TOKEN',
  SessionRevoked: 'SESSION_REVOKED',
  SessionExpired: 'SESSION_EXPIRED',
  SessionNotFound: 'SESSION_NOT_FOUND',
  RefreshConflict: 'REFRESH_CONFLICT',
  RefreshMissing: 'REFRESH_TOKEN_MISSING',
  Unauthenticated: 'UNAUTHENTICATED',
  AccessTokenExpired: 'ACCESS_TOKEN_EXPIRED',
  AccountUnavailable: 'ACCOUNT_UNAVAILABLE',
  PasswordNotSet: 'PASSWORD_NOT_SET',
  PasswordUnchanged: 'PASSWORD_UNCHANGED',
  OriginNotAllowed: 'ORIGIN_NOT_ALLOWED',
  SelfModification: 'SELF_MODIFICATION',
  LastAdmin: 'LAST_ADMIN',
  UserNotFound: 'USER_NOT_FOUND',
  OAuthNotConfigured: 'OAUTH_NOT_CONFIGURED',
  ReauthRequired: 'REAUTH_REQUIRED',
  ValidationFailed: 'VALIDATION_FAILED',
  AiNotConfigured: 'AI_NOT_CONFIGURED',
  SettingNotFound: 'SETTING_NOT_FOUND',
  TopologyNotFound: 'TOPOLOGY_NOT_FOUND',
  // billing
  BillingNotConfigured: 'BILLING_NOT_CONFIGURED',
  PlanNotFound: 'PLAN_NOT_FOUND',
  PackageNotFound: 'PACKAGE_NOT_FOUND',
  PackageNotPurchasable: 'PACKAGE_NOT_PURCHASABLE',
  AddonNotFound: 'ADDON_NOT_FOUND',
  AlreadySubscribed: 'ALREADY_SUBSCRIBED',
  ActiveSubscription: 'ACTIVE_SUBSCRIPTION',
  NoActiveSubscription: 'NO_ACTIVE_SUBSCRIPTION',
  PaidPlanRequired: 'PAID_PLAN_REQUIRED',
  SamePlan: 'SAME_PLAN',
  SubscriptionNotManagedByStripe: 'SUBSCRIPTION_NOT_STRIPE_MANAGED',
  CancellationPending: 'CANCELLATION_PENDING',
  NotCancelling: 'NOT_CANCELLING',
  NoScheduledChange: 'NO_SCHEDULED_CHANGE',
  PaymentFailed: 'PAYMENT_FAILED',
  InsufficientTokens: 'INSUFFICIENT_TOKENS',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  InvalidAmount: 'INVALID_AMOUNT',
  BatchNotFound: 'BATCH_NOT_FOUND',
  StripeError: 'STRIPE_ERROR',
  InvalidSignature: 'INVALID_SIGNATURE',
  Forbidden: 'FORBIDDEN',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

type ExceptionCtor = new (body: {
  message: string;
  code: ErrorCode;
  error: string;
}) => HttpException;

const make =
  (Ctor: ExceptionCtor, error: string) =>
  (code: ErrorCode, message: string): HttpException =>
    new Ctor({ message, code, error });

/** Factories producing HttpExceptions that carry an {@link ErrorCode}. */
export const AppError = {
  badRequest: make(BadRequestException, 'Bad Request'),
  unauthorized: make(UnauthorizedException, 'Unauthorized'),
  forbidden: make(ForbiddenException, 'Forbidden'),
  notFound: make(NotFoundException, 'Not Found'),
  conflict: make(ConflictException, 'Conflict'),
  unavailable: make(ServiceUnavailableException, 'Service Unavailable'),
  badGateway: make(BadGatewayException, 'Bad Gateway'),
  /** 402: the action needs more tokens or a paid plan. */
  paymentRequired: (
    code: ErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) =>
    new HttpException(
      { message, code, error: 'Payment Required', meta: extra },
      HttpStatus.PAYMENT_REQUIRED,
    ),
};
