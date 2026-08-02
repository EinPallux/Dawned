/**
 * Database access — one pg Pool for the whole process (docs/tech/DATABASE.md §7:
 * the game server's share of max_connections is 10).
 */

import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@dawned/shared/schema';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export const createDb = (databaseUrl: string): DbHandle => {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
};

/**
 * True when an error (or anything in its `cause` chain) is a Postgres unique
 * violation — drizzle 0.45 wraps driver errors in DrizzleQueryError, so the
 * pg code sits one level down.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/** Fail-fast connectivity probe at boot — a clear message beats a hang. */
export const assertDbReachable = async (handle: DbHandle): Promise<void> => {
  try {
    await handle.pool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL (${(error as Error).message}). ` +
        'Is it running, and is DATABASE_URL correct? Local dev: see .env.example.',
    );
  }
};

/**
 * Boot-time schema probe: a reachable database with no tables means migrations
 * never ran — refuse to start with a clear message instead of coming up
 * "healthy" and failing every registration/login at runtime.
 */
export const assertSchemaPresent = async (handle: DbHandle): Promise<void> => {
  const result = await handle.pool.query<{ ok: boolean }>(
    "SELECT to_regclass('public.accounts') IS NOT NULL AS ok",
  );
  if (!result.rows[0]?.ok) {
    throw new Error(
      'Database is reachable but the schema is missing (no "accounts" table). ' +
        'Run migrations first: pnpm db:migrate (deploy/UPDATE.sh does this — ' +
        'if you see this on the VPS, the migration step failed; check its output).',
    );
  }
};
