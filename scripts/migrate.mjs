// Runtime DB migrator. Used as the prod "pre-deploy" step (e.g. Coolify
// pre-deploy command, or as a separate one-off container) so we don't need
// drizzle-kit installed in the production image.
//
// Reads DATABASE_URL from the environment and applies any pending migrations
// in ./drizzle. Safe to run repeatedly — drizzle tracks applied migrations in
// the `__drizzle_migrations` table.
//
// Usage: node scripts/migrate.mjs

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('migrate: DATABASE_URL is not set');
  process.exit(1);
}

// Migrations are short-lived — small pool, no extra connection retained.
const client = postgres(url, { max: 1 });
const db = drizzle(client);

try {
  console.log('migrate: applying pending migrations from ./drizzle');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('migrate: done');
} catch (err) {
  console.error('migrate: failed');
  console.error(err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
