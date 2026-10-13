/**
 * Creates the Stripe products and prices for every purchasable plan package
 * and add-on, and stores the price ids in the database.
 *
 * Reads STRIPE_SECRET_KEY and DATABASE_URL from the environment / `.env`, so
 * prices land in whichever Stripe account and mode (test or live) that key
 * belongs to.
 *
 *   npm run stripe:sync-prices              # dry run: shows what would change
 *   npm run stripe:sync-prices -- --apply   # creates prices, updates the DB
 *
 * Safe to re-run:
 *  - a stored price id that exists in this account with the right amount,
 *    currency and interval is kept;
 *  - otherwise the price is found by its lookup key
 *    (`qdonis_<package>_monthly|yearly`, `qdonis_addon_<id>`) or created. A
 *    changed amount creates a new price and moves the lookup key (Stripe
 *    prices are immutable); old prices stay, so existing subscriptions keep
 *    renewing.
 *  - products have fixed ids (`qdonis_plan_<planId>`, `qdonis_addon_<id>`).
 *
 * Free, contact-only, inactive and zero-priced packages are skipped.
 */
import 'dotenv/config';

import pg from 'pg';
import Stripe from 'stripe';

// Keep in step with STRIPE_API_VERSION in src/billing/stripe/stripe.client.ts.
const STRIPE_API_VERSION = '2026-09-30.endive';
const CURRENCY = 'usd';
const apply = process.argv.includes('--apply');

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

const isMissing = (error) =>
  error instanceof Stripe.errors.StripeInvalidRequestError &&
  error.code === 'resource_missing';

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** A usable price for `want`, whichever product it was created under. */
function matches(price, want) {
  if (
    !price.active ||
    price.currency !== CURRENCY ||
    price.unit_amount !== want.cents
  ) {
    return false;
  }
  return want.interval === null
    ? price.type === 'one_time'
    : price.type === 'recurring' &&
        price.recurring?.interval === want.interval &&
        price.recurring.interval_count === 1;
}

const secretKey = process.env.STRIPE_SECRET_KEY;
const databaseUrl = process.env.DATABASE_URL;
if (!secretKey) fail('STRIPE_SECRET_KEY is not set');
if (!databaseUrl) fail('DATABASE_URL is not set');
if (!/^(sk|rk)_(live|test)_/.test(secretKey)) {
  fail(
    'STRIPE_SECRET_KEY must be a secret key (sk_live_… / sk_test_…), not the webhook secret (whsec_…)',
  );
}
const mode = secretKey.includes('_live_') ? 'LIVE' : 'TEST';

const stripe = new Stripe(secretKey, {
  apiVersion: STRIPE_API_VERSION,
  maxNetworkRetries: 2,
  appInfo: { name: 'qdonis-sync-prices' },
});
// Prisma's `?schema=` is not a libpq option.
const url = new URL(databaseUrl);
url.searchParams.delete('schema');
const db = new pg.Client({ connectionString: url.toString() });

const knownProducts = new Set();

