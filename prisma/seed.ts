/**
 * Development seed.
 *
 * Idempotent: re-running it updates the demo accounts instead of failing on the
 * unique email index, so it is safe to invoke after every reset.
 *
 *   npm run db:seed
 *
 * Refuses to run with NODE_ENV=production. Demo passwords come from
 * SEED_ADMIN_PASSWORD / SEED_USER_PASSWORD, or are generated and printed once.
 */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';

import { PrismaClient } from '../src/generated/prisma/client';
import { Role } from '../src/generated/prisma/enums';

const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);

const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Builds a deterministic unit-length vector so seeded similarity scores are
 * reproducible across runs.
 */
function deterministicEmbedding(seed: number, dimensions: number): number[] {
  const values = Array.from({ length: dimensions }, (_, index) =>
    Math.sin((index + 1) * seed * 0.017),
  );
  const magnitude = Math.sqrt(
    values.reduce((total, value) => total + value * value, 0),
  );
  return values.map((value) => value / (magnitude || 1));
}

/** Demo password from the environment, or a random one printed once. */
function seedPassword(variable: string): string {
  const fromEnv = process.env[variable];
  if (fromEnv) return fromEnv;
  const generated = `seed-${crypto.randomUUID()}`;
  console.log(`${variable} not set; generated password: ${generated}`);
  return generated;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo accounts with NODE_ENV=production');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const [admin, user] = await Promise.all([
      prisma.user.upsert({
        where: { email: 'admin@example.com' },
        update: { role: Role.ADMIN, isActive: true, emailVerifiedAt: new Date() },
        create: {
          email: 'admin@example.com',
          name: 'Admin User',
          role: Role.ADMIN,
          emailVerifiedAt: new Date(),
          passwordHash: await argon2.hash(seedPassword('SEED_ADMIN_PASSWORD'), ARGON2_OPTIONS),
        },
      }),
      prisma.user.upsert({
        where: { email: 'user@example.com' },
        update: { role: Role.USER, isActive: true, emailVerifiedAt: new Date() },
        create: {
          email: 'user@example.com',
          name: 'Demo User',
          role: Role.USER,
          emailVerifiedAt: new Date(),
          passwordHash: await argon2.hash(seedPassword('SEED_USER_PASSWORD'), ARGON2_OPTIONS),
        },
      }),
    ]);

    console.log(`Seeded users: ${admin.email}, ${user.email}`);

    // Documents are re-seeded from scratch; embeddings must be written with raw
    // SQL because Prisma cannot address an `Unsupported` column.
    await prisma.document.deleteMany({
      where: { metadata: { path: ['seed'], equals: true } },
    });

    const samples = [
      { title: 'pgvector basics', content: 'pgvector adds vector similarity search to PostgreSQL.' },
      { title: 'HNSW indexes', content: 'HNSW gives fast approximate nearest neighbour lookups.' },
      { title: 'Prisma driver adapters', content: 'Prisma 7 connects through a driver adapter such as pg.' },
    ];

    for (const [index, sample] of samples.entries()) {
      const embedding = deterministicEmbedding(index + 1, EMBEDDING_DIMENSIONS);
      const id = crypto.randomUUID();

      await prisma.$executeRaw`
        INSERT INTO documents (id, user_id, title, content, embedding, metadata, created_at, updated_at)
        VALUES (
          ${id}::uuid,
          ${user.id}::uuid,
          ${sample.title},
          ${sample.content},
          ${`[${embedding.join(',')}]`}::vector,
          ${JSON.stringify({ seed: true })}::jsonb,
          NOW(),
          NOW()
        )
      `;
    }

    console.log(`Seeded ${samples.length} documents with embeddings`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
