# Requirements: Production hardening of new-qdonis-nest-backend

## 1. Summary

Make `new-qdonis-nest-backend` (NestJS 11, Express 5, Prisma 7, PostgreSQL + pgvector) a production-grade service that can take over **authentication** from Clerk and the **user/project/simulation data** currently kept in Supabase. Code changes stay inside `new-qdonis-nest-backend/` only. The frontend (`qdonis/`) and Python core (`qdonis-core/`) were read for reference and are not modified.

The backend is past boilerplate stage. It already has Argon2id hashing, DB-backed refresh sessions with rotation, a global deny-by-default `JwtAuthGuard`, Helmet, a CORS allowlist, a throttler, a global ValidationPipe, a Prisma-aware exception filter, Terminus health checks and pino logging. The remaining work has three parts:

- Close the auth gaps against Clerk: email verification, password reset, password change, lockout, self-service profile, and legacy Clerk user import.
- Fix the correctness and security defects listed in §4.
- Add the first Supabase-replacement data domain: projects, simulation results and project blobs, with an ownership check on every request.
- Make infrastructure and config fail fast and behave predictably behind a proxy.

All rules in `AGENTS.md` apply. The ones most relevant here:

- Multi-file Prisma schema, one model per file under `prisma/schema/<domain>/`.
- `prisma-client` generator, and the client is imported from `src/generated/prisma/client`.
- Layering is repository → service → controller.
- `JwtAuthGuard` is global and deny-by-default. Routes opt out with `@Public()`, and admin routes use `@Roles()`.
- Every env var goes through `EnvironmentVariables`, `configuration.ts` and `.env.example`, and is read through `ConfigService` only.
- Secrets are covered by pino `redact`.
- Wildcard routes use the express 5 `{*splat}` syntax.
- ESLint is type-checked, with no `any`.

## 2. Inventory of what is used today (read-only findings)

### 2.1 Clerk (frontend `qdonis/`)

| Feature | Evidence | Notes |
|---|---|---|
| Hosted sign-in/up UI | `components/AuthPage.tsx` `<SignIn>`; `index.tsx` `<ClerkProvider afterSignInUrl="/">` | Email + password sign-up and sign-in, with Clerk's built-in email verification and "forgot password" flows |
| OAuth / social login | `App.tsx:5711` handles `/sso-callback` with `<AuthenticateWithRedirectCallback/>` | The OAuth providers are configured in the Clerk dashboard. Which ones is not visible in code (assumed Google) |
| Session state | `useUser()` (`isLoaded`, `isSignedIn`, `user`) in ~12 components; `window.Clerk.session` polling in `hooks/useProjects.ts` | |
| Sign out | `useClerk().signOut()` in `Topbar.tsx`, `LeftSidebar.tsx` | |
| Profile management | `components/ProfilePage.tsx` `<UserProfile/>` | Change password, manage email, avatar, connected accounts |
| User fields consumed | `user.id`, `primaryEmailAddress.emailAddress`, `emailAddresses[0]`, `fullName`, `firstName`, `imageUrl` | No `publicMetadata` or `unsafeMetadata` usage. Admin status comes from Supabase `user_profiles.is_admin` (`services/adminService.ts:104`) |
| Tokens to third parties | `session.getToken({ template: 'supabase' })` in `services/supabaseClient.ts`, `projectService.ts`, `bedrockService.ts`, `AcceptTeamInvitationPage.tsx` | A Clerk JWT template is used for Supabase RLS (`auth.jwt() ->> 'sub'`) |
| User ID format | Supabase `user_profiles.user_id TEXT` "Clerk user ID" (`supabase/migrations/003_create_user_profiles.sql`) | Clerk IDs are opaque strings (e.g. `user_…`), not UUIDs |

