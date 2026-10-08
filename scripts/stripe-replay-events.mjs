/**
 * Re-delivers Stripe events to the local webhook, signed with
 * STRIPE_WEBHOOK_SECRET, e.g. after events were rejected while the secret was
 * misconfigured. Safe to repeat: the API applies each event id only once.
 *
 *   node scripts/stripe-replay-events.mjs evt_123 evt_456
 *   node scripts/stripe-replay-events.mjs --since-minutes 60   # all recent events
 *
 * Test-mode keys only. Target: WEBHOOK_URL or http://localhost:3000/api/v1/billing/stripe/webhook
 */
import 'dotenv/config';

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!key || !secret) throw new Error('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set');
if (!key.includes('_test_')) throw new Error('Refusing to replay with a live key');

const url = process.env.WEBHOOK_URL ?? 'http://localhost:3000/api/v1/billing/stripe/webhook';
const HANDLED = [
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];
const stripe = new Stripe(key, { apiVersion: '2026-09-30.endive' });

const args = process.argv.slice(2);
let events;
const sinceIndex = args.indexOf('--since-minutes');
if (sinceIndex >= 0) {
  const minutes = Number(args[sinceIndex + 1] ?? 60);
  const created = { gte: Math.floor(Date.now() / 1000) - minutes * 60 };
  events = [];
  for await (const event of stripe.events.list({ created, types: HANDLED, limit: 100 })) events.push(event);
} else {
  events = await Promise.all(args.map((id) => stripe.events.retrieve(id)));
}

// Oldest first, like Stripe delivers them.
events.sort((a, b) => a.created - b.created);
for (const event of events) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  });
  console.log(`${event.type} ${event.id} -> ${response.status} ${response.ok ? '' : await response.text()}`);
}
console.log(`Replayed ${events.length} event(s).`);
