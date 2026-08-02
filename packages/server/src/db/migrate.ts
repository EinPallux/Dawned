/**
 * Migration runner — `pnpm db:migrate` (called by deploy/UPDATE.sh before every
 * restart, and by hand in dev). Applies the SQL files committed under
 * packages/shared/drizzle/ (docs/tech/DATABASE.md §5).
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { createDb, assertDbReachable } from './client.js';

const require = createRequire(import.meta.url);

/** The shared package's committed migrations folder, wherever pnpm linked it. */
export const migrationsFolder = (): string =>
  path.join(path.dirname(require.resolve('@dawned/shared/package.json')), 'drizzle');

export const runMigrations = async (databaseUrl: string): Promise<void> => {
  const handle = createDb(databaseUrl);
  try {
    await assertDbReachable(handle);
    await migrate(handle.db, { migrationsFolder: migrationsFolder() });
  } finally {
    await handle.close();
  }
};

// Executed directly (not imported): run and report.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const config = loadConfig();
  runMigrations(config.DATABASE_URL)
    .then(() => {
      console.log(`migrations applied (${migrationsFolder()})`);
    })
    .catch((error: unknown) => {
      console.error(`migration failed: ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
