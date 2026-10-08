/**
 * Creates (or reuses) a Stripe product + monthly/yearly recurring prices for
 * every active plan package, and stores the price ids in `plan_packages`.
 *
 *   node scripts/stripe-sync-prices.mjs          # apply
 *   node scripts/stripe-sync-prices.mjs --check  # report only
 *
 * Idempotent: prices are found again through their lookup_key
 * (`qdonis_<package>_<interval>`). If an amount changed, a new price is
 * created and the lookup key moved to it (Stripe prices are immutable;
 * existing subscribers stay on their old price until they change plan).
 *
 * Reads STRIPE_SECRET_KEY and DATABASE_URL from .env. Refuses live keys
 * unless --allow-live is passed.
 */
import 'dotenv/config';

import pg from 'pg';
import Stripe from 'stripe';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
if (key.includes('_live_') && !args.has('--allow-live')) {
  throw new Error('Live Stripe key detected; re-run with --allow-live if this is intended');
}

const stripe = new Stripe(key, { apiVersion: '2026-09-30.endive' });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const account = await stripe.accounts.retrieve();
console.log(`Stripe account ${account.id} (${key.includes('_test_') ? 'test' : 'live'})`);

const { rows: packages } = await db.query(`
  SELECT p.id, p.name, p.monthly_price_cents, p.yearly_price_cents,
         p.stripe_price_id_monthly, p.stripe_price_id_yearly, pl.name AS plan_name
  FROM plan_packages p JOIN plans pl ON pl.id = p.plan_id
  WHERE p.is_active AND pl.is_active AND NOT pl.is_contact_only AND pl.tier <> 'FREE'
  ORDER BY pl.sort_order, p.sort_order`);

async function existingPriceUsable(priceId, cents, interval) {
  if (!priceId) return false;
  try {
    const price = await stripe.prices.retrieve(priceId);
    return price.active && price.unit_amount === cents && price.currency === 'usd' && price.recurring?.interval === interval;
  } catch {
    return false;
  }
}

async function ensurePrice(pkg, productId, interval, cents) {
  const lookupKey = `qdonis_${pkg.id}_${interval}`;
  const found = (await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })).data[0];
  if (found && found.active && found.unit_amount === cents && found.recurring?.interval === interval) return found.id;
  const price = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: cents,
    recurring: { interval },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    metadata: { packageId: pkg.id, interval },
  });
  return price.id;
}

async function ensureProduct(pkg) {
  const search = await stripe.products.search({ query: `metadata['packageId']:'${pkg.id}'`, limit: 1 });
  if (search.data[0]) return search.data[0].id;
  const product = await stripe.products.create(
    { name: `Qdonis ${pkg.plan_name} ${pkg.name}`, metadata: { packageId: pkg.id } },
    { idempotencyKey: `qdonis-product-${pkg.id}` },
  );
  return product.id;
}

let changed = 0;
for (const pkg of packages) {
  const monthlyOk = await existingPriceUsable(pkg.stripe_price_id_monthly, pkg.monthly_price_cents, 'month');
  const yearlyOk = await existingPriceUsable(pkg.stripe_price_id_yearly, pkg.yearly_price_cents, 'year');
  if (monthlyOk && yearlyOk) {
    console.log(`  ${pkg.id}: OK`);
    continue;
  }
  console.log(`  ${pkg.id}: monthly ${monthlyOk ? 'ok' : 'MISSING'}, yearly ${yearlyOk ? 'ok' : 'MISSING'}`);
  if (checkOnly) continue;

  const productId = await ensureProduct(pkg);
  const monthly = monthlyOk ? pkg.stripe_price_id_monthly : await ensurePrice(pkg, productId, 'month', pkg.monthly_price_cents);
  const yearly = yearlyOk ? pkg.stripe_price_id_yearly : await ensurePrice(pkg, productId, 'year', pkg.yearly_price_cents);
  await db.query(
    'UPDATE plan_packages SET stripe_price_id_monthly = $1, stripe_price_id_yearly = $2, updated_at = now() WHERE id = $3',
    [monthly, yearly, pkg.id],
  );
  console.log(`    -> ${monthly} / ${yearly}`);
  changed += 1;
}

await db.end();
console.log(checkOnly ? 'Check complete.' : `Done. Updated ${changed} package(s).`);
