import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
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
  // storage
  StorageNotConfigured: 'STORAGE_NOT_CONFIGURED',
  StorageError: 'STORAGE_ERROR',
  FileNotFound: 'FILE_NOT_FOUND',
  FileTooLarge: 'FILE_TOO_LARGE',
  FileEmpty: 'FILE_EMPTY',
  UnsupportedFileType: 'UNSUPPORTED_FILE_TYPE',
  DocumentUnreadable: 'DOCUMENT_UNREADABLE',
  UploadIncomplete: 'UPLOAD_INCOMPLETE',
  // projects
  ProjectNotFound: 'PROJECT_NOT_FOUND',
  ProjectReadOnly: 'PROJECT_READ_ONLY',
  RevisionConflict: 'REVISION_CONFLICT',
  ProjectDataTooLarge: 'PROJECT_DATA_TOO_LARGE',
  VersionNotFound: 'VERSION_NOT_FOUND',
  // studio graph
  BranchNotFound: 'BRANCH_NOT_FOUND',
  BranchNameTaken: 'BRANCH_NAME_TAKEN',
  LastBranch: 'LAST_BRANCH',
  NodeNotFound: 'NODE_NOT_FOUND',
  StudioLimitReached: 'STUDIO_LIMIT_REACHED',
  // sharing
  InvitationNotFound: 'INVITATION_NOT_FOUND',
  InvitationExpired: 'INVITATION_EXPIRED',
  InvitationRevoked: 'INVITATION_REVOKED',
  InvitationAlreadyAccepted: 'INVITATION_ALREADY_ACCEPTED',
  InvitationEmailMismatch: 'INVITATION_EMAIL_MISMATCH',
  InvitationPending: 'INVITATION_PENDING',
  ShareLinkNotFound: 'SHARE_LINK_NOT_FOUND',
  ShareLinkInactive: 'SHARE_LINK_INACTIVE',
  ShareLinkExpired: 'SHARE_LINK_EXPIRED',
  ShareLinkExhausted: 'SHARE_LINK_EXHAUSTED',
  ShareLinkDomainRestricted: 'SHARE_LINK_DOMAIN_RESTRICTED',
  ShareLinkPasswordRequired: 'SHARE_LINK_PASSWORD_REQUIRED',
  ShareLinkPasswordInvalid: 'SHARE_LINK_PASSWORD_INVALID',
  MemberNotFound: 'MEMBER_NOT_FOUND',
  OwnerImmutable: 'OWNER_IMMUTABLE',
  // teams
  TeamNotFound: 'TEAM_NOT_FOUND',
  TeamPlanRequired: 'TEAM_PLAN_REQUIRED',
  TeamTokenLimitInvalid: 'TEAM_TOKEN_LIMIT_INVALID',
  TeamTokenLimitReached: 'TEAM_TOKEN_LIMIT_REACHED',
  AlreadyTeamMember: 'ALREADY_TEAM_MEMBER',
  TeamOwnerImmutable: 'TEAM_OWNER_IMMUTABLE',
  // chat
  ChatMessageNotFound: 'CHAT_MESSAGE_NOT_FOUND',
  ChatBusy: 'CHAT_BUSY',
  WidgetNotFound: 'WIDGET_NOT_FOUND',
  WidgetAnswered: 'WIDGET_ANSWERED',
  // design steps
  AiResponseInvalid: 'AI_RESPONSE_INVALID',
  StageInputMissing: 'STAGE_INPUT_MISSING',
  /** The entry step already ran; only later steps may follow. */
  EntryStepLocked: 'ENTRY_STEP_LOCKED',
  /** The step is upstream of (or unrelated to) the project's entry step. */
  StageOutOfScope: 'STAGE_OUT_OF_SCOPE',
  SupplierNotConfigured: 'SUPPLIER_NOT_CONFIGURED',
  SupplierError: 'SUPPLIER_ERROR',
  StageNotAvailable: 'STAGE_NOT_AVAILABLE',
  StageFailed: 'STAGE_FAILED',
  StageRunning: 'STAGE_RUNNING',
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
  tooLarge: make(PayloadTooLargeException, 'Payload Too Large'),
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
