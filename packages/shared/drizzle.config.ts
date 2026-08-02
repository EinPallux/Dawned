import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config — `pnpm --filter @dawned/shared db:generate` writes SQL
 * migrations into ./drizzle, which are committed and applied by the server's
 * `db:migrate` (docs/tech/DATABASE.md §5).
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
});
