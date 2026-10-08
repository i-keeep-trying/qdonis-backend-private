-- Billing: plans, packages, add-ons, subscriptions, token batches + ledger,
-- Stripe webhook idempotency, admin settings.

-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "plan_tier" AS ENUM ('FREE', 'PRO', 'TEAMS', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "token_batch_source" AS ENUM ('TRIAL', 'PLAN_PURCHASE', 'RENEWAL', 'UPGRADE', 'ADDON', 'ADMIN_GRANT');


-- CreateTable
CREATE TABLE "addon_packages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "token_amount" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "stripe_price_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addon_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "user_id" UUID NOT NULL,
    "stripe_customer_id" TEXT,
    "trial_granted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "plan_packages" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_allocation" INTEGER NOT NULL,
    "monthly_price_cents" INTEGER NOT NULL,
    "yearly_price_cents" INTEGER NOT NULL,
    "stripe_price_id_monthly" TEXT,
    "stripe_price_id_yearly" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" "plan_tier" NOT NULL,
    "features" JSONB NOT NULL DEFAULT '[]',
    "is_popular" BOOLEAN NOT NULL DEFAULT false,
    "is_contact_only" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subscription_id" UUID,
    "type" TEXT NOT NULL,
    "from_package_id" TEXT,
    "to_package_id" TEXT,
    "tokens_delta" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" TEXT NOT NULL,
    "package_id" TEXT,
    "interval" "billing_interval",
    "status" "subscription_status" NOT NULL,
    "token_allocation" INTEGER NOT NULL,
    "stripe_subscription_id" TEXT,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "scheduled_package_id" TEXT,
    "scheduled_interval" "billing_interval",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_batches" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subscription_id" UUID,
    "source" "token_batch_source" NOT NULL,
    "tokens_granted" INTEGER NOT NULL,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "scheduled_expiry_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "token_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_ledger" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "addon_packages_stripe_price_id_key" ON "addon_packages"("stripe_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_stripe_customer_id_key" ON "billing_accounts"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_packages_stripe_price_id_monthly_key" ON "plan_packages"("stripe_price_id_monthly");

-- CreateIndex
CREATE UNIQUE INDEX "plan_packages_stripe_price_id_yearly_key" ON "plan_packages"("stripe_price_id_yearly");

-- CreateIndex
CREATE INDEX "plan_packages_plan_id_idx" ON "plan_packages"("plan_id");

-- CreateIndex
CREATE INDEX "subscription_events_user_id_created_at_idx" ON "subscription_events"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "token_batches_user_id_expires_at_idx" ON "token_batches"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "token_ledger_idempotency_key_key" ON "token_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "token_ledger_user_id_created_at_idx" ON "token_ledger"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_packages" ADD CONSTRAINT "plan_packages_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "plan_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_scheduled_package_id_fkey" FOREIGN KEY ("scheduled_package_id") REFERENCES "plan_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_batches" ADD CONSTRAINT "token_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_batches" ADD CONSTRAINT "token_batches_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity rules Prisma cannot express.
-- ---------------------------------------------------------------------------

-- At most one live (ACTIVE or PAST_DUE) subscription per user. Concurrent
-- activations race on this index instead of creating duplicates.
CREATE UNIQUE INDEX "subscriptions_one_live_per_user"
  ON "subscriptions" ("user_id")
  WHERE "status" IN ('ACTIVE', 'PAST_DUE');

ALTER TABLE "token_batches"
  ADD CONSTRAINT "token_batches_usage_bounds"
  CHECK ("tokens_granted" >= 0 AND "tokens_used" >= 0 AND "tokens_used" <= "tokens_granted");

ALTER TABLE "token_ledger"
  ADD CONSTRAINT "token_ledger_nonzero" CHECK ("amount" <> 0);

ALTER TABLE "plan_packages"
  ADD CONSTRAINT "plan_packages_non_negative"
  CHECK ("token_allocation" >= 0 AND "monthly_price_cents" >= 0 AND "yearly_price_cents" >= 0);

ALTER TABLE "addon_packages"
  ADD CONSTRAINT "addon_packages_positive"
  CHECK ("token_amount" > 0 AND "price_cents" > 0);

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_allocation_non_negative" CHECK ("token_allocation" >= 0);

-- ---------------------------------------------------------------------------
-- Reference data (carried over from the previous Supabase setup). Admins can
-- edit all of it afterwards; re-running is a no-op.
-- ---------------------------------------------------------------------------

INSERT INTO "plans" ("id", "name", "tier", "features", "is_popular", "is_contact_only", "sort_order", "updated_at") VALUES
  ('free', 'Free', 'FREE',
   '["Basic power supply design features","Limited token allocation","Community support","Access to core calculators"]', false, false, 1, CURRENT_TIMESTAMP),
  ('pro', 'Pro', 'PRO',
   '["All Free features","Increased token limit","Priority support","Advanced magnetics design","Thermal analysis","MTBF estimation","Export designs to PDF","Save unlimited projects"]', true, false, 2, CURRENT_TIMESTAMP),
  ('teams', 'Teams', 'TEAMS',
   '["All Pro features","Team collaboration","Shared project workspace","Advanced analytics","Custom component libraries","API access","Team management dashboard"]', false, false, 3, CURRENT_TIMESTAMP),
  ('enterprise', 'Enterprise', 'ENTERPRISE',
   '["All Teams features","Custom token limits","Dedicated account manager","SLA guarantee","Custom integrations","On-premise deployment option","24/7 phone support"]', false, true, 4, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "plan_packages" ("id", "plan_id", "name", "token_allocation", "monthly_price_cents", "yearly_price_cents", "stripe_price_id_monthly", "stripe_price_id_yearly", "is_default", "sort_order", "updated_at") VALUES
  ('pro-basic',    'pro',   'Basic',    250000,   7900,  75800, 'price_1SojNm2O72rfG5iLMhgmrUwn', 'price_1SojNp2O72rfG5iLxLCP1NEc', true,  1, CURRENT_TIMESTAMP),
  ('pro-plus',     'pro',   'Plus',     500000,  12900, 123800, 'price_1SojNr2O72rfG5iLW32HIhdC', 'price_1SojNv2O72rfG5iLn6phpfZ2', false, 2, CURRENT_TIMESTAMP),
  ('pro-premium',  'pro',   'Premium', 1000000,  19900, 191000, 'price_1SojNt2O72rfG5iLKIM2nGIf', 'price_1SojO02O72rfG5iLrUWbXeEs', false, 3, CURRENT_TIMESTAMP),
  ('teams-core',   'teams', 'Core',     750000,  29900, 287000, 'price_1SojON2O72rfG5iLRbUxJreC', 'price_1SojOS2O72rfG5iLYXszQ7r2', true,  1, CURRENT_TIMESTAMP),
  ('teams-growth', 'teams', 'Growth',  1500000,  49900, 479000, 'price_1SojOU2O72rfG5iLEHNSOnzB', 'price_1SojOa2O72rfG5iLrlAHuX7v', false, 2, CURRENT_TIMESTAMP),
  ('teams-scale',  'teams', 'Scale',   3000000,  79900, 767000, 'price_1SompF2O72rfG5iLSPv1HWl3', 'price_1SompK2O72rfG5iLbgT0LyDG', false, 3, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "app_settings" ("key", "value", "updated_at") VALUES
  ('signup_bonus', '{"enabled":true,"bonusTokens":10000,"trialDays":14}', CURRENT_TIMESTAMP),
  ('token_expiry', '{"monthsAfterPeriodEnd":3}', CURRENT_TIMESTAMP),
  ('addon_pricing', '{"tokensPerUsd":3164.56,"customMinCents":500,"customMaxCents":50000}', CURRENT_TIMESTAMP),
  ('model_config', '{"modelName":"anthropic/claude-4.5-sonnet","displayName":"Claude 4.5 Sonnet","inputCostPerMillion":3,"outputCostPerMillion":15}', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
