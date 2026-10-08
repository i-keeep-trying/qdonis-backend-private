// ---------------------------------------------------------------------------
// Prisma CLI configuration (Prisma 7).
//
// This file replaces the implicit configuration of earlier versions: the schema
// location, migration directory and datasource URLs all live here. Prisma 7 no
// longer loads .env automatically, hence the explicit `dotenv/config` import,
// which must stay the first import in the file.
//
// Only the Prisma CLI reads this file. The running application builds its own
// connection from the validated config in src/config.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  // A directory, not a file: Prisma merges every *.prisma file underneath it
  // (recursively) into a single schema. See prisma/schema/_base.prisma.
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