Env var names in use (values not read): `VITE_CLERK_PUBLISHABLE_KEY`, **`VITE_CLERK_SECRET_KEY`**, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_QDONIS_API_URL`, `VITE_CLARIVATE_API_KEY`.

> **Security risk (outside scope, flagged):** `VITE_CLERK_SECRET_KEY` has a `VITE_` prefix, so Vite inlines it into the public JS bundle when code references it. Clerk *secret* keys must never ship to the browser. Rotate the key and remove the variable from the frontend.

### 2.2 Supabase (frontend `qdonis/`)

- **Auth:** none. Supabase Auth is not used (`supabase.auth.*` never called). Supabase authorizes requests with Clerk-issued JWTs through RLS.
- **Tables:** 32 tables are referenced through `supabase.from(...)`. Counts are call sites:
  - Billing/tokens: `subscriptions` 65, `token_batches` 47, `subscription_history` 20, `plan_packages`, `addon_packages`, `subscription_plans`, `token_usage`, `team_token_usage`, `project_token_summary`, `step_token_summary`.
  - Users: `user_profiles` 30.
  - Projects: `projects` 27, `project_versions`, `project_activity_log`.
  - Sharing/teams: `project_shares` 16, `teams` 11, `team_members` 10, `team_invitations` 8, `pending_invitations` 8, `share_links` 7, `email_delivery_log`.
  - Simulation/design: `simulation_plots` 6, `design_options`, `magnetic_components`, `topology_generations`, `sessions`, `requests`, `chat_messages`.
  - Component search: `mouser_*` (3 tables).
  - Admin: `admin_settings`.
- **RPCs:** `sync_user_profile` (upserts profile on every sign-in, `services/userProfileService.ts:39`) and `cleanup_expired_mouser_cache`.
- **Storage:** bucket `simulation-plots`. Objects live at `<clerkUserId>/<projectId>/<name>`, with names like `plots.json.gz`, written as gzip blobs, upserted, downloaded and removed (`services/simulationStorageService.ts`). The bucket exists because the `simulation_plots` row has a practical ~1 MB limit.
- **Edge functions:** `bedrock-proxy`, `send-invitation-email`, `send-team-invitation-email` (Gmail SMTP via `SMTP_USER`/`SMTP_PASS`/`FROM_EMAIL`), `stripe-checkout`, `stripe-addon-checkout`, `stripe-upgrade`, `stripe-downgrade`, `stripe-cancel`, `stripe-webhook`.
- **Raw REST:** `App.tsx:1368` uses `navigator.sendBeacon` to PATCH `/rest/v1/projects?id=eq.<id>` on page unload. `sendBeacon` cannot set an `Authorization` header (relevant to decision D4).
- **Simulation upsert quirk:** `simulation_plots` is written as update-then-insert because PostgREST `onConflict: 'project_id'` failed. One row per project is the intended semantics.

### 2.3 Python core (`qdonis-core/`)

`qdonis_backend/config.py` validates only LLM and AWS credentials (`AWS_BEARER_TOKEN_BEDROCK`/`AWS_ACCESS_KEY_ID`/`AWS_PROFILE`, `OPENROUTER_API_KEY`). A search for `jwt|clerk|supabase|Authorization|HTTPBearer|Depends(` across `qdonis-core/**/*.py` finds no request authentication. The frontend calls `/api/simulate`, `/api/compose`, `/api/assistant` and others without auth headers.

**Conclusion:** the Python core verifies neither Clerk nor Supabase JWTs, so moving auth to Nest does not break it. Its endpoints remain unauthenticated (risk noted; out of scope, see §9).

### 2.4 Gap list: what Nest must provide to replace Clerk + Supabase

| # | Replaces | Required capability | Status in this task |
|---|---|---|---|
| G1 | Clerk sign-up/sign-in | Email + password register/login, sessions | Exists; harden (§4) |
| G2 | Clerk email verification | Verification email + single-use token | **New** |
| G3 | Clerk forgot password | Reset email + single-use token | **New** |
| G4 | Clerk `<UserProfile>` | Self profile read/update (name, avatar), change password, delete account | **New** (only `GET /auth/me` exists) |
| G5 | Clerk session list / sign-out | List/revoke sessions, logout, logout-all | Exists; fix defects |
| G6 | Clerk OAuth (`/sso-callback`) | Google OAuth sign-in | **Deferred** (D1) |
| G7 | Clerk user IDs referenced by Supabase rows | `legacyClerkId` on User + admin bulk import | **New** |
| G8 | `user_profiles` + `sync_user_profile` RPC | Profile fields on `User` (`name`, `avatarUrl`, `lastSeenAt`), no client-side sync step | **New fields** |
| G9 | `user_profiles.is_admin` | `Role.ADMIN` | Exists |
| G10 | `projects` table | Owner-scoped project CRUD, pagination, duplicate, optimistic concurrency | **New** (D3) |
| G11 | `simulation_plots` table | One simulation record per project, upsert | **New** (D3) |
| G12 | `simulation-plots` storage bucket | Owner-scoped binary blobs per project, with a size cap | **New** (D3) |
| G13 | Email edge functions (SMTP) | Mailer abstraction with an SMTP transport | **New** (D2) |
| G14 | Sharing, teams, invitations, subscriptions/Stripe, token accounting, chat, mouser cache, admin settings, bedrock-proxy | | **Deferred** (§9) |

## 3. Migration state (verified)

- `prisma/migrations/20260824000000_init/migration.sql` exists. It creates the `vector` extension, the `role` enum, the `users`/`sessions`/`documents` tables, indexes and FKs, plus the HNSW index. It matches the current schema.
- `prisma/migrations/20261006000000_user_legacy_clerk_id/` **exists but is empty, with no `migration.sql`**. `git status` is clean because git does not track empty folders, so this folder exists only locally. No `legacyClerkId` field is present in `prisma/schema/user/user.prisma`. Prisma CLI fails with P3015 (missing migration file) while this folder exists, so it currently blocks `migrate dev`/`migrate deploy`.
- `migration_lock.toml` is present.
- `users` has a redundant `users_email_idx` alongside the unique `users_email_key`.

## 4. Audit of the current backend: production gaps

Severity: **H** = security or correctness bug, **M** = production robustness, **L** = hygiene.

### 4.1 Auth

| ID | Sev | Finding (file) |
|---|---|---|
| A1 | H | **Refresh rotation race.** `SessionsService.rotate` updates the old session unconditionally. Two concurrent refreshes with the same token both pass the `revokedAt === null` check and both mint valid sessions, which forks the session. |
| A2 | H | **Legitimate concurrent refresh triggers logout-everywhere.** Two browser tabs refreshing together make the slower one look like token reuse, which revokes every session. There is no grace window. |
| A3 | H | **Unbounded sliding session.** Each rotation issues a new `expiresAt = now + JWT_REFRESH_TTL`, so a session never ends while used. There is no absolute lifetime. |
| A4 | H | **Login body is not validated.** `LocalAuthGuard` (passport) runs before the ValidationPipe, so `LoginDto` constraints (email format, `MaxLength(128)` password) never apply. Oversized or non-string passwords reach Argon2. |
| A5 | H | No per-account lockout or failed-login counter. Only the per-IP throttle protects against distributed credential stuffing. |
| A6 | H | No email verification, password reset or password change flows. `RevocationReason.PasswordChanged` is defined but unused. |
| A7 | M | `POST /auth/logout` requires a valid access token. With an expired access token the user cannot log out, and the refresh cookie survives. |
| A8 | M | `DELETE /auth/sessions/:id` returns 403 for another user's session and 204 for a missing one, which leaks session existence. A user-initiated revoke is recorded as `admin_revoked`. |
| A9 | M | Auth throttle limits are read from `process.env` at decorator time (`auth.controller.ts`, `AUTH_THROTTLE`). This needs the `import 'dotenv/config'` hack in `main.ts` and violates the ConfigService rule. |
| A10 | M | No cap on active sessions per user. Rows accumulate on every login and rotation. `pruneExpired` exists but nothing calls it. |
| A11 | M | JWT config validation has gaps: access and refresh secrets may be equal, placeholder values (`replace-me…`) are accepted in production, there is no bound on TTL ordering (refresh must exceed access), and defaults still say `backend-boilerplate`. |
| A12 | M | Cookie config is not cross-validated. `COOKIE_SAME_SITE=none` with `COOKIE_SECURE=false` is accepted (browsers reject it). Production with `COOKIE_SECURE=false` only logs a warning. |
| A13 | M | No CSRF defence on the cookie-authenticated `POST /auth/refresh`, and no `Origin` check. |
| A14 | M | No legacy Clerk user path. There is no `legacyClerkId` and `passwordHash` is `NOT NULL`, so imported users without a password cannot exist. |
| A15 | L | `SessionsService` calls Prisma directly, which breaks the repository rule. |
| A16 | OK | Correct today, keep: Argon2id (m=19456 KiB, t=2, p=1, OWASP minimum) with `needsRehash`, a decoy hash for unknown emails (timing equalization), SHA-256 refresh-token hash in a unique column, pinned `HS256` + issuer/audience + `type` claim, per-request session/active-user check, httpOnly cookie scoped to the auth path. |

### 4.2 Users / authorization

| ID | Sev | Finding |
|---|---|---|
| U1 | H | Admins can demote, deactivate or delete themselves or the last remaining admin, which can lock out administration. |
| U2 | M | Deactivating a user (`isActive=false`) or changing their role does not revoke sessions, although the DTO description claims it does. Requests are already rejected per request, but refresh rows stay live. |
| U3 | M | Non-admin users have no self-service routes. `UsersController` is class-level `@Roles(ADMIN)`. |
| U4 | L | `register` returns 409 for an existing email, which enables enumeration. This is accepted (see FR-AUTH-1) and is rate-limited. |

### 4.3 Middleware / infrastructure

| ID | Sev | Finding (`src/main.ts`, `src/app.module.ts`) |
|---|---|---|
| I1 | H | A disallowed CORS origin calls `callback(new Error(...))`. That surfaces as a 500 instead of a normal response without CORS headers. |
| I2 | M | No request/correlation ID. pino uses its default incrementing ID, there is no `X-Request-Id` in or out, and the error envelope has no `requestId`. |
| I3 | M | Body size limit is Express's implicit 100 kb. Payload-too-large and malformed-JSON errors are not mapped to the envelope. Project data needs larger limits on specific routes. |
| I4 | M | No compression. |
| I5 | M | `trust proxy` is hard-coded to `1` in production only. It is not configurable for other topologies, and the throttler's IP key depends on it. |
| I6 | M | `void bootstrap()` leaves boot failures as unhandled rejections. There are no `unhandledRejection` or `uncaughtException` handlers and no server keep-alive or request timeouts. |
| I7 | M | The exception filter does not map connection or pool errors (`P1001`, `P1002`, `P1017`, `P2024`, `PrismaClientInitializationError`) to 503, transaction conflicts (`P2034`) to 409, or value-too-long/invalid-input (`P2000`, `P2023`) to 400. |
| I8 | M | The readiness probe returns raw DB error messages to unauthenticated callers. |
| I9 | M | The log auto-ignore uses `url.includes('/health')`, which also silences any route containing that substring. The redact list lacks token fields (`req.body.token`, `req.body.refreshToken`), SMTP secrets and `req.headers["x-api-key"]`. |
| I10 | L | `application_name: 'backend-boilerplate'`, package name, Swagger title and `JWT_ISSUER`/`JWT_AUDIENCE` defaults still use boilerplate naming. |
| I11 | OK | Present, keep: Helmet, ValidationPipe (`whitelist`, `forbidNonWhitelisted`, `transform`, no implicit conversion), `enableShutdownHooks` + Prisma `$disconnect`, `api/v1` global prefix with `/health` excluded, Swagger off in production, throttler before auth guard, `instanceToPlain` interceptor with `@Exclude()` on `passwordHash`. |

### 4.4 Data / Prisma

| ID | Sev | Finding |
|---|---|---|
| D1 | H | The empty migration folder blocks the Prisma CLI (§3). |
| D2 | M | No models exist for projects, simulations or blobs, so there is nothing yet to replace Supabase. |
| D3 | L | Redundant `users_email_idx`. |
| D4 | L | `prisma/seed.ts` creates `admin@example.com` with a hard-coded password and has no production guard. |
| D5 | OK | Paginated reads use `$transaction([findMany, count])` with `take ≤ 100`. Documents have an ownership check, and pgvector SQL is parameterized. |

### 4.5 Tests

| ID | Sev | Finding |
|---|---|---|
| T1 | H | There are zero `*.spec.ts` files and no e2e tests. `test/jest-e2e.json` exists but has nothing to run. |

## 5. Decision points (defaults chosen; not blocking)

**D1. OAuth/social login (Google) to match Clerk? Default: defer to a follow-up task.**

The frontend must be rewritten anyway before any Nest auth is usable. OAuth adds a provider dependency, callback/state/PKCE handling and account-linking edge cases (an existing email, an unverified provider email), which doubles the auth surface. Users who signed up with Google through Clerk are not stranded. They are imported with `passwordHash = null` and claim the account through the password-reset email (FR-LEGACY-3).

The schema change in this task (nullable `passwordHash`) is the only prerequisite OAuth needs later. No OAuth model is added now, to avoid unused schema.

**D2. Email sending. Default: a pluggable `Mailer` interface with two transports, selected by `MAIL_TRANSPORT`.**

- `log` writes the message to the logger. It is for development and test only.
- `smtp` uses `nodemailer`, a pinned and widely used dependency. The existing Supabase email functions already use Gmail SMTP, so the same credentials work.

Production boot must fail if `MAIL_TRANSPORT=log`, because the log transport would write live reset links to logs. Sending is fire-and-forget relative to the HTTP response, so latency and failures do not leak whether an account exists. Failures are logged at `error` without the token.

**D3. Port Supabase tables now, or only the auth foundation? Default: auth/user foundation plus the project + simulation domain.**

The ported domain is `projects`, `simulation_plots` and the `simulation-plots` storage bucket. These are the core user-owned data the original request names, and the task brief points at them ("simulations/projects owned by user"). The remaining 27+ tables are deferred to their own tasks:

- Billing/Stripe, tokens, teams/sharing/invitations, chat, mouser cache, admin settings.
- `project_versions` and `project_activity_log`, which the frontend uses lightly and which depend on sharing.

Each of these carries business logic (Stripe webhooks, token accounting, invitations) that needs its own requirements. Blobs are stored in Postgres (`bytea`) with a configurable size cap rather than S3. This adds no infrastructure, the existing objects are gzip JSON in the tens of MB at most, and moving to object storage later is localized to one repository.

**D4. Token transport. Default: keep the current hybrid.**

- **Access token:** short-lived JWT returned in the JSON body, held in memory by the SPA and sent as `Authorization: Bearer`.
- **Refresh token:** httpOnly, `Secure` (required in production), `SameSite=Lax` by default, path-scoped to `/{API_PREFIX}/auth`. Never readable by JS, and not stored in localStorage.

Reasons for this split:

- Bearer access tokens are immune to CSRF on every data route. Only `/auth/refresh` and `/auth/logout` read the cookie, and those get an `Origin` allowlist check (FR-AUTH-14).
- Path scoping keeps the refresh cookie off all other requests.
- `SameSite=None; Secure` remains configurable for a frontend on a different site.

The frontend's `sendBeacon` unload save cannot carry a bearer header. The documented replacement is `fetch(url, { method: 'PATCH', keepalive: true, headers: { Authorization } })`. No cookie-authenticated data route is added.

**D5. Legacy Clerk passwords. Default: no hash import.**

Imported users get `passwordHash = null` and set a password through the reset flow. Importing Clerk's bcrypt digests would need a bcrypt dependency and a dual-verify path, and is backlogged.

**D6. Token signing. Default: keep HS256 symmetric secrets.**

No other service verifies these tokens today (§2.3). Asymmetric signing with a JWKS endpoint, for when the Python core starts verifying tokens, is backlogged.

## 6. Functional requirements

All paths are under `/{API_PREFIX}` (default `api/v1`) unless noted. "Auth" means a valid bearer access token. All error responses use the envelope in NFR-ERR-1.

### 6.1 Authentication (`auth/`)

- **FR-AUTH-1 Register.** `POST /auth/register` is `@Public` and auth-throttled. It takes `{ email, password, name? }`.
  - Email is trimmed, lowercased, must be a valid address and at most 255 characters.
  - Password: length 10–128, at least one letter and one digit.
  - Name: trimmed, at most 120 characters.
  - On success it creates the user with `emailVerifiedAt = null`, starts a session (same response as login, 201) and sends a verification email (FR-AUTH-6).
  - An existing email returns 409 `EMAIL_TAKEN`. This enumeration risk is accepted, documented and throttled.
  - Concurrent duplicate registers resolve to exactly one user and one 409, through the unique constraint (P2002 → 409).
- **FR-AUTH-2 Login.** `POST /auth/login` is `@Public` and auth-throttled. It takes `{ email, password }`, which **is validated before any password hashing** (fixes A4).
  - Success returns 200 `{ accessToken, tokenType: 'Bearer', expiresIn, user }` and sets the refresh cookie.
  - Every credential failure returns the identical response 401 `INVALID_CREDENTIALS` "Invalid email or password". This covers an unknown email, a wrong password, `passwordHash = null`, an inactive account and a locked account. Response timing is equalized with the decoy hash.
  - If `AUTH_REQUIRE_VERIFIED_EMAIL=true` and the credentials are correct but the email is unverified, the response is 403 `EMAIL_NOT_VERIFIED`. This only reveals state to someone who knows the password.
  - Success resets the failure counter and sets `lastLoginAt`.
- **FR-AUTH-3 Lockout.** Each failed password check for an existing user atomically increments `failedLoginAttempts`, as a single SQL increment with no read-modify-write.
  - When the count reaches `AUTH_LOCKOUT_THRESHOLD` (default 5), `lockedUntil = now + AUTH_LOCKOUT_DURATION_MS` (default 15 min) and the counter resets.
  - While locked, login fails per FR-AUTH-2 even with the correct password.
  - A successful password reset clears the lock.
  - Each lock event is logged at `warn` with the userId, never the email or password.
- **FR-AUTH-4 Refresh.** `POST /auth/refresh` is `@Public`, uses the cookie only and is auth-throttled. The refresh token must be a valid JWT, with `type=refresh`, correct issuer and audience, and an `sid` and `sub` matching a stored session hash.
  - **Atomic rotation:** the old session is revoked by a conditional update (`WHERE id = ? AND revoked_at IS NULL`) inside the same transaction that creates the successor. If 0 rows are affected, the request lost a race and is handled as in the next bullet.
  - **Revoked token presented:**
    - If it was rotated (`revokedReason='rotated'`) less than `AUTH_REFRESH_REUSE_GRACE_SECONDS` ago (default 10 s), return 401 `REFRESH_CONFLICT` without revoking anything. The client retries using the cookie set by the winning request.
    - Otherwise this is **reuse**: revoke every session of the user, log at `warn`, and return 401 `SESSION_REVOKED`.
  - **Absolute lifetime:** a rotated session inherits `authenticatedAt` (the original login time) from its predecessor. If `now > authenticatedAt + AUTH_SESSION_ABSOLUTE_TTL` (default 30d), refresh fails with 401 `SESSION_EXPIRED` and the cookie is cleared.
  - Any 401 from refresh clears the refresh cookie.
  - An inactive or deleted user gets 401 `SESSION_REVOKED`.
- **FR-AUTH-5 Logout.** `POST /auth/logout` is `@Public` and always returns 204, even when nothing is found.
  - It revokes the session identified by the refresh cookie if the cookie verifies, otherwise the session in a valid bearer token, otherwise nothing.
  - It always clears the cookie.
  - `POST /auth/logout-all` requires auth. It revokes every session of the user (204) and clears the cookie.
- **FR-AUTH-6 Email verification.**
  - A verification token is issued on register and on `POST /auth/email/verification/resend { email }`. The resend route is `@Public`, auth-throttled and always returns 202 with the same body. It sends only if the user exists, is active and is unverified.
  - `POST /auth/email/verification/confirm { token }` is `@Public`. It sets `emailVerifiedAt` and returns 204.
  - The confirm endpoint returns one error for invalid, expired or used tokens: 400 `INVALID_TOKEN`.
  - Confirming an already-verified user's valid token succeeds idempotently.
  - The link sent is `${FRONTEND_URL}/verify-email?token=<token>`. The frontend POSTs the token. The token never appears in an API URL, so it never reaches request logs.
- **FR-AUTH-7 Password reset.**
  - `POST /auth/password/forgot { email }` is `@Public`, auth-throttled and always returns 202 with an identical body. It sends a reset email only for an existing, active user. Users with `passwordHash = null` (legacy) are included.
  - `POST /auth/password/reset { token, newPassword }` is `@Public` and auth-throttled. The new password follows the FR-AUTH-1 policy. In **one transaction** it:
    - consumes the token,
    - sets the new hash and `passwordChangedAt`,
    - sets `emailVerifiedAt` if null (the user proved inbox access),
    - clears the lockout,
    - revokes **all** sessions with reason `password_reset`.
  - It returns 204 and does not log the user in.
  - The link is `${FRONTEND_URL}/reset-password?token=<token>`.
- **FR-AUTH-8 Token rules (verification + reset).**
  - Tokens are 32 bytes from CSPRNG, encoded base64url, and stored only as a SHA-256 hex hash in a unique column.
  - Each token records its type, userId, `expiresAt` (`AUTH_EMAIL_VERIFICATION_TTL` default 24h, `AUTH_PASSWORD_RESET_TTL` default 30m) and `consumedAt`.
  - Consumption is a conditional update (`consumed_at IS NULL AND expires_at > now()`). Exactly one of N concurrent uses succeeds.
  - Issuing a new token of a type invalidates the user's outstanding tokens of that type.
  - A token of one type is rejected by the other endpoint.
  - Any direct secret comparison uses `crypto.timingSafeEqual`. Lookup by hash is the primary mechanism.
- **FR-AUTH-9 Change password.** `POST /auth/password/change { currentPassword, newPassword }` requires auth.
  - Wrong current password returns 401 `INVALID_CREDENTIALS`. It counts toward lockout.
  - A user with `passwordHash = null` gets 400 `PASSWORD_NOT_SET`.
  - A new password equal to the current one gets 400 `PASSWORD_UNCHANGED`.
  - On success: update the hash and `passwordChangedAt`, revoke all *other* sessions with reason `password_changed`, keep the current session, and return 204.
- **FR-AUTH-10 Me.** `GET /auth/me` requires auth and returns the `UserEntity`. The entity gains `emailVerified: boolean`, `avatarUrl` and `hasPassword: boolean`. It never exposes `passwordHash`, lockout fields or `legacyClerkId`.
- **FR-AUTH-11 Sessions.**
  - `GET /auth/sessions` requires auth and lists the user's sessions with `revokedAt IS NULL AND expiresAt > now`.
  - `DELETE /auth/sessions/:id` takes a UUID and returns 204. It uses reason `user_revoked` and clears the cookie when the target is the current session. A missing session, a foreign session and an already-revoked session all return 404 `SESSION_NOT_FOUND`.
- **FR-AUTH-12 Session cap.** Creating a session when the user already has `AUTH_MAX_SESSIONS_PER_USER` (default 10) active sessions revokes the oldest active ones (by `lastUsedAt`) with reason `session_limit`, in the same transaction.
- **FR-AUTH-13 Cleanup.** A periodic job (`AUTH_CLEANUP_INTERVAL_MS`, default 1h; disabled when `NODE_ENV=test`) deletes:
  - sessions whose `expiresAt` passed more than 1 day ago,
  - auth tokens expired or consumed more than 1 day ago.

  A failure is logged at `error` and does not crash the process. The job must not overlap itself.
- **FR-AUTH-14 Origin check.** On `/auth/refresh` and `/auth/logout`, a request whose `Origin` header is present and not in `CORS_ORIGINS` returns 403 `ORIGIN_NOT_ALLOWED`. Requests without an `Origin` header are allowed (non-browser clients).
- **FR-AUTH-15 Per-request auth.** The access-token strategy keeps rejecting requests with 401 when the session is revoked or expired, or the user is inactive, deleted or locked. Revocation therefore takes effect on the next request, not at token expiry.

### 6.2 Self-service user (`users/`)

- **FR-USER-1** `PATCH /users/me { name?, avatarUrl? }` requires auth and is available to any role.
  - `name` follows the FR-AUTH-1 rule; an empty string becomes null.
  - `avatarUrl` must be an `https://` URL of at most 2048 characters, or null.
  - Email and role changes are rejected (400, non-whitelisted).
  - Returns 200 `UserEntity`.
- **FR-USER-2** `DELETE /users/me { password }` requires auth.
  - The password is required when `hasPassword` is true; a wrong password returns 401.
  - A user without a password gets 400 `PASSWORD_NOT_SET` and must set one via reset first.
  - The last active admin gets 409 `LAST_ADMIN`.
  - Otherwise the user is hard-deleted. Sessions, tokens, projects, simulations and project objects cascade, and `documents.user_id` is set to null as today. Returns 204 and clears the cookie.
- **FR-USER-3** `/users/me` routes must resolve before `/users/:id` and must not be blocked by the admin-only `@Roles` on the admin controller.
- **FR-USER-4** `lastSeenAt` (replacing `user_profiles.last_seen_at`) is updated at most once per 5 minutes per user, on authenticated requests or refresh. The write must not block the request path or fail it.

### 6.3 Admin (`users/`, ADMIN only)

- **FR-ADMIN-1** The existing `/users` CRUD stays. Additional rules:
  - Setting `isActive=false` revokes all of the target's sessions (reason `admin_deactivated`).
  - A role change revokes the target's sessions.
  - An admin cannot deactivate, demote or delete themselves: 409 `SELF_MODIFICATION`.
  - No operation may leave zero active admins: 409 `LAST_ADMIN`. The check and the write happen in one transaction.
- **FR-ADMIN-2** `POST /users/import` (ADMIN) imports legacy Clerk users. The body is `{ users: [{ legacyClerkId, email, name?, avatarUrl?, emailVerified?: boolean, createdAt? }] }`.
  - The batch must hold 1–500 entries.
  - `legacyClerkId` is a required string of 1–64 characters matching `^[A-Za-z0-9_]+$`.
  - Email is normalized as in register.
  - The import is idempotent:
    - An existing `legacyClerkId` updates `name` and `avatarUrl` only.
    - An existing email without a `legacyClerkId` links the ID.
    - An existing email already linked to a *different* ID is reported as a conflict.
  - Imported users get `passwordHash = null` and `role = USER`.
  - Returns 200 `{ created, updated, linked, conflicts: [{ index, legacyClerkId, reason }] }`. One bad row does not abort the batch, and each row is written atomically.
  - No email is sent on import.
- **FR-ADMIN-3** `GET /users/by-legacy-id/:legacyClerkId` (ADMIN) returns the user or 404. This supports the later Supabase data import.

### 6.4 Legacy Clerk migration

- **FR-LEGACY-1** `User.legacyClerkId String? @unique` (column `legacy_clerk_id`).
- **FR-LEGACY-2** `User.passwordHash` becomes nullable. Every password-verify path treats null as "no match" with equal timing (decoy verify).
- **FR-LEGACY-3** A legacy user activates the account by `forgot` → `reset`. This also marks the email verified. The flow is documented in the README.

### 6.5 Projects (`projects/`, new module; replaces `projects`)

Every route requires auth. Every read and write is scoped `WHERE id = :id AND user_id = :currentUserId` in the repository layer. A project that is missing or owned by someone else returns **404 `PROJECT_NOT_FOUND`**, for admins too (no admin bypass in this task). Path IDs are validated as UUIDs (400 otherwise).

- **FR-PROJ-1** `POST /projects { name, description?, projectData? }` returns 201.
  - `name` is trimmed, 1–200 characters.
  - `description` is at most 2000 characters, or null.
  - `projectData` must be a JSON object (not an array or primitive) and defaults to `{}`.
  - The project starts with `version = 1`.
- **FR-PROJ-2** `GET /projects?skip&take&search?` lists the user's projects.
  - `take` is 1–100 (default 20) and `skip` is ≥ 0.
  - `search` is a case-insensitive substring match on name, at most 200 characters.
  - Sorted by `updatedAt desc, id desc`.
  - `items` exclude `projectData` (size). `items` and `total` come from one `$transaction`.
- **FR-PROJ-3** `GET /projects/:id` returns the full project including `projectData` and sets `lastAccessedAt = now`.
- **FR-PROJ-4** `PATCH /projects/:id { name?, description?, projectData?, expectedVersion? }` returns 200 with `version + 1`.
  - If `expectedVersion` is given and differs from the stored version, return 409 `VERSION_CONFLICT` with the current version. The check is a conditional update (`WHERE version = ?`), with no read-then-write.
  - If `expectedVersion` is omitted, last write wins.
  - An empty body returns 400.
- **FR-PROJ-5** `DELETE /projects/:id` returns 204 and cascades its simulation and objects.
- **FR-PROJ-6** `POST /projects/:id/duplicate { name? }` returns 201. In **one transaction** it copies the project (default name `"<name> (copy)"`, truncated to 200), its simulation and all its objects to a new project owned by the caller.
- **FR-PROJ-7** Per-user project cap `PROJECTS_MAX_PER_USER` (default 1000). Exceeding it on create or duplicate returns 409 `PROJECT_LIMIT_REACHED`.

### 6.6 Simulation data (replaces `simulation_plots`)

- **FR-SIM-1** One simulation per project, enforced by a unique `projectId`.
- **FR-SIM-2** `PUT /projects/:id/simulation` takes `{ topologyName, simulationMetadata?, simulationResults?, plotsData?, netlist?, analysisCirs? }`.
  - `topologyName` is 1–200 characters.
  - The three JSON fields must be objects, defaulting to `{}`.
  - `netlist` and `analysisCirs` are strings or null.
  - It is an atomic upsert (`INSERT … ON CONFLICT (project_id)`, through Prisma `upsert`), returning 200, and it bumps the project's `updatedAt`.
- **FR-SIM-3** `GET /projects/:id/simulation` returns 200, or 404 `SIMULATION_NOT_FOUND`.
- **FR-SIM-4** `DELETE /projects/:id/simulation` returns 204 and is idempotent.

### 6.7 Project objects (replaces the `simulation-plots` bucket)

- **FR-OBJ-1** `PUT /projects/:id/objects/:name` stores a raw binary body.
  - Allowed `Content-Type` values are `application/gzip` and `application/octet-stream`; anything else returns 415.
  - `name` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` and must not contain `..` (no path traversal).
  - The body must be 1 to `PROJECT_OBJECT_MAX_BYTES` bytes (default 25 MiB). Larger returns 413; empty returns 400.
  - The server stores content type, byte size and a SHA-256 checksum. It upserts on `(projectId, name)` and returns 204.
- **FR-OBJ-2** `GET /projects/:id/objects/:name` returns the bytes with the stored `Content-Type`, `Content-Length`, an `ETag` of the checksum and `Cache-Control: private, no-store`. A missing object returns 404 `OBJECT_NOT_FOUND`. The bytes are not run through the JSON interceptor.
- **FR-OBJ-3** `GET /projects/:id/objects` lists `{ name, contentType, sizeBytes, updatedAt }` without bytes. At most `PROJECT_OBJECTS_MAX_PER_PROJECT` (default 50) objects may exist; exceeding it on PUT of a new name returns 409 `OBJECT_LIMIT_REACHED`.
- **FR-OBJ-4** `DELETE /projects/:id/objects/:name` returns 204 and is idempotent.
- **FR-OBJ-5** Compression middleware must not re-compress `application/gzip` responses.

### 6.8 Mailer (`mail/`, new module)

- **FR-MAIL-1** An injectable `Mailer` abstraction with a `send({ to, subject, text, html })` method. `MAIL_TRANSPORT` selects one of two implementations, `log` or `smtp`.
- **FR-MAIL-2** Templates for verification and reset. Both include the link, its expiry, and a "you can ignore this" line. User-supplied values (name) are HTML-escaped.
- **FR-MAIL-3** Sending happens after the HTTP response is committed (not awaited by the request) and has a timeout of `MAIL_SEND_TIMEOUT_MS` (default 10 s). Errors are logged at `error` with the recipient userId and template name. The token and link are never logged.
- **FR-MAIL-4** The `log` transport logs the link at `info` in development only. Production with `MAIL_TRANSPORT=log` fails at boot.

## 7. Non-functional requirements

### 7.1 Errors (NFR-ERR)

- **NFR-ERR-1** Every non-2xx JSON response has this shape:

  ```
  { statusCode, error, message, code, details?, path, requestId, timestamp }
  ```

  `code` is always present. Defaults are `HTTP_<status>`, or a specific code from this document. Rate-limit errors use `RATE_LIMITED` and keep the `Retry-After` header.
- **NFR-ERR-2** Mappings:

  | Source | Status | `code` |
  |---|---|---|
  | Validation failure | 400 | `VALIDATION_FAILED` + `details[]` |
  | Malformed JSON body | 400 | `MALFORMED_JSON` |
  | Body over limit | 413 | `PAYLOAD_TOO_LARGE` |
  | Unsupported media type | 415 | |
  | `P2002` | 409 | `UNIQUE_VIOLATION` |
  | `P2003`/`P2014` | 409 | |
  | `P2025` | 404 | |
  | `P2034` | 409 | `TRANSACTION_CONFLICT` |
  | `P2000`/`P2023` | 400 | `INVALID_INPUT` |
  | `P1001`/`P1002`/`P1017`/`P2024`, `PrismaClientInitializationError` | 503 | `DB_UNAVAILABLE` |
  | Unknown route | 404 | |
  | Anything else | 500 | `INTERNAL_ERROR`, generic message |

- **NFR-ERR-3** Logging levels:
  - 5xx at `error`, with stack.
  - 401, 403 and 404 at `debug`. These are noise under normal use.
  - Other 4xx at `warn`.
  - Messages never include request bodies, tokens or Prisma `meta` values that may contain user data.

### 7.2 HTTP / infrastructure (NFR-HTTP)

- **NFR-HTTP-1 Request ID.** An incoming `X-Request-Id` is accepted if it matches `^[A-Za-z0-9._-]{1,128}$`; otherwise a UUIDv4 is generated. The ID is:
  - used as the pino `req.id`,
  - echoed in the `X-Request-Id` response header,
  - included in the error envelope,
  - allowed and exposed through CORS.
- **NFR-HTTP-2 CORS.** Allowlist only.
  - Each `CORS_ORIGINS` entry is validated at boot as `scheme://host[:port]`, with no path, no `*` and no trailing slash. In production the list must be non-empty and `https`-only.
  - A disallowed origin gets a normal response *without* `Access-Control-Allow-Origin`, never a 500.
- **NFR-HTTP-3 Body limits.**
  - JSON limit is `HTTP_JSON_LIMIT` (default `1mb`) globally.
  - `HTTP_LARGE_JSON_LIMIT` (default `16mb`) applies only to `POST/PATCH /projects…` and `PUT /projects/:id/simulation`.
  - Raw-body limit is `PROJECT_OBJECT_MAX_BYTES` and applies only to object PUT.
  - `urlencoded` is disabled or limited to `HTTP_JSON_LIMIT`.
- **NFR-HTTP-4 Compression.** Enabled when `COMPRESSION_ENABLED=true` (default true), with a threshold of 1 kb. It skips `application/gzip` and responses with `Cache-Control: no-transform`.
- **NFR-HTTP-5 Trust proxy.** Set from `TRUST_PROXY`: an integer hop count of 0 or more, default 0 = off. The production default is not hard-coded. The README documents setting it to the number of proxies.
- **NFR-HTTP-6 Timeouts.** `server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS` (default 65000), and `headersTimeout` is set above it. `requestTimeout = HTTP_REQUEST_TIMEOUT_MS` (default 120000).
- **NFR-HTTP-7 Throttling.** Named throttlers `default` (`THROTTLE_*`) and `auth` (`AUTH_THROTTLE_*`) are configured only in `ThrottlerModule.forRootAsync` from ConfigService.
  - The `auth` limit applies only to register, login, refresh, forgot, reset and resend.
  - No `process.env` reads remain in decorators, and `import 'dotenv/config'` is removed from `main.ts`.
  - Health routes skip all throttlers.
  - The README states that the in-memory store is per instance.
- **NFR-HTTP-8 Health.** Both probes are `@Public`, skip throttling and sit outside the API prefix.
  - `GET /health/live` returns 200 without DB access.
  - `GET /health` (readiness) checks DB, pgvector and heap. On failure it returns 503 with indicator names and status but **no raw error text** when `NODE_ENV=production`.
  - During shutdown, readiness returns 503.
- **NFR-HTTP-9 Lifecycle.**
  - A boot failure logs at `fatal` and exits with code 1.
  - `unhandledRejection` is logged at `error`. `uncaughtException` is logged at `fatal`, then the process exits with code 1.
  - On SIGTERM or SIGINT: stop accepting connections, finish in-flight requests, stop the cleanup job, `$disconnect` Prisma, and exit 0.
- **NFR-HTTP-10 Swagger.** Disabled in production regardless of `SWAGGER_ENABLED`, as today. All new routes are documented, including error responses.
- **NFR-HTTP-11 Helmet.** Kept. Swagger (non-production only) may relax CSP for its own path.

### 7.3 Logging (NFR-LOG)

- **NFR-LOG-1** The redact paths add:
  - `req.body.token`, `req.body.refreshToken`, `req.body.password` (existing), `req.body.newPassword` (existing), `req.body.currentPassword` (existing)
  - `req.headers["x-api-key"]`
  - `res.headers["set-cookie"]` (existing)

  SMTP credentials are never logged, including in config dumps.
- **NFR-LOG-2** Auto-log ignore matches the exact paths `/health`, `/health/live` and `/favicon.ico`, not substrings.
- **NFR-LOG-3** When authenticated, the request log context includes `userId`. It never includes the email.

### 7.4 Config (NFR-CFG)

- **NFR-CFG-1** Every new variable below is in `EnvironmentVariables` (validated), in `configuration.ts` (typed) and in `.env.example` (commented). Boot fails with a single report that lists every invalid variable.
- **NFR-CFG-2** New variables:

  | Group | Variables |
  |---|---|
  | App | `FRONTEND_URL` (required, http(s) URL, https in production), `TRUST_PROXY` |
  | HTTP | `HTTP_JSON_LIMIT`, `HTTP_LARGE_JSON_LIMIT` (size strings like `1mb`), `HTTP_KEEP_ALIVE_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `COMPRESSION_ENABLED` |
  | Auth | `AUTH_SESSION_ABSOLUTE_TTL`, `AUTH_REFRESH_REUSE_GRACE_SECONDS` (0–60), `AUTH_MAX_SESSIONS_PER_USER` (1–100), `AUTH_LOCKOUT_THRESHOLD` (1–100), `AUTH_LOCKOUT_DURATION_MS`, `AUTH_EMAIL_VERIFICATION_TTL`, `AUTH_PASSWORD_RESET_TTL`, `AUTH_REQUIRE_VERIFIED_EMAIL`, `AUTH_CLEANUP_INTERVAL_MS` |
  | Mail | `MAIL_TRANSPORT` (`log`/`smtp`), `MAIL_FROM` (email or `Name <email>`), `MAIL_SEND_TIMEOUT_MS`, and `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, all required when `MAIL_TRANSPORT=smtp` |
  | Projects | `PROJECTS_MAX_PER_USER`, `PROJECT_OBJECT_MAX_BYTES` (max 100 MiB), `PROJECT_OBJECTS_MAX_PER_PROJECT` |

- **NFR-CFG-3** Cross-field rules, enforced at boot:
  - `JWT_ACCESS_SECRET ≠ JWT_REFRESH_SECRET`.
  - In production, secrets may not contain `replace-me` or `change-me`.
  - Access TTL ≤ 1h, refresh TTL > access TTL, and `AUTH_SESSION_ABSOLUTE_TTL ≥ JWT_REFRESH_TTL`.
  - `COOKIE_SAME_SITE=none` requires `COOKIE_SECURE=true`.
  - Production requires `COOKIE_SECURE=true` (error, not a warning).
  - Production forbids `MAIL_TRANSPORT=log` and `LOG_PRETTY=true`.
- **NFR-CFG-4** Defaults are renamed from boilerplate: `JWT_ISSUER=qdonis-api`, `JWT_AUDIENCE=qdonis-web`, pg `application_name=qdonis-backend`, package name `qdonis-backend`, Swagger title "Qdonis API".

### 7.5 Data (NFR-DATA)

- **NFR-DATA-1** Schema files, one model per file:
  - `user/user.prisma` (extended)
  - `user/auth-token.prisma`
  - `enums/auth-token-type.prisma`
  - `projects/project.prisma`
  - `projects/simulation.prisma`
  - `projects/project-object.prisma`

  All tables use `@@map` snake_case and UUID PKs, and carry `createdAt` and `updatedAt`. The exception is append-only `AuthToken`, which has only `createdAt`.
- **NFR-DATA-2** `User` gains `emailVerifiedAt?`, `avatarUrl?`, `legacyClerkId? @unique`, `passwordChangedAt?`, `failedLoginAttempts Int @default(0)`, `lockedUntil?` and `lastSeenAt?`. `passwordHash` becomes nullable.

  `Session` gains `authenticatedAt` (backfilled from `created_at`). `revokedReason` stays a string, but values come from one constant set.
- **NFR-DATA-3** Relations and indexes:
  - User → Session, AuthToken and Project cascade on delete.
  - Project → Simulation and ProjectObject cascade on delete.
  - Indexes: `projects(user_id, updated_at desc)`; unique `simulations(project_id)`; unique `project_objects(project_id, name)`; `auth_tokens(user_id, type)`; unique `auth_tokens(token_hash)`; `auth_tokens(expires_at)`.
  - Drop the redundant `users_email_idx`.
- **NFR-DATA-4** Soft delete is **not** introduced. The current frontend semantics are hard delete, and account deletion must actually remove personal data. This is recorded as a deliberate decision.
- **NFR-DATA-5** Every multi-write operation is a single Prisma transaction:
  - rotation,
  - session-cap enforcement,
  - password reset,
  - admin last-admin checks,
  - duplicate,
  - import row,
  - object upsert with the count check.
- **NFR-DATA-6** Ownership is enforced in the repository query (`where: { id, userId }`), not by fetching and then comparing in the controller. Services own business rules: caps, versions, last-admin.
- **NFR-DATA-7** Migrations:
  - Delete the empty `prisma/migrations/20261006000000_user_legacy_clerk_id/` folder. It holds no SQL, so it was never applied. If a DB is reachable, confirm it is absent from `_prisma_migrations` first; if it is present, stop and ask.
  - Generate **one new** migration with `prisma migrate dev`.
  - `20260824000000_init` is not edited.
  - The new migration must apply cleanly to a DB at the init state that contains existing user rows (nullable or defaulted columns, backfill `authenticated_at`).
- **NFR-DATA-8** `prisma/seed.ts` refuses to run when `NODE_ENV=production`, exiting with code 1. Seeded users have `emailVerifiedAt` set.

### 7.6 Code quality (NFR-CODE)

- **NFR-CODE-1** Repository → service → controller everywhere. This includes extracting `SessionsRepository`, and adding `AuthTokensRepository`, `ProjectsRepository` and similar.
- **NFR-CODE-2** No new `process.env` reads outside `config/`, `prisma.config.ts` and `prisma/seed.ts`.
- **NFR-CODE-3** New dependencies are pinned to exact versions. Only these are expected: `nodemailer` + `@types/nodemailer`, and `compression` + `@types/compression`. A cleanup scheduler, if any, should use Nest's own primitives or `@nestjs/schedule`. Any other addition must be justified in the design.
- **NFR-CODE-4** `npm run build`, `npm run lint:check`, `npm run typecheck`, `npx prisma validate` and `npm test` all pass.

### 7.7 Tests (NFR-TEST)

- **NFR-TEST-1** Unit tests (jest, no DB):
  - `AuthService`: login failures are uniform, lockout thresholds, refresh rotation, the grace window vs reuse, absolute TTL.
  - Token service: hash storage, expiry, single-use, type mismatch.
  - `UsersService`: last-admin, self-modification, legacy import rules.
  - `ProjectsService`: version conflict, caps.
  - `AllExceptionsFilter`: every row of NFR-ERR-2.
  - `validateEnv`: every rule of NFR-CFG-3.
  - Request-ID sanitization.
- **NFR-TEST-2** e2e tests (`test/*.e2e-spec.ts`, supertest) run against `DATABASE_URL` from `.env.test` and are skipped with a clear message when it is absent. Coverage:
  - the register → verify → login → refresh → logout flow,
  - forgot/reset,
  - IDOR (user B gets 404 on every project, simulation and object route of user A),
  - CORS rejection,
  - body limits,
  - health.

## 8. Acceptance criteria

### Auth

1. `POST /auth/login` with `{"email":"a@b.co","password":{"x":1}}`, or a 129-character password, returns 400 `VALIDATION_FAILED`, and no Argon2 verify runs (asserted by a spy in a unit test).
2. Login with an unknown email, a wrong password, an inactive user, a locked user and a legacy user with no password each returns 401 with byte-identical bodies, apart from `timestamp`, `requestId` and `path`.
3. After 5 consecutive wrong passwords, a 6th attempt with the *correct* password returns 401. After `AUTH_LOCKOUT_DURATION_MS` it succeeds and `failedLoginAttempts` is 0.
4. Firing 5 wrong-password requests concurrently ends with the lock applied (no lost increments).
5. Two concurrent `POST /auth/refresh` calls with the same cookie produce exactly one new session row. The other call returns 401 `REFRESH_CONFLICT`, and the user's other sessions remain active.
6. Replaying a rotated refresh token after the grace window returns 401 `SESSION_REVOKED`, and every session of that user has `revoked_at` set with reason `reuse_detected`.
7. A session whose `authenticated_at` is older than `AUTH_SESSION_ABSOLUTE_TTL` cannot be refreshed (401 `SESSION_EXPIRED`), even though its latest rotation is recent. The response clears the cookie.
8. `POST /auth/logout` with an expired access token and a valid refresh cookie returns 204 and revokes the session. With no credentials at all it also returns 204.
9. `POST /auth/refresh` with `Origin: https://evil.example` returns 403 `ORIGIN_NOT_ALLOWED` and does not rotate.
10. The 11th login for the same user, with the default cap of 10, leaves exactly 10 active sessions, and the oldest has reason `session_limit`.
11. `DELETE /auth/sessions/<other user's session id>` and `DELETE /auth/sessions/<random uuid>` both return 404 `SESSION_NOT_FOUND`.
12. `POST /auth/password/forgot` returns 202 with identical bodies for an existing and a non-existing email. A mail is sent only for the existing one (asserted through the log transport or a mock).
13. A reset token works exactly once. A second use, an expired token, a verification token used as a reset token, and a random string all return 400 `INVALID_TOKEN`.
14. After a successful reset:
    - all of the user's sessions are revoked (an old access token gets 401 on `/auth/me`),
    - the lockout is cleared,
    - `emailVerifiedAt` is set,
    - the new password logs in.
15. Requesting a second reset token invalidates the first.
16. `POST /auth/password/change` revokes every session except the current one, and the current access token keeps working.
17. The DB stores only SHA-256 hashes for refresh, verification and reset tokens. A grep of a test DB dump for an issued token returns nothing.
18. No request log line contains a password, a token, the `Authorization` header or the cookie value (tested by capturing pino output during the e2e auth flow).

### Users / admin

19. A USER calling `PATCH /users/me {"role":"ADMIN"}` gets 400, and the role is unchanged. `PATCH /users/me {"avatarUrl":"http://x"}` gets 400.
20. The only admin calling `PATCH /users/<self> {"isActive":false}`, `{"role":"USER"}` or `DELETE /users/<self>` gets 409. When two admins demote each other concurrently, at least one admin remains.
21. When an admin deactivates a user, the target's next request returns 401, and all of the target's sessions are revoked.
22. `POST /users/import` run twice with the same 3 rows reports `created: 3` the first time and `updated: 3` the second, without duplicates. A row whose email belongs to a user linked to a different `legacyClerkId` appears in `conflicts`, and the other rows still commit. A batch of 501 rows returns 400.
23. An imported user can complete forgot → reset → login.
24. `DELETE /users/me` with the correct password removes the user, their sessions, projects, simulations and objects. Their documents remain with `user_id = NULL`.

### Projects / simulation / objects

25. User B gets 404 on `GET`, `PATCH` and `DELETE /projects/:idA`, on `/duplicate`, on `/simulation` (GET/PUT/DELETE) and on `/objects/*` (GET/PUT/DELETE/list) for user A's project. A's data is unchanged afterwards.
26. `GET /projects?take=101` returns 400. `GET /projects` items have no `projectData`, and `total` equals the user's project count.
27. `PATCH` with a stale `expectedVersion` returns 409 `VERSION_CONFLICT` and does not change data. When two concurrent PATCHes carry the same `expectedVersion`, exactly one succeeds.
28. A `PUT /projects/:id/simulation` sent twice leaves one row. The second updates it.
29. An object PUT over `PROJECT_OBJECT_MAX_BYTES` returns 413. A name of `../x` or `a/b` returns 400. `Content-Type: text/plain` returns 415. A GET returns exactly the uploaded bytes, with a SHA-256 `ETag`.
30. `POST /projects/:id/duplicate` copies the project, its simulation and its objects. If an injected failure occurs mid-copy, no partial project remains.
31. A 2 MB `projectData` PATCH succeeds. A 2 MB body on `POST /auth/login` returns 413 `PAYLOAD_TOO_LARGE`.

### Infrastructure / config

32. A request from a non-allowlisted origin returns its normal status with no `Access-Control-Allow-Origin` header. It is never a 500.
33. Every response carries `X-Request-Id`. A valid incoming ID is echoed. An invalid one (`<script>`, or more than 128 characters) is replaced with a UUID. Error bodies include the same `requestId`.
34. A malformed JSON body returns 400 `MALFORMED_JSON` in the envelope. An unknown route returns 404 in the envelope.
35. With the DB stopped:
    - `/health/live` returns 200,
    - `/health` returns 503 with no error text in production mode,
    - an API call returns 503 `DB_UNAVAILABLE`.
36. Boot fails with a readable list for each of these:
    - equal JWT secrets,
    - `COOKIE_SAME_SITE=none` + `COOKIE_SECURE=false`,
    - production with `COOKIE_SECURE=false`,
    - production with `MAIL_TRANSPORT=log`,
    - `MAIL_TRANSPORT=smtp` without `SMTP_HOST`,
    - a `CORS_ORIGINS` entry `*` or with a path,
    - a missing `FRONTEND_URL`.
37. `grep -rn "process.env" src` matches only files under `src/config/`. `main.ts` has no `dotenv/config` import.
38. After SIGTERM, in-flight requests finish, `/health` returns 503, Prisma disconnects, and the process exits 0.
39. `.env.example` contains every variable in `EnvironmentVariables`, and the reverse. This is checked by a unit test.

### Data / migrations / quality

40. The empty `20261006000000_user_legacy_clerk_id` folder is gone. Exactly one new migration exists. `20260824000000_init/migration.sql` is byte-identical to HEAD.
41. `npx prisma migrate deploy` on a fresh DB, and on a DB at the init state that holds user rows, both succeed. After that, `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema --exit-code` reports no drift.
42. `npm run db:seed` with `NODE_ENV=production` exits non-zero without writing.
43. `npm run build`, `npm run lint:check`, `npm run typecheck`, `npx prisma validate` and `npm test` pass. The e2e suite passes when a test DB is configured.

## 9. Out of scope

- Any change to `qdonis/` (frontend) or `qdonis-core/` (Python), including:
  - rewriting the frontend from Clerk/Supabase to this API,
  - replacing `sendBeacon` with `fetch keepalive`,
  - removing `VITE_CLERK_SECRET_KEY`,
  - adding auth to the Python endpoints.
- Google/OAuth login (D1), MFA/TOTP, passkeys, magic links.
- Email change flow (it requires re-verification of the new address). Email is immutable for self-service in this task.
- Importing Clerk bcrypt password digests (D5).
- RS256/JWKS signing and service-to-service token verification (D6).
- Porting the deferred Supabase domains and their edge functions:
  - sharing, teams, invitations,
  - subscriptions/Stripe,
  - token usage,
  - chat history,
  - mouser cache,
  - admin settings,
  - project versions/activity log,
  - `bedrock-proxy`.
- The data-migration script that copies existing Supabase rows and storage objects into the new tables. `legacyClerkId` and `GET /users/by-legacy-id` are the hooks for it.
- Distributed rate-limit store (Redis), object storage (S3), and soft delete.
- Changes to the `documents` (pgvector) module beyond what the cascade and error-mapping rules require.

## 10. Assumptions

1. Clerk OAuth providers are not visible in code. Google is assumed to be the one that matters (D1).
2. `projects.user_id` and `simulation_plots` in Supabase hold Clerk user IDs as TEXT. `user_profiles` and RLS policies confirm this, but the `projects` DDL is not in the repo's Supabase migrations, so this is inferred from `supabaseClient.ts` types and RLS usage.
3. Full-resolution plot objects are gzip JSON under 25 MiB. The cap is configurable.
4. The frontend and API will be same-site in production (e.g. `app.` and `api.` subdomains of one domain), so `SameSite=Lax` works. Otherwise, set `COOKIE_SAME_SITE=none` + `COOKIE_SECURE=true`.
5. A single instance is assumed for the in-memory throttler and the cleanup job. Multi-replica deployments need the backlogged Redis store, and the cleanup job must stay idempotent so it is safe to run concurrently.


## USER DECISIONS (authoritative — override any conflicting default above)

Received from the user after requirements were written. Design, plan, and implementation MUST follow these.

1. **Google OAuth: YES.** Implement real Google sign-in (OAuth 2.0 / OIDC authorization-code flow with `state` + PKCE, verify ID token signature/issuer/audience/expiry, require `email_verified`). Account linking rules: link Google identity to an existing local account only when the Google email is verified and matches; store provider identities in their own model (e.g. `user/oauth-account.prisma`, unique on provider + providerAccountId). Google client id/secret/redirect URI go through EnvironmentVariables validation, configuration.ts, and .env.example; secrets added to pino redact.
2. **Email: Gmail SMTP via nodemailer** (pinned exact version). Config: SMTP host `smtp.gmail.com`, port 465 (secure) or 587 (STARTTLS), user + Gmail App Password, from-address — all validated env vars, password redacted in logs. Used for email verification and password reset (and optionally new-login/security notices). Behind a mailer interface; send failures must be logged and surfaced properly, never swallowed, and must not leak whether an account exists. A dev/test fake implementation is allowed only for tests, not as the production path.
3. **No legacy data migration.** Do NOT import or migrate any Clerk or Supabase user/auth data. No Clerk-ID linking flow, no Clerk/Supabase JWT verification. Auth is fully our own: Postgres + Prisma + NestJS. The existing `legacyClerkId` field/migration is now unused — remove it via a NEW migration (never edit the applied one) and remove any code that references it; note this in the report.
4. **Scope = auth first.** The priority of this run is a complete, real, production-grade auth system — no dummy/stub/placeholder logic anywhere. Porting Supabase app data (simulations etc.) is OUT of scope for this run unless already trivial; record it as follow-up in the report.
5. **Proper tokens & security (non-negotiable):** short-lived access JWT (~15 min) + rotating opaque or JWT refresh token stored only as a hash in DB, family-based reuse detection that revokes the whole session family, per-session revocation and logout-all, refresh token delivered as httpOnly + Secure + SameSite cookie scoped to the refresh path (access token as bearer), CSRF protection for cookie-based endpoints, argon2id (or bcrypt cost ≥12) password hashing, password strength policy, login rate limiting + progressive lockout, hashed single-use expiring tokens for email verification and password reset (reset invalidates all sessions), timing-safe comparisons, user-enumeration-resistant responses, JWT secrets validated for length at boot, distinct secrets for access vs refresh, `iss`/`aud` claims checked.

6. **Credentials come later.** The user will supply the Gmail App Password and Google OAuth client id/secret afterwards. Do not block or pause on them. Build the full real implementation, add the vars to .env.example with clear comments, and have boot-time validation require them (fail fast) in production. Unit tests mock the SMTP transport and Google token verification. In the report, state that live SMTP and Google login could not be verified end-to-end without credentials.
