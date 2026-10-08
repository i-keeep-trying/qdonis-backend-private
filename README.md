# Backend Boilerplate

NestJS + PostgreSQL (pgvector) + Prisma 7, with local-strategy authentication
using short-lived JWT access tokens and database-backed refresh sessions.

## Stack

| Concern        | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| Framework      | NestJS 11 (structure generated with the Nest CLI)             |
| Database       | PostgreSQL 18 + pgvector 0.8.6                                |
| ORM            | Prisma 7 via the `@prisma/adapter-pg` driver adapter          |
| Auth           | Passport local + JWT, Argon2id hashing, rotating refresh sessions |
| Validation     | `class-validator` / `class-transformer`, global `ValidationPipe` |
| Hardening      | Helmet, credentialed CORS allowlist, rate limiting            |
| Observability  | Pino structured logs, Terminus health probes                  |
| Docs           | Swagger at `/docs`                                            |

## Layout

```
src/
  config/       env validation + typed configuration
  prisma/       PrismaService (driver adapter, pooling, lifecycle)
  auth/         strategies, guards, sessions, controller
  users/        repository -> service -> controller, Argon2id hashing
  documents/    pgvector demo: raw-SQL vector writes + similarity search
  health/       liveness and readiness probes
  common/       filters, interceptors, decorators, shared DTOs
  generated/    Prisma Client output (git-ignored, regenerate on install)
prisma/
  schema/       multi-file schema, merged by Prisma (see below)
  migrations/   SQL migration history
  seed.ts       demo data
client/         standalone page for testing the API from a browser
scripts/        pgvector build/install helpers, Nest CLI generation scripts
```

### Prisma schema layout

`prisma.config.ts` points `schema` at the `prisma/schema/` **directory**, so
Prisma concatenates every `*.prisma` file underneath it — subfolders included —
into one schema before validating:

```
prisma/schema/
  _base.prisma           generator + datasource (declared exactly once)
  enums/role.prisma
  user/user.prisma
  user/session.prisma
  documents/document.prisma
```

Model, enum and type names share one namespace across all files, so there are no
imports and no two files may declare the same name. Add a model by dropping in a
new `.prisma` file; nothing needs registering.

## Setup

1. **Install pgvector** (already done on this machine; needed on new ones).
   Requires MSVC build tools on Windows, then run as Administrator:

   ```powershell
   git clone --depth 1 --branch v0.8.6 https://github.com/pgvector/pgvector.git $env:TEMP\pgvector-build
   scripts\install-pgvector.bat
   ```

2. **Configure environment.** Copy `.env.example` to `.env` and set at minimum
   `DATABASE_URL` plus the two JWT secrets:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

3. **Install, migrate, seed.**

   ```powershell
   npm install
   npm run prisma:migrate:deploy
   npm run db:seed          # optional demo accounts
   ```

4. **Run.**

   ```powershell
   npm run start:dev
   ```

   - API: `http://localhost:3000/api/v1`
   - Health: `http://localhost:3000/health`
   - Docs: `http://localhost:3000/docs`

## Testing the frontend connection

`client/index.html` is a standalone page that drives the whole auth flow
(register, silent refresh on 401, rotation, session listing, logout) plus the
vector endpoints. Serve it from an origin listed in `CORS_ORIGINS` so the
credentialed CORS path and the httpOnly refresh cookie are genuinely exercised —
opening the file directly with `file://` will not work, because a `null` origin
cannot be allowed alongside credentials.

With the VS Code Live Server extension, "Open with Live Server" serves it on
`http://127.0.0.1:5500`, which is already in the default allowlist. Then press
**Run full flow**.

## Auth design

The API is both token-based and session-based, which is what makes stateless
JWTs revocable:

- **Access token** — JWT, 15 minutes, sent as `Authorization: Bearer`. Carries a
  `sid` claim identifying its session.
- **Refresh token** — JWT, 7 days, delivered only as an httpOnly cookie scoped to
  `/api/v1/auth`. Stored as a SHA-256 digest in the `sessions` table.
- **Rotation** — every refresh issues a new session row and revokes the old one.
- **Reuse detection** — presenting a refresh token whose session is already
  revoked revokes *every* session for that user, on the assumption the token was
  stolen.
- **Immediate revocation** — `JwtStrategy` re-checks the account and its session
  on each request, so logout and deactivation take effect at once rather than at
  token expiry.

Authentication is deny-by-default: `JwtAuthGuard` is global and routes opt out
with `@Public()`. Authorisation is opt-in per controller with `@Roles()`.

## Notes and limitations

- Rate limiting uses in-memory storage, so limits are per process. Add a shared
  store (e.g. Redis) before running multiple replicas.
- Embeddings are supplied by the client; no embedding provider is wired in.
  `EMBEDDING_DIMENSIONS` must match the `vector(1536)` column, so changing it
  needs a migration.
- `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none` are required for a
  cross-site frontend in production, which in turn requires HTTPS.
- No tests are included beyond the Jest setup.