async function ensureProduct(id, name) {
  if (knownProducts.has(id)) return;
  knownProducts.add(id);
  try {
    const product = await stripe.products.retrieve(id);
    if (!product.active) {
      console.log(`  product ${id}: archived, reactivating`);
      if (apply) await stripe.products.update(id, { active: true });
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    console.log(`  product ${id}: creating "${name}"`);
    if (apply) await stripe.products.create({ id, name });
  }
}

/** Price id to store for `want`; null in a dry run when one would be created. */
async function ensurePrice(stored, want) {
  if (stored) {
    try {
      const price = await stripe.prices.retrieve(stored);
      if (matches(price, want)) return stored;
      console.log(
        `  ${want.lookupKey}: stored ${stored} has a different amount or interval`,
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      console.log(
        `  ${want.lookupKey}: stored ${stored} does not exist in this Stripe account`,
      );
    }
  }
  await ensureProduct(want.productId, want.productName);
  const found = await stripe.prices.list({
    lookup_keys: [want.lookupKey],
    active: true,
    limit: 1,
  });
  if (found.data[0] && matches(found.data[0], want)) return found.data[0].id;

  console.log(
    `  ${want.lookupKey}: creating ${money(want.cents)}${want.interval ? ` per ${want.interval}` : ' one-time'}`,
  );
  if (!apply) return null;
  const created = await stripe.prices.create({
    product: want.productId,
    currency: CURRENCY,
    unit_amount: want.cents,
    ...(want.interval ? { recurring: { interval: want.interval } } : {}),
    lookup_key: want.lookupKey,
    transfer_lookup_key: true,
    nickname: want.lookupKey,
  });
  return created.id;
}

async function main() {
  const account = await stripe.accounts.retrieveCurrent();
  console.log(
    `Stripe account ${account.id} (${account.settings?.dashboard?.display_name ?? 'no name'}), ${mode} mode`,
  );
  console.log(
    apply
      ? 'Applying changes.\n'
      : 'Dry run: nothing is written. Add --apply to write.\n',
  );

  await db.connect();
  let changed = 0;
  try {
    const { rows: packages } = await db.query(`
      SELECT pp.id, pp.plan_id, pp.name, pp.monthly_price_cents, pp.yearly_price_cents,
             pp.stripe_price_id_monthly, pp.stripe_price_id_yearly, pp.is_active,
             p.name AS plan_name, p.tier::text AS tier, p.is_contact_only, p.is_active AS plan_active
      FROM plan_packages pp JOIN plans p ON p.id = pp.plan_id
      ORDER BY p.sort_order, pp.sort_order`);

    for (const pkg of packages) {
      const sellable =
        pkg.is_active &&
        pkg.plan_active &&
        !pkg.is_contact_only &&
        pkg.tier !== 'FREE';
      if (!sellable) {
        console.log(`- ${pkg.id}: skipped (not sold through checkout)`);
        continue;
      }
      console.log(`- ${pkg.id} (${pkg.plan_name} ${pkg.name})`);
      const product = {
        productId: `qdonis_plan_${pkg.plan_id}`,
        productName: `Qdonis ${pkg.plan_name}`,
      };
      const monthly =
        pkg.monthly_price_cents > 0
          ? await ensurePrice(pkg.stripe_price_id_monthly, {
              ...product,
              lookupKey: `qdonis_${pkg.id}_monthly`,
              cents: pkg.monthly_price_cents,
              interval: 'month',
            })
          : null;
      const yearly =
        pkg.yearly_price_cents > 0
          ? await ensurePrice(pkg.stripe_price_id_yearly, {
              ...product,
              lookupKey: `qdonis_${pkg.id}_yearly`,
              cents: pkg.yearly_price_cents,
              interval: 'year',
            })
          : null;
      if (
        monthly === pkg.stripe_price_id_monthly &&
        yearly === pkg.stripe_price_id_yearly
      ) {
        console.log('  ok');
        continue;
      }
      changed += 1;
      console.log(
        `  DB: monthly=${monthly ?? '(new)'} yearly=${yearly ?? '(new)'}`,
      );
      if (apply) {
        await db.query(
          `UPDATE plan_packages
           SET stripe_price_id_monthly = $1, stripe_price_id_yearly = $2, updated_at = now()
           WHERE id = $3`,
          [monthly, yearly, pkg.id],
        );
      }
    }

    const { rows: addons } = await db.query(`
      SELECT id, name, price_cents, stripe_price_id, is_active
      FROM addon_packages ORDER BY sort_order`);
    for (const addon of addons) {
      if (!addon.is_active || addon.price_cents <= 0) {
        console.log(`- add-on ${addon.id}: skipped (inactive)`);
        continue;
      }
      console.log(`- add-on ${addon.id} (${addon.name})`);
      const price = await ensurePrice(addon.stripe_price_id, {
        productId: `qdonis_addon_${addon.id}`,
        productName: `Qdonis ${addon.name}`,
        lookupKey: `qdonis_addon_${addon.id}`,
        cents: addon.price_cents,
        interval: null,
      });
      if (price === addon.stripe_price_id) {
        console.log('  ok');
        continue;
      }
      changed += 1;
      console.log(`  DB: price=${price ?? '(new)'}`);
      if (apply) {
        await db.query(
          'UPDATE addon_packages SET stripe_price_id = $1, updated_at = now() WHERE id = $2',
          [price, addon.id],
        );
      }
    }
  } finally {
    await db.end();
  }

  console.log(
    `\n${changed} row(s) ${apply ? 'updated' : 'would change'}.${!apply && changed ? ' Re-run with --apply to write them.' : ''}`,
  );
}

main().catch((error) => {
  if (error instanceof Stripe.errors.StripeError) {
    fail(`Stripe: ${error.type} ${error.code ?? ''} ${error.message}`);
  }
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
