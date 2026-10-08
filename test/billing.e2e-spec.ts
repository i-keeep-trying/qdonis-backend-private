import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Stripe from 'stripe';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { StripeClient } from '../src/billing/stripe/stripe.client';
import { Role } from '../src/generated/prisma/enums';
import { type MailMessage, MailTransport } from '../src/mail/mail.transport';
import { PrismaService } from '../src/prisma/prisma.service';

class SilentMail extends MailTransport {
  send(_message: MailMessage): Promise<void> {
    return Promise.resolve();
  }
  verify(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
}

const PREFIX = '/api/v1';
const PASSWORD = 'correct-horse-battery-1';
const WEBHOOK_SECRET = 'whsec_e2eWebhookSecret0000000000';
const PRICE = {
  proBasicMonthly: 'price_1SojNm2O72rfG5iLMhgmrUwn',
  proBasicYearly: 'price_1SojNp2O72rfG5iLxLCP1NEc',
  proPlusMonthly: 'price_1SojNr2O72rfG5iLW32HIhdC',
};
const run = Date.now().toString(36);
let counter = 0;
const newEmail = (): string => `billing-${run}-${++counter}@e2e.test`;
const DAY = 86_400;

interface ErrorBody {
  code?: string;
  meta?: Record<string, number>;
}
interface Overview {
  balance: number;
  subscription: null | {
    status: string;
    plan: { id: string };
    package: { id: string } | null;
    tokenAllocation: number;
    cancelAtPeriodEnd: boolean;
    scheduledChange: null | { package: { id: string } };
  };
  batches: Array<{
    source: string;
    tokensRemaining: number;
    expiresAt: string | null;
    scheduledExpiryAt: string | null;
  }>;
}

/** In-memory stand-in for the Stripe API surface the app uses. */
class FakeStripe {
  readonly real = new Stripe('sk_test_e2eFakeKey000000000000');
  readonly subs = new Map<string, Stripe.Subscription>();
  customerCreates = 0;
  readonly customersByKey = new Map<string, string>();
  sessionParams: Stripe.Checkout.SessionCreateParams[] = [];
  updateParams: Array<{ id: string; params: Stripe.SubscriptionUpdateParams }> =
    [];
  cancelled: string[] = [];
  nextUpdateError: Error | null = null;

  addSubscription(
    id: string,
    customer: string,
    priceId: string,
    periodStart: number,
    periodEnd: number,
  ): Stripe.Subscription {
    const sub = {
      id,
      object: 'subscription',
      status: 'active',
      customer,
      cancel_at_period_end: false,
      items: {
        object: 'list',
        data: [
          {
            id: `si_${id}`,
            price: { id: priceId },
            current_period_start: periodStart,
            current_period_end: periodEnd,
          },
        ],
      },
    } as unknown as Stripe.Subscription;
    this.subs.set(id, sub);
    return sub;
  }

