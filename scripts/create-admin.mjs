/**
 * Creates an admin account, or promotes/repairs an existing one.
 *
 *   node scripts/create-admin.mjs admin@example.com            # random password, printed once
 *   node scripts/create-admin.mjs admin@example.com "S3cret-pass-1"
 *
 * The account is active, email-verified and unlocked. With a password given
 * (or for a new account) the password is set and all its sessions revoked.
 * Uses DATABASE_URL from .env. Refuses NODE_ENV=production unless
 * --allow-production is passed.
 */
import 'dotenv/config';

import { randomBytes, randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import pg from 'pg';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
if (process.env.NODE_ENV === 'production' && !flags.has('--allow-production')) {
  throw new Error('NODE_ENV=production: re-run with --allow-production if intended');
}

const email = (args[0] ?? '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error('Usage: node scripts/create-admin.mjs <email> [password]');
}
let password = args[1];
const generated = !password;
if (generated) password = `Qd-${randomBytes(12).toString('base64url')}1`;
if (password.length < 10 || password.length > 128 || !/\p{L}/u.test(password) || !/\p{N}/u.test(password)) {
  throw new Error('Password must be 10-128 characters with a letter and a number');
}

// Same Argon2id parameters as PasswordHasher.
const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN');
  const { rows } = await db.query(
    `INSERT INTO users (id, email, password_hash, name, role, is_active, email_verified_at, updated_at)
     VALUES ($1, $2, $3, 'Admin', 'ADMIN', true, now(), now())
     ON CONFLICT (email) DO UPDATE SET
       role = 'ADMIN', is_active = true, failed_login_attempts = 0, locked_until = NULL,
       email_verified_at = COALESCE(users.email_verified_at, now()),
       password_hash = EXCLUDED.password_hash, password_changed_at = now(), updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [randomUUID(), email, hash],
  );
  // A new password must end any session started with the old one.
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset'
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [rows[0].id],
  );
  await db.query('COMMIT');
  console.log(`${rows[0].created ? 'Created' : 'Updated'} admin ${email}`);
  console.log(generated ? `Password: ${password}` : 'Password: (as given)');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}
