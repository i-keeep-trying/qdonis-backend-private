import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { GoogleOAuthClient } from '../src/auth/oauth/google-oauth.client';
import { Role } from '../src/generated/prisma/enums';
import { type MailMessage, MailTransport } from '../src/mail/mail.transport';
import { PrismaService } from '../src/prisma/prisma.service';

/** Collects outgoing mail so tests can read the links. */
class CapturingTransport extends MailTransport {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  verify(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
  /** Token from the latest email to `to` whose link contains `path`. */
  tokenFor(to: string, path: string): string {
    const message = [...this.sent]
      .reverse()
      .find((entry) => entry.to === to && entry.text.includes(path));
    const match = message ? /token=([A-Za-z0-9_-]+)/.exec(message.text) : null;
    if (!match) throw new Error(`No ${path} email for ${to}`);
    return match[1];
  }
}

const PREFIX = '/api/v1';
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery-1';
const run = Date.now().toString(36);
let counter = 0;
const newEmail = (): string => `user-${run}-${++counter}@e2e.test`;

interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string;
}
interface AuthBody {
  accessToken: string;
  expiresIn: number;
  user: Record<string, unknown>;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('Auth (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;
  const mail = new CapturingTransport();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { endsWith: '@e2e.test' } },
    });
    await app.close();
  });

  // --- helpers -------------------------------------------------------------

  const refreshCookie = (res: request.Response): string | null => {
    const raw = res.headers['set-cookie'] as unknown;
    const cookies = Array.isArray(raw) ? (raw as string[]) : [];
    const hit = cookies.find((cookie) => cookie.startsWith('qd_refresh='));
    if (!hit) return null;
    const value = hit.split(';')[0];
    return value === 'qd_refresh=' ? '' : value;
  };

  const register = (email: string, password = PASSWORD) =>
    request(http)
      .post(`${PREFIX}/auth/register`)
      .send({ email, password, name: 'E2E User' });

  const login = (email: string, password = PASSWORD) =>
    request(http).post(`${PREFIX}/auth/login`).send({ email, password });

  const refresh = (cookie: string) =>
    request(http)
      .post(`${PREFIX}/auth/refresh`)
      .set('Origin', ORIGIN)
      .set('Cookie', cookie);

  /** Registers, verifies and logs in. */
  async function verifiedUser(): Promise<{
    email: string;
    token: string;
    cookie: string;
  }> {
    const email = newEmail();
    await register(email).expect(201);
    await flush();
    await request(http)
      .post(`${PREFIX}/auth/email/verification/confirm`)
      .send({ token: mail.tokenFor(email, '/verify-email') })
      .expect(204);
    const res = await login(email).expect(200);
    return {
      email,
      token: (res.body as AuthBody).accessToken,
      cookie: refreshCookie(res) as string,
    };
  }

  // --- registration & verification -------------------------------------

  describe('registration and email verification', () => {
    it('registers without starting a session and mails a verification link', async () => {
      const email = newEmail();
      const res = await register(email).expect(201);
      const body = res.body as {
        verificationRequired: boolean;
        user: Record<string, unknown>;
      };

      expect(body.verificationRequired).toBe(true);
      expect(body.user).toMatchObject({
        email,
        emailVerified: false,
        hasPassword: true,
      });
      expect(body.user).not.toHaveProperty('passwordHash');
      expect(refreshCookie(res)).toBeNull();
      await flush();
      expect(mail.tokenFor(email, '/verify-email')).toHaveLength(43);
    });

    it('normalises email case and rejects duplicates with EMAIL_TAKEN', async () => {
      const email = newEmail();
      await register(email.toUpperCase()).expect(201);
      const res = await register(`  ${email}  `).expect(409);
      expect((res.body as ErrorBody).code).toBe('EMAIL_TAKEN');
    });

    it('resolves concurrent duplicate registrations to exactly one account', async () => {
      const email = newEmail();
      const results = await Promise.all([
        register(email),
        register(email),
        register(email),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('rejects weak passwords, unknown fields and role escalation', async () => {
      const weak = await register(newEmail(), 'short1').expect(400);
      expect((weak.body as ErrorBody).code).toBe('VALIDATION_FAILED');

      const escalate = await request(http)
        .post(`${PREFIX}/auth/register`)
        .send({ email: newEmail(), password: PASSWORD, role: Role.ADMIN })
        .expect(400);
      expect((escalate.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it('blocks login until verified, then verifies with a single-use token', async () => {
      const email = newEmail();
      await register(email).expect(201);
      await flush();

      const blocked = await login(email).expect(403);
      expect((blocked.body as ErrorBody).code).toBe('EMAIL_NOT_VERIFIED');

      const token = mail.tokenFor(email, '/verify-email');
      const confirm = (t: string) =>
        request(http)
          .post(`${PREFIX}/auth/email/verification/confirm`)
          .send({ token: t });
      await confirm(token).expect(204);
      const reused = await confirm(token).expect(400);
      expect((reused.body as ErrorBody).code).toBe('INVALID_TOKEN');

      await login(email).expect(200);
    });

    it('makes only the newest verification link valid after a resend', async () => {
      const email = newEmail();
      await register(email).expect(201);
      await flush();
      const first = mail.tokenFor(email, '/verify-email');

      await request(http)
        .post(`${PREFIX}/auth/email/verification/resend`)
        .send({ email })
        .expect(202);
      await flush();
      const second = mail.tokenFor(email, '/verify-email');
      expect(second).not.toBe(first);

      await request(http)
        .post(`${PREFIX}/auth/email/verification/confirm`)
        .send({ token: first })
        .expect(400);
      await request(http)
        .post(`${PREFIX}/auth/email/verification/confirm`)
        .send({ token: second })
        .expect(204);
    });

    it('answers resend identically for unknown emails', async () => {
      const res = await request(http)
        .post(`${PREFIX}/auth/email/verification/resend`)
        .send({ email: newEmail() })
        .expect(202);
      expect(res.body).toEqual({
        message:
          'If an account exists for that email, a message is on its way.',
      });
    });
  });

  // --- login ---------------------------------------------------------------

  describe('login', () => {
    it('issues a bearer token and an httpOnly, path-scoped refresh cookie', async () => {
      const { email } = await verifiedUser();
      const res = await login(email).expect(200);
      const body = res.body as AuthBody;

      expect(body.accessToken.split('.')).toHaveLength(3);
      expect(body.expiresIn).toBe(900);
      const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('qd_refresh='),
      );
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/Path=\/api\/v1\/auth/);
      expect(raw).toMatch(/SameSite=Lax/i);

      const me = await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      expect(me.body).toMatchObject({
        email,
        emailVerified: true,
        hasPassword: true,
      });
      expect(JSON.stringify(me.body)).not.toMatch(
        /passwordHash|failedLogin|lockedUntil/,
      );
    });

    it('returns identical errors for wrong password and unknown email', async () => {
      const { email } = await verifiedUser();
      const wrong = await login(email, 'not-the-password-1').expect(401);
      const unknown = await login(newEmail()).expect(401);
      const pick = (b: ErrorBody) => ({
        code: b.code,
        message: b.message,
        status: b.statusCode,
      });
      expect(pick(wrong.body as ErrorBody)).toEqual(
        pick(unknown.body as ErrorBody),
      );
      expect((wrong.body as ErrorBody).code).toBe('INVALID_CREDENTIALS');
    });

    it('validates the body before hashing (oversized password → 400)', async () => {
      const res = await login(newEmail(), 'a'.repeat(5_000)).expect(400);
      expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it('locks the account after repeated failures, even for the right password', async () => {
      const { email } = await verifiedUser();
      for (let i = 0; i < 5; i++)
        await login(email, 'wrong-password-123').expect(401);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.lockedUntil?.getTime()).toBeGreaterThan(Date.now());

      const locked = await login(email).expect(401);
      expect((locked.body as ErrorBody).code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects deactivated accounts and revokes their access immediately', async () => {
      const { email, token } = await verifiedUser();
      await prisma.user.update({ where: { email }, data: { isActive: false } });
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      await login(email).expect(401);
    });

    it('caps active sessions per user, revoking the oldest', async () => {
      const { email, token: oldest } = await verifiedUser();
      for (let i = 0; i < 3; i++) await login(email).expect(200);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(
        await prisma.session.count({
          where: { userId: user.id, revokedAt: null },
        }),
      ).toBe(3);
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${oldest}`)
        .expect(401);
    });
  });

  // --- refresh rotation ----------------------------------------------------

  describe('refresh', () => {
    it('rotates the refresh token and returns a working access token', async () => {
      const { cookie } = await verifiedUser();
      const res = await refresh(cookie).expect(200);
      const rotated = refreshCookie(res);
      expect(rotated).toBeTruthy();
      expect(rotated).not.toBe(cookie);
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${(res.body as AuthBody).accessToken}`)
        .expect(200);
    });

    it('lets exactly one of two concurrent refreshes win; the loser gets REFRESH_CONFLICT', async () => {
      const { cookie } = await verifiedUser();
      const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
      const loser = a.status === 401 ? a : b;
      expect((loser.body as ErrorBody).code).toBe('REFRESH_CONFLICT');
      // The loser must not clear the cookie the winner just set.
      expect(refreshCookie(loser)).toBeNull();
    });

    it('treats replay of a rotated token after the grace window as theft and revokes the family', async () => {
      const { cookie } = await verifiedUser();
      const first = await refresh(cookie).expect(200);
      const current = refreshCookie(first) as string;
      const access = (first.body as AuthBody).accessToken;

      await new Promise((resolve) => setTimeout(resolve, 1_300));
      const replay = await refresh(cookie).expect(401);
      expect((replay.body as ErrorBody).code).toBe('SESSION_REVOKED');
      expect(refreshCookie(replay)).toBe('');

      // The legitimate holder's newer token and access token are dead too.
      await refresh(current).expect(401);
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${access}`)
        .expect(401);
    });

    it('rejects missing cookies, garbage tokens and foreign origins', async () => {
      const missing = await request(http)
        .post(`${PREFIX}/auth/refresh`)
        .set('Origin', ORIGIN)
        .expect(401);
      expect((missing.body as ErrorBody).code).toBe('REFRESH_TOKEN_MISSING');

      await refresh('qd_refresh=not-a-real-token').expect(401);

      const { cookie } = await verifiedUser();
      const evil = await request(http)
        .post(`${PREFIX}/auth/refresh`)
        .set('Origin', 'https://evil.example')
        .set('Cookie', cookie)
        .expect(403);
      expect((evil.body as ErrorBody).code).toBe('ORIGIN_NOT_ALLOWED');
      // The legitimate cookie still works afterwards.
      await refresh(cookie).expect(200);
    });

    it('enforces the absolute session lifetime', async () => {
      const { email, cookie } = await verifiedUser();
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { authenticatedAt: new Date(Date.now() - 31 * 86_400_000) },
      });
      const res = await refresh(cookie).expect(401);
      expect((res.body as ErrorBody).code).toBe('SESSION_EXPIRED');
    });
  });

  // --- logout & sessions ---------------------------------------------------

  describe('logout and sessions', () => {
    it('logs out with the cookie and kills the access token', async () => {
      const { token, cookie } = await verifiedUser();
      const res = await request(http)
        .post(`${PREFIX}/auth/logout`)
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .expect(204);
      expect(refreshCookie(res)).toBe('');
      const after = await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect((after.body as ErrorBody).code).toBe('SESSION_REVOKED');
      await refresh(cookie).expect(401);
    });

    it('logs out with only a bearer token, and is a no-op without credentials', async () => {
      const { token, cookie } = await verifiedUser();
      await request(http)
        .post(`${PREFIX}/auth/logout`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await refresh(cookie).expect(401);
      await request(http).post(`${PREFIX}/auth/logout`).expect(204);
    });

    it('lists sessions and only lets users revoke their own', async () => {
      const a = await verifiedUser();
      const b = await verifiedUser();

      const list = await request(http)
        .get(`${PREFIX}/auth/sessions`)
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);
      const sessions = list.body as Array<{ id: string; current: boolean }>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].current).toBe(true);
      expect(JSON.stringify(list.body)).not.toMatch(/refreshTokenHash/);

      const foreign = await request(http)
        .delete(`${PREFIX}/auth/sessions/${sessions[0].id}`)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(404);
      expect((foreign.body as ErrorBody).code).toBe('SESSION_NOT_FOUND');
      await request(http)
        .delete(`${PREFIX}/auth/sessions/00000000-0000-4000-8000-000000000000`)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(404);

      await request(http)
        .delete(`${PREFIX}/auth/sessions/${sessions[0].id}`)
        .set('Authorization', `Bearer ${a.token}`)
        .expect(204);
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${a.token}`)
        .expect(401);
    });

    it('logout-all revokes every device', async () => {
      const { email, token } = await verifiedUser();
      const second = await login(email).expect(200);
      await request(http)
        .post(`${PREFIX}/auth/logout-all`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${(second.body as AuthBody).accessToken}`)
        .expect(401);
    });

    it('rejects missing, malformed and tampered access tokens with UNAUTHENTICATED', async () => {
      const { token } = await verifiedUser();
      const none = await request(http).get(`${PREFIX}/auth/me`).expect(401);
      expect((none.body as ErrorBody).code).toBe('UNAUTHENTICATED');
      const tampered = `${token.slice(0, -2)}xx`;
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });
  });

  // --- passwords -----------------------------------------------------------

  describe('password reset and change', () => {
    it('answers forgot-password identically for known and unknown emails', async () => {
      const { email } = await verifiedUser();
      const known = await request(http)
        .post(`${PREFIX}/auth/password/forgot`)
        .send({ email })
        .expect(202);
      const unknown = await request(http)
        .post(`${PREFIX}/auth/password/forgot`)
        .send({ email: newEmail() })
        .expect(202);
      expect(known.body).toEqual(unknown.body);
    });

    it('resets the password once, revokes all sessions and clears lockout', async () => {
      const { email, token, cookie } = await verifiedUser();
      for (let i = 0; i < 5; i++)
        await login(email, 'wrong-password-123').expect(401);

      await request(http)
        .post(`${PREFIX}/auth/password/forgot`)
        .send({ email })
        .expect(202);
      await flush();
      const resetToken = mail.tokenFor(email, '/reset-password');
      const newPassword = 'brand-new-password-2';

      await request(http)
        .post(`${PREFIX}/auth/password/reset`)
        .send({ token: resetToken, newPassword })
        .expect(204);
      const reused = await request(http)
        .post(`${PREFIX}/auth/password/reset`)
        .send({ token: resetToken, newPassword: 'another-password-3' })
        .expect(400);
      expect((reused.body as ErrorBody).code).toBe('INVALID_TOKEN');

      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      await refresh(cookie).expect(401);
      await login(email).expect(401);
      await login(email, newPassword).expect(200);
      await flush();
      expect(
        mail.sent.some(
          (m) => m.to === email && m.subject.includes('password was changed'),
        ),
      ).toBe(true);
    });

    it('lets exactly one of several concurrent resets with one token succeed', async () => {
      const { email } = await verifiedUser();
      await request(http)
        .post(`${PREFIX}/auth/password/forgot`)
        .send({ email })
        .expect(202);
      await flush();
      const resetToken = mail.tokenFor(email, '/reset-password');
      const attempts = await Promise.all(
        ['pass-word-race-1', 'pass-word-race-2', 'pass-word-race-3'].map(
          (newPassword) =>
            request(http)
              .post(`${PREFIX}/auth/password/reset`)
              .send({ token: resetToken, newPassword }),
        ),
      );
      expect(attempts.map((r) => r.status).sort()).toEqual([204, 400, 400]);
    });

    it('rejects a verification token on the reset endpoint', async () => {
      const email = newEmail();
      await register(email).expect(201);
      await flush();
      const res = await request(http)
        .post(`${PREFIX}/auth/password/reset`)
        .send({
          token: mail.tokenFor(email, '/verify-email'),
          newPassword: 'whatever-password-9',
        })
        .expect(400);
      expect((res.body as ErrorBody).code).toBe('INVALID_TOKEN');
    });

    it('changes the password, keeping this device and signing out others', async () => {
      const { email, token } = await verifiedUser();
      const other = await login(email).expect(200);

      const wrong = await request(http)
        .post(`${PREFIX}/auth/password/change`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: 'nope-nope-nope-1',
          newPassword: 'changed-password-4',
        })
        .expect(401);
      expect((wrong.body as ErrorBody).code).toBe('INVALID_CREDENTIALS');

      const same = await request(http)
        .post(`${PREFIX}/auth/password/change`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: PASSWORD })
        .expect(400);
      expect((same.body as ErrorBody).code).toBe('PASSWORD_UNCHANGED');

      await request(http)
        .post(`${PREFIX}/auth/password/change`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: 'changed-password-4' })
        .expect(204);

      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${(other.body as AuthBody).accessToken}`)
        .expect(401);
      await login(email, 'changed-password-4').expect(200);
    });
  });

  // --- self-service & admin ------------------------------------------------

  describe('users', () => {
    it('updates own profile but not email or role', async () => {
      const { token } = await verifiedUser();
      const ok = await request(http)
        .patch(`${PREFIX}/users/me`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '  New Name ', avatarUrl: 'https://example.com/a.png' })
        .expect(200);
      expect(ok.body).toMatchObject({
        name: 'New Name',
        avatarUrl: 'https://example.com/a.png',
      });

      await request(http)
        .patch(`${PREFIX}/users/me`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: Role.ADMIN })
        .expect(400);
      await request(http)
        .patch(`${PREFIX}/users/me`)
        .set('Authorization', `Bearer ${token}`)
        .send({ avatarUrl: 'javascript:alert(1)' })
        .expect(400);
    });

    it('keeps admin routes admin-only', async () => {
      const { token } = await verifiedUser();
      await request(http)
        .get(`${PREFIX}/users`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('deletes own account only with the right password', async () => {
      const { email, token } = await verifiedUser();
      await request(http)
        .delete(`${PREFIX}/users/me`)
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'wrong-password-123' })
        .expect(401);
      await request(http)
        .delete(`${PREFIX}/users/me`)
        .set('Authorization', `Bearer ${token}`)
        .send({ password: PASSWORD })
        .expect(204);
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('stops admins from demoting themselves; deactivation revokes the target', async () => {
      const admin = await verifiedUser();
      await prisma.user.update({
        where: { email: admin.email },
        data: { role: Role.ADMIN },
      });
      const adminRow = await prisma.user.findUniqueOrThrow({
        where: { email: admin.email },
      });

      const self = await request(http)
        .patch(`${PREFIX}/users/${adminRow.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ role: Role.USER })
        .expect(409);
      expect((self.body as ErrorBody).code).toBe('SELF_MODIFICATION');

      const target = await verifiedUser();
      const targetRow = await prisma.user.findUniqueOrThrow({
        where: { email: target.email },
      });
      await request(http)
        .patch(`${PREFIX}/users/${targetRow.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ isActive: false })
        .expect(200);
      await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${target.token}`)
        .expect(401);
      await refresh(target.cookie).expect(401);
    });
  });

  // --- Google --------------------------------------------------------------

  describe('Google sign-in', () => {
    const fakeClient = {
      getToken: jest.fn(),
      verifyIdToken: jest.fn(),
    };

    beforeAll(() => {
      jest
        .spyOn(
          GoogleOAuthClient.prototype as unknown as {
            getClient: () => unknown;
          },
          'getClient',
        )
        .mockReturnValue(fakeClient);
    });

    /** Starts the flow and returns the state cookie plus what Google would echo. */
    async function start(returnTo = '/projects'): Promise<{
      cookie: string;
      state: string;
      nonce: string;
      location: string;
    }> {
      const res = await request(http)
        .get(`${PREFIX}/auth/google`)
        .query({ returnTo })
        .expect(302);
      const location = res.headers.location;
      const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('qd_oauth_google='),
      ) as string;
      const cookie = raw.split(';')[0];
      const jwt = decodeURIComponent(cookie.slice('qd_oauth_google='.length));
      const payload = JSON.parse(
        Buffer.from(jwt.split('.')[1], 'base64url').toString(),
      ) as {
        state: string;
        nonce: string;
      };
      return { cookie, state: payload.state, nonce: payload.nonce, location };
    }

    function googleReturns(claims: Record<string, unknown>): void {
      fakeClient.getToken.mockResolvedValue({
        tokens: { id_token: 'fake.id.token' },
      });
      fakeClient.verifyIdToken.mockResolvedValue({ getPayload: () => claims });
    }

    const callback = (cookie: string, query: Record<string, string>) =>
      request(http)
        .get(`${PREFIX}/auth/google/callback`)
        .query(query)
        .set('Cookie', cookie);

    it('redirects to Google with state, nonce and an S256 PKCE challenge', async () => {
      const { location, state } = await start();
      const url = new URL(location);
      expect(url.origin).toBe('https://accounts.google.com');
      expect(url.searchParams.get('state')).toBe(state);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(url.searchParams.get('nonce')).toBeTruthy();
      expect(url.searchParams.get('scope')).toBe('openid email profile');
    });

    it('creates a verified, passwordless user and lands on the SPA with a refresh cookie', async () => {
      const { cookie, state, nonce } = await start('/projects/42');
      const email = newEmail();
      googleReturns({
        sub: `g-${email}`,
        email,
        email_verified: true,
        nonce,
        name: 'Gee',
      });

      const res = await callback(cookie, { code: 'auth-code', state }).expect(
        302,
      );
      const location = new URL(res.headers.location);
      expect(location.origin + location.pathname).toBe(
        `${ORIGIN}/auth/callback`,
      );
      expect(location.searchParams.get('returnTo')).toBe('/projects/42');
      expect(location.searchParams.get('error')).toBeNull();
      expect(fakeClient.getToken).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'auth-code',
          codeVerifier: expect.any(String) as string,
        }),
      );

      const session = refreshCookie(res) as string;
      const refreshed = await refresh(session).expect(200);
      expect((refreshed.body as AuthBody).user).toMatchObject({
        email,
        emailVerified: true,
        hasPassword: false,
      });
    });

    it('rejects a mismatched state, a replayed state cookie, a wrong nonce and unverified emails', async () => {
      const first = await start();
      const bad = await callback(first.cookie, {
        code: 'c',
        state: 'forged',
      }).expect(302);
      expect(new URL(bad.headers.location).searchParams.get('error')).toBe(
        'invalid_state',
      );

      const noCookie = await request(http)
        .get(`${PREFIX}/auth/google/callback`)
        .query({ code: 'c', state: first.state })
        .expect(302);
      expect(new URL(noCookie.headers.location).searchParams.get('error')).toBe(
        'invalid_state',
      );

      const second = await start();
      googleReturns({
        sub: 'g-x',
        email: newEmail(),
        email_verified: true,
        nonce: 'other',
      });
      const nonce = await callback(second.cookie, {
        code: 'c',
        state: second.state,
      }).expect(302);
      expect(new URL(nonce.headers.location).searchParams.get('error')).toBe(
        'invalid_id_token',
      );

      const third = await start();
      googleReturns({
        sub: 'g-y',
        email: newEmail(),
        email_verified: false,
        nonce: third.nonce,
      });
      const unverified = await callback(third.cookie, {
        code: 'c',
        state: third.state,
      }).expect(302);
      expect(
        new URL(unverified.headers.location).searchParams.get('error'),
      ).toBe('email_not_verified');
    });

    it('never redirects to another host via returnTo', async () => {
      for (const evil of [
        '//evil.example',
        'https://evil.example',
        '/\\evil.example',
      ]) {
        const { cookie, state, nonce } = await start(evil);
        const email = newEmail();
        googleReturns({
          sub: `g-${email}`,
          email,
          email_verified: true,
          nonce,
        });
        const res = await callback(cookie, { code: 'c', state }).expect(302);
        const location = new URL(res.headers.location);
        expect(location.origin).toBe(ORIGIN);
        expect(location.searchParams.get('returnTo')).toBe('/');
      }
    });

    it('links to an existing verified account and keeps its password', async () => {
      const { email } = await verifiedUser();
      const { cookie, state, nonce } = await start();
      googleReturns({ sub: `g-${email}`, email, email_verified: true, nonce });
      await callback(cookie, { code: 'c', state }).expect(302);

      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        include: { oauthAccounts: true },
      });
      expect(user.oauthAccounts).toHaveLength(1);
      expect(user.passwordHash).not.toBeNull();
      await login(email).expect(200);
    });

    it('takes over an unverified pre-registered account: password removed, sessions revoked', async () => {
      // An attacker registers the victim's email but cannot verify it.
      const email = newEmail();
      await register(email).expect(201);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { email } }))
          .passwordHash,
      ).not.toBeNull();

      const { cookie, state, nonce } = await start();
      googleReturns({ sub: `g-${email}`, email, email_verified: true, nonce });
      await callback(cookie, { code: 'c', state }).expect(302);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.passwordHash).toBeNull();
      expect(user.emailVerifiedAt).not.toBeNull();
      await login(email).expect(401); // attacker's password no longer works
    });
  });

  // --- infrastructure --------------------------------------------------------

  describe('infrastructure', () => {
    it('echoes a safe X-Request-Id and includes it in error bodies', async () => {
      const res = await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('X-Request-Id', 'abc-123')
        .expect(401);
      expect(res.headers['x-request-id']).toBe('abc-123');
      expect((res.body as { requestId?: string }).requestId).toBe('abc-123');

      const injected = await request(http)
        .get(`${PREFIX}/auth/me`)
        .set('X-Request-Id', 'bad id\twith spaces')
        .expect(401);
      expect(injected.headers['x-request-id']).not.toBe('bad id\twith spaces');
    });

    it('maps malformed JSON to 400 and oversized bodies to 413', async () => {
      const malformed = await request(http)
        .post(`${PREFIX}/auth/login`)
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(400);
      expect((malformed.body as ErrorBody).code).toBe('MALFORMED_JSON');

      const huge = await request(http)
        .post(`${PREFIX}/auth/login`)
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            email: 'a@b.co',
            password: 'x'.repeat(6 * 1024 * 1024),
          }),
        )
        .expect(413);
      expect((huge.body as ErrorBody).code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('serves health probes without auth', async () => {
      await request(http).get('/health/live').expect(200);
      await request(http).get('/health').expect(200);
    });

    it('sends no CORS allow-origin header to foreign origins', async () => {
      const res = await request(http)
        .options(`${PREFIX}/auth/login`)
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.status).toBeLessThan(500);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