  api(): unknown {
    return {
      webhooks: this.real.webhooks,
      customers: {
        create: (_params: unknown, options: { idempotencyKey?: string }) => {
          const key = options.idempotencyKey ?? `${Math.random()}`;
          let id = this.customersByKey.get(key);
          if (!id) {
            this.customerCreates += 1;
            id = `cus_${run}_${this.customerCreates}`;
            this.customersByKey.set(key, id);
          }
          return Promise.resolve({ id });
        },
      },
      checkout: {
        sessions: {
          create: (params: Stripe.Checkout.SessionCreateParams) => {
            this.sessionParams.push(params);
            return Promise.resolve({
              id: `cs_${this.sessionParams.length}`,
              url: 'https://checkout.stripe.test/session',
            });
          },
        },
      },
      billingPortal: {
        sessions: {
          create: () =>
            Promise.resolve({ url: 'https://billing.stripe.test/portal' }),
        },
      },
      subscriptions: {
        retrieve: (id: string) => {
          const sub = this.subs.get(id);
          return sub
            ? Promise.resolve(sub)
            : Promise.reject(new Error(`no such subscription ${id}`));
        },
        update: (id: string, params: Stripe.SubscriptionUpdateParams) => {
          if (this.nextUpdateError) {
            const error = this.nextUpdateError;
            this.nextUpdateError = null;
            return Promise.reject(error);
          }
          this.updateParams.push({ id, params });
          const sub = this.subs.get(id) as unknown as {
            cancel_at_period_end: boolean;
            items: { data: Array<{ price: { id: string } }> };
          };
          if (params.cancel_at_period_end !== undefined)
            sub.cancel_at_period_end = params.cancel_at_period_end;
          const price = params.items?.[0]?.price;
          if (price) sub.items.data[0].price = { id: price };
          return Promise.resolve(sub);
        },
        cancel: (id: string) => {
          this.cancelled.push(id);
          return Promise.resolve({ id, status: 'canceled' });
        },
      },
    };
  }
}

describe('Billing (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;
  const stripe = new FakeStripe();
  let eventCounter = 0;

  beforeAll(async () => {
    jest
      .spyOn(StripeClient.prototype, 'api', 'get')
      .mockImplementation(() => stripe.api() as Stripe);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(new SilentMail())
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
    await prisma.stripeEvent.deleteMany({
      where: { id: { startsWith: `evt_${run}` } },
    });
    await app.close();
  });

  // --- helpers -------------------------------------------------------------

  async function signedInUser(
    role: Role = Role.USER,
  ): Promise<{ id: string; email: string; token: string }> {
    const email = newEmail();
    await request(http)
      .post(`${PREFIX}/auth/register`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const user = await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date(), role },
    });
    const res = await request(http)
      .post(`${PREFIX}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      id: user.id,
      email,
      token: (res.body as { accessToken: string }).accessToken,
    };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function me(token: string): Promise<Overview> {
    const res = await request(http)
      .get(`${PREFIX}/billing/me`)
      .set(auth(token))
      .expect(200);
    return res.body as Overview;
  }

  function sendEvent(
    type: string,
    object: unknown,
    id = `evt_${run}_${++eventCounter}`,
  ) {
    const payload = JSON.stringify({
      id,
      object: 'event',
      type,
      api_version: '2026-09-30.endive',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: { object },
    });
    const header = stripe.real.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    return request(http)
      .post(`${PREFIX}/billing/stripe/webhook`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload);
  }

  /** Simulates a completed Checkout for `user` and returns the Stripe subscription id. */
  async function subscribe(
    user: { id: string; token: string },
    priceId = PRICE.proBasicMonthly,
  ): Promise<string> {
    await me(user.token); // as POST /billing/checkout would
    const now = Math.floor(Date.now() / 1000);
    const subId = `sub_${run}_${++eventCounter}`;
    stripe.addSubscription(
      subId,
      `cus_${user.id}`,
      priceId,
      now,
      now + 30 * DAY,
    );
    await sendEvent('checkout.session.completed', {
      id: `cs_${subId}`,
      object: 'checkout.session',
      mode: 'subscription',
      payment_status: 'paid',
      subscription: subId,
      customer: `cus_${user.id}`,
      client_reference_id: user.id,
      amount_total: 7900,
      metadata: { kind: 'subscription', userId: user.id },
    }).expect(200);
    return subId;
  }

  function invoice(
    subId: string,
    reason: string,
    priceId: string,
    id = `in_${run}_${++eventCounter}`,
  ) {
    return {
      id,
      object: 'invoice',
      billing_reason: reason,
      amount_paid: 7900,
      attempt_count: 1,
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: subId },
      },
      lines: {
        object: 'list',
        data: [
          { amount: 7900, pricing: { price_details: { price: priceId } } },
        ],
      },
    };
  }

  // --- onboarding & catalog --------------------------------------------------

  it('serves the public price list without Stripe internals', async () => {
    const res = await request(http).get(`${PREFIX}/billing/plans`).expect(200);
    const plans = res.body as Array<{
      id: string;
      packages: Array<Record<string, unknown>>;
    }>;
    expect(plans.map((p) => p.id)).toEqual([
      'free',
      'pro',
      'teams',
      'enterprise',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/price_1|stripe/i);
    expect(plans[1].packages[0]).toMatchObject({
      id: 'pro-basic',
      tokenAllocation: 250000,
      monthlyPriceCents: 7900,
    });
  });

  it('starts every new account on the free plan with a one-time expiring trial, even under concurrency', async () => {
    const user = await signedInUser();
    const overviews = await Promise.all(
      [1, 2, 3, 4, 5].map(() => me(user.token)),
    );
    for (const overview of overviews) expect(overview.balance).toBe(10000);

    const overview = overviews[0];
    expect(overview.subscription).toMatchObject({
      status: 'ACTIVE',
      plan: { id: 'free' },
    });
    expect(overview.batches).toHaveLength(1);
    expect(overview.batches[0].source).toBe('TRIAL');
    const expiresInDays =
      (new Date(overview.batches[0].expiresAt as string).getTime() -
        Date.now()) /
      86_400_000;
    expect(expiresInDays).toBeGreaterThan(13.9);
    expect(expiresInDays).toBeLessThan(14.1);
    expect(
      await prisma.tokenLedgerEntry.count({ where: { userId: user.id } }),
    ).toBe(1);
  });

  // --- usage ---------------------------------------------------------------

  it('deducts usage all-or-nothing, idempotently, and never overdraws under concurrency', async () => {
    const user = await signedInUser();
    const use = (amount: number, key: string) =>
      request(http)
        .post(`${PREFIX}/billing/usage`)
        .set(auth(user.token))
        .send({ amount, idempotencyKey: key });

    const first = await use(3000, 'usage-key-0001').expect(200);
    expect(first.body).toMatchObject({
      consumed: 3000,
      balance: 7000,
      replayed: false,
    });

    const replay = await use(3000, 'usage-key-0001').expect(200);
    expect(replay.body).toMatchObject({ balance: 7000, replayed: true });

    const conflict = await use(5, 'usage-key-0001').expect(409);
    expect((conflict.body as ErrorBody).code).toBe('IDEMPOTENCY_CONFLICT');

    const short = await use(8000, 'usage-key-0002').expect(402);
    expect((short.body as ErrorBody).code).toBe('INSUFFICIENT_TOKENS');
    expect((short.body as ErrorBody).meta).toMatchObject({
      balance: 7000,
      required: 8000,
      shortfall: 1000,
    });
    expect((await me(user.token)).balance).toBe(7000);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        use(1000, `usage-race-${String(i).padStart(4, '0')}`),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
    expect((await me(user.token)).balance).toBe(0);

    await use(0, 'usage-key-0003').expect(400);
    await use(1, 'bad key!').expect(400);
  });

  // --- checkout --------------------------------------------------------------

  it('creates checkout sessions with server-side prices and one Stripe customer per user', async () => {
    const user = await signedInUser();
    const before = stripe.customerCreates;
    const results = await Promise.all(
      [1, 2].map(() =>
        request(http)
          .post(`${PREFIX}/billing/checkout`)
          .set(auth(user.token))
          .send({ packageId: 'pro-basic', interval: 'MONTHLY' }),
      ),
    );
    for (const res of results) expect(res.status).toBe(200);
    expect((results[0].body as { url: string }).url).toBe(
      'https://checkout.stripe.test/session',
    );
    expect(stripe.customerCreates - before).toBe(1);

    const params = stripe.sessionParams[stripe.sessionParams.length - 1];
    expect(params.line_items).toEqual([
      { price: PRICE.proBasicMonthly, quantity: 1 },
    ]);
    expect(params.metadata).toMatchObject({
      kind: 'subscription',
      userId: user.id,
      packageId: 'pro-basic',
    });
    expect(params.success_url).toMatch(
      /^http:\/\/localhost:5173\/subscription\?checkout=success/,
    );

    const contactOnly = await request(http)
      .post(`${PREFIX}/billing/checkout`)
      .set(auth(user.token))
      .send({ packageId: 'enterprise', interval: 'MONTHLY' });
    expect(contactOnly.status).toBe(404);
    await request(http)
      .post(`${PREFIX}/billing/checkout`)
      .set(auth(user.token))
      .send({ packageId: 'pro-basic', interval: 'WEEKLY' })
      .expect(400);
  });

  // --- webhooks --------------------------------------------------------------

  it('rejects unsigned or tampered webhooks', async () => {
    await request(http)
      .post(`${PREFIX}/billing/stripe/webhook`)
      .set('Content-Type', 'application/json')
      .send('{"id":"evt_x"}')
      .expect(400);
    const payload = JSON.stringify({
      id: 'evt_x',
      type: 'invoice.paid',
      data: { object: {} },
    });
    const header = stripe.real.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_wrongSecret',
    });
    const res = await request(http)
      .post(`${PREFIX}/billing/stripe/webhook`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload)
      .expect(400);
    expect((res.body as ErrorBody).code).toBe('INVALID_SIGNATURE');
  });

  it('activates a paid plan once per event, keeping unused trial tokens', async () => {
    const user = await signedInUser();
    await me(user.token);
    const now = Math.floor(Date.now() / 1000);
    const subId = `sub_${run}_replay`;
    stripe.addSubscription(
      subId,
      `cus_${user.id}`,
      PRICE.proBasicMonthly,
      now,
      now + 30 * DAY,
    );
    const session = {
      id: `cs_replay_${run}`,
      object: 'checkout.session',
      mode: 'subscription',
      payment_status: 'paid',
      subscription: subId,
      customer: `cus_${user.id}`,
      client_reference_id: user.id,
      amount_total: 7900,
      metadata: { kind: 'subscription', userId: user.id },
    };
    const eventId = `evt_${run}_replay`;
    await sendEvent('checkout.session.completed', session, eventId).expect(200);
    await sendEvent('checkout.session.completed', session, eventId).expect(200);
    await Promise.all([
      sendEvent('checkout.session.completed', session, eventId),
      sendEvent('checkout.session.completed', session, eventId),
    ]);

    const overview = await me(user.token);
    expect(overview.balance).toBe(260000);
    expect(overview.subscription).toMatchObject({
      status: 'ACTIVE',
      plan: { id: 'pro' },
      package: { id: 'pro-basic' },
      tokenAllocation: 250000,
    });
    expect(
      overview.batches.every(
        (b) => b.expiresAt === null && b.scheduledExpiryAt !== null,
      ),
    ).toBe(true);
    expect(
      await prisma.subscription.count({ where: { userId: user.id } }),
    ).toBe(2);
  });

  it('renews: last period starts expiring, new period tokens are granted once', async () => {
    const user = await signedInUser();
    const subId = await subscribe(user);
    const inv = invoice(subId, 'subscription_cycle', PRICE.proBasicMonthly);
    await sendEvent('invoice.paid', inv).expect(200);
    await sendEvent('invoice.paid', inv).expect(200); // different event id, same invoice

    const overview = await me(user.token);
    expect(overview.balance).toBe(10000 + 250000 + 250000);
    const renewal = overview.batches.filter((b) => b.source === 'RENEWAL');
    expect(renewal).toHaveLength(1);
    expect(renewal[0].expiresAt).toBeNull();
    const purchase = overview.batches.find((b) => b.source === 'PLAN_PURCHASE');
    expect(purchase?.expiresAt).toBe(purchase?.scheduledExpiryAt);
  });

  it('upgrades now (prorated) and grants only the token difference when paid', async () => {
    const user = await signedInUser();
    const subId = await subscribe(user);
    const res = await request(http)
      .post(`${PREFIX}/billing/subscription/change`)
      .set(auth(user.token))
      .send({ packageId: 'pro-plus', interval: 'MONTHLY' })
      .expect(200);
    expect(res.body).toMatchObject({ kind: 'upgrade' });
    const call = stripe.updateParams[stripe.updateParams.length - 1];
    expect(call.params).toMatchObject({
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    });

    await sendEvent(
      'invoice.paid',
      invoice(subId, 'subscription_update', PRICE.proPlusMonthly),
    ).expect(200);
    const overview = await me(user.token);
    expect(overview.subscription).toMatchObject({
      package: { id: 'pro-plus' },
      tokenAllocation: 500000,
    });
    expect(overview.balance).toBe(10000 + 250000 + 250000);

    await request(http)
      .post(`${PREFIX}/billing/subscription/change`)
      .set(auth(user.token))
      .send({ packageId: 'pro-plus', interval: 'MONTHLY' })
      .expect(409);
  });

  it('turns a declined upgrade into 402 PAYMENT_FAILED without changing anything', async () => {
    const user = await signedInUser();
    await subscribe(user);
    stripe.nextUpdateError = new Stripe.errors.StripeCardError({
      message: 'Your card was declined.',
      type: 'card_error',
    });
    const res = await request(http)
      .post(`${PREFIX}/billing/subscription/change`)
      .set(auth(user.token))
      .send({ packageId: 'pro-plus', interval: 'MONTHLY' })
      .expect(402);
    expect((res.body as ErrorBody).code).toBe('PAYMENT_FAILED');
    expect((await me(user.token)).subscription?.package?.id).toBe('pro-basic');
  });

  it('schedules downgrades for renewal, can withdraw them, and applies them on renewal', async () => {
    const user = await signedInUser();
    const subId = await subscribe(user, PRICE.proPlusMonthly);

    const res = await request(http)
      .post(`${PREFIX}/billing/subscription/change`)
      .set(auth(user.token))
      .send({ packageId: 'pro-basic', interval: 'MONTHLY' })
      .expect(200);
    expect(res.body).toMatchObject({ kind: 'downgrade' });
    expect(
      stripe.updateParams[stripe.updateParams.length - 1].params
        .proration_behavior,
    ).toBe('none');
    expect(
      (await me(user.token)).subscription?.scheduledChange?.package.id,
    ).toBe('pro-basic');

    await request(http)
      .delete(`${PREFIX}/billing/subscription/scheduled-change`)
      .set(auth(user.token))
      .expect(204);
    expect((await me(user.token)).subscription?.scheduledChange).toBeNull();
    await request(http)
      .delete(`${PREFIX}/billing/subscription/scheduled-change`)
      .set(auth(user.token))
      .expect(409);

    await request(http)
      .post(`${PREFIX}/billing/subscription/change`)
      .set(auth(user.token))
      .send({ packageId: 'pro-basic', interval: 'MONTHLY' })
      .expect(200);
    await sendEvent(
      'invoice.paid',
      invoice(subId, 'subscription_cycle', PRICE.proBasicMonthly),
    ).expect(200);
    const overview = await me(user.token);
    expect(overview.subscription).toMatchObject({
      package: { id: 'pro-basic' },
      tokenAllocation: 250000,
      scheduledChange: null,
    });
  });

  it('refuses downgrades that change the billing interval', async () => {
    const user = await signedInUser();
    await subscribe(user, PRICE.proBasicYearly);
    const res = await request(http)
      .post(`${PREFIX}/billing/subscription/change`)
      .set(auth(user.token))
      .send({ packageId: 'pro-plus', interval: 'MONTHLY' })
      .expect(400);
    expect((res.body as ErrorBody).code).toBe('PACKAGE_NOT_PURCHASABLE');
  });

  it('cancels at period end, resumes, and on deletion keeps tokens until they expire', async () => {
    const user = await signedInUser();
    const subId = await subscribe(user);
    await request(http)
      .post(`${PREFIX}/billing/subscription/cancel`)
      .set(auth(user.token))
      .expect(200);
    expect((await me(user.token)).subscription?.cancelAtPeriodEnd).toBe(true);
    const again = await request(http)
      .post(`${PREFIX}/billing/subscription/cancel`)
      .set(auth(user.token))
      .expect(409);
    expect((again.body as ErrorBody).code).toBe('CANCELLATION_PENDING');
    await request(http)
      .post(`${PREFIX}/billing/subscription/change`)
      .set(auth(user.token))
      .send({ packageId: 'pro-plus', interval: 'MONTHLY' })
      .expect(409);

    await request(http)
      .post(`${PREFIX}/billing/subscription/resume`)
      .set(auth(user.token))
      .expect(204);
    await request(http)
      .post(`${PREFIX}/billing/subscription/resume`)
      .set(auth(user.token))
      .expect(409);

    await sendEvent('customer.subscription.deleted', {
      id: subId,
      object: 'subscription',
      status: 'canceled',
    }).expect(200);
    const overview = await me(user.token);
    expect(overview.subscription).toBeNull();
    expect(overview.balance).toBe(260000);
    expect(overview.batches.every((b) => b.expiresAt !== null)).toBe(true);
  });

  it('refuses to delete an account Stripe would keep charging', async () => {
    const user = await signedInUser();
    await subscribe(user);
    const blocked = await request(http)
      .delete(`${PREFIX}/users/me`)
      .set(auth(user.token))
      .send({ password: PASSWORD })
      .expect(409);
    expect((blocked.body as ErrorBody).code).toBe('ACTIVE_SUBSCRIPTION');

    await request(http)
      .post(`${PREFIX}/billing/subscription/cancel`)
      .set(auth(user.token))
      .expect(200);
    await request(http)
      .delete(`${PREFIX}/users/me`)
      .set(auth(user.token))
      .send({ password: PASSWORD })
      .expect(204);
  });

  it('marks failed renewals PAST_DUE and blocks plan changes until fixed', async () => {
    const user = await signedInUser();
    const subId = await subscribe(user);
    await sendEvent(
      'invoice.payment_failed',
      invoice(subId, 'subscription_cycle', PRICE.proBasicMonthly),
    ).expect(200);
    expect((await me(user.token)).subscription?.status).toBe('PAST_DUE');
    const res = await request(http)
      .post(`${PREFIX}/billing/subscription/change`)
      .set(auth(user.token))
      .send({ packageId: 'pro-plus', interval: 'MONTHLY' })
      .expect(402);
    expect((res.body as ErrorBody).code).toBe('PAYMENT_FAILED');
  });

  it('sells add-ons only to paid plans, prices custom top-ups server-side and grants them once', async () => {
    const free = await signedInUser();
    const denied = await request(http)
      .post(`${PREFIX}/billing/addons/checkout`)
      .set(auth(free.token))
      .send({ amountCents: 1000 })
      .expect(402);
    expect((denied.body as ErrorBody).code).toBe('PAID_PLAN_REQUIRED');

    const user = await signedInUser();
    await subscribe(user);
    await request(http)
      .post(`${PREFIX}/billing/addons/checkout`)
      .set(auth(user.token))
      .send({ amountCents: 100 })
      .expect(400);
    await request(http)
      .post(`${PREFIX}/billing/addons/checkout`)
      .set(auth(user.token))
      .send({})
      .expect(400);
    await request(http)
      .post(`${PREFIX}/billing/addons/checkout`)
      .set(auth(user.token))
      .send({ amountCents: 1000 })
      .expect(200);
    const params = stripe.sessionParams[stripe.sessionParams.length - 1];
    expect(params.metadata).toMatchObject({
      kind: 'addon',
      userId: user.id,
      addonId: 'custom',
      tokenAmount: '31645',
    });

    const session = {
      id: `cs_addon_${run}`,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      client_reference_id: user.id,
      amount_total: 1000,
      metadata: params.metadata,
    };
    await sendEvent('checkout.session.completed', session).expect(200);
    await sendEvent('checkout.session.completed', session).expect(200);
    expect((await me(user.token)).balance).toBe(260000 + 31645);
  });

  // --- admin -----------------------------------------------------------------

  it('keeps the admin API admin-only and validates every change', async () => {
    const user = await signedInUser();
    await request(http)
      .get(`${PREFIX}/admin/stats`)
      .set(auth(user.token))
      .expect(403);

    const admin = await signedInUser(Role.ADMIN);
    const stats = await request(http)
      .get(`${PREFIX}/admin/stats`)
      .set(auth(admin.token))
      .expect(200);
    expect(stats.body).toHaveProperty('users.total');

    const list = await request(http)
      .get(`${PREFIX}/admin/users`)
      .query({ search: user.email.toUpperCase() })
      .set(auth(admin.token))
      .expect(200);
    expect(
      (list.body as { items: Array<{ user: { email: string } }> }).items[0].user
        .email,
    ).toBe(user.email);

    const grant = await request(http)
      .post(`${PREFIX}/admin/users/${user.id}/tokens`)
      .set(auth(admin.token))
      .send({ amount: 5000, note: 'support credit' })
      .expect(201);
    expect(grant.body).toMatchObject({ balance: 15000 });
    await request(http)
      .post(`${PREFIX}/admin/users/${user.id}/tokens`)
      .set(auth(admin.token))
      .send({ amount: -5, note: 'x' })
      .expect(400);

    await request(http)
      .put(`${PREFIX}/admin/settings/signup_bonus`)
      .set(auth(admin.token))
      .send({ enabled: true, bonusTokens: 'lots', trialDays: 14 })
      .expect(400);
    await request(http)
      .put(`${PREFIX}/admin/settings/signup_bonus`)
      .set(auth(admin.token))
      .send({ enabled: true, bonusTokens: 10000, trialDays: 14, extra: 1 })
      .expect(400);
    await request(http)
      .put(`${PREFIX}/admin/settings/nope`)
      .set(auth(admin.token))
      .send({})
      .expect(404);
    await request(http)
      .put(`${PREFIX}/admin/settings/signup_bonus`)
      .set(auth(admin.token))
      .send({ enabled: true, bonusTokens: 10000, trialDays: 14 })
      .expect(200);

    const paid = await signedInUser();
    await subscribe(paid);
    const conflict = await request(http)
      .post(`${PREFIX}/admin/users/${paid.id}/plan`)
      .set(auth(admin.token))
      .send({
        planId: 'enterprise',
        interval: 'MONTHLY',
        tokenAllocation: 5000000,
      })
      .expect(409);
    expect((conflict.body as ErrorBody).code).toBe(
      'SUBSCRIPTION_NOT_STRIPE_MANAGED',
    );

    const assigned = await request(http)
      .post(`${PREFIX}/admin/users/${user.id}/plan`)
      .set(auth(admin.token))
      .send({
        planId: 'enterprise',
        interval: 'MONTHLY',
        tokenAllocation: 5000000,
      })
      .expect(201);
    expect(assigned.body).toMatchObject({
      plan: { id: 'enterprise' },
      managedBy: 'manual',
    });
    expect((await me(user.token)).balance).toBe(15000 + 5000000);
  });
});
