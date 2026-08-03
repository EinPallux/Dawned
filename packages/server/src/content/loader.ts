/**
 * Published-content loader (docs/tech/DATABASE.md §3): the game server reads
 * ONLY `status='published'` rows and validates every one through the shared
 * zod schemas at boot. Invalid content fails the boot loudly — a server
 * quietly running half a bestiary is a debugging nightmare, not resilience.
 */

import { eq } from 'drizzle-orm';
import {
  enemyDefSchema,
  spawnerDefSchema,
  validateEnemyDef,
  type EnemyDef,
  type SpawnerDef,
} from '@dawned/shared';
import { contentEnemies, contentSpawners } from '@dawned/shared/schema';
import type { Db } from '../db/client.js';

export interface GameContent {
  enemies: Map<string, EnemyDef>;
  spawners: SpawnerDef[];
}

export const loadContent = async (db: Db): Promise<GameContent> => {
  const enemies = new Map<string, EnemyDef>();
  const problems: string[] = [];

  const enemyRows = await db
    .select()
    .from(contentEnemies)
    .where(eq(contentEnemies.status, 'published'));
  for (const row of enemyRows) {
    const parsed = enemyDefSchema.safeParse(row.def);
    if (!parsed.success) {
      problems.push(`enemy ${row.id}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      continue;
    }
    const defProblems = validateEnemyDef(parsed.data);
    if (defProblems.length > 0) {
      problems.push(`enemy ${row.id}: ${defProblems.join('; ')}`);
      continue;
    }
    enemies.set(parsed.data.id, parsed.data);
  }

  const spawners: SpawnerDef[] = [];
  const spawnerRows = await db
    .select()
    .from(contentSpawners)
    .where(eq(contentSpawners.status, 'published'));
  for (const row of spawnerRows) {
    const parsed = spawnerDefSchema.safeParse(row.def);
    if (!parsed.success) {
      problems.push(`spawner ${row.id}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      continue;
    }
    for (const entry of parsed.data.entries) {
      if (!enemies.has(entry.enemyId)) {
        problems.push(`spawner ${row.id}: unknown enemy "${entry.enemyId}"`);
      }
    }
    spawners.push(parsed.data);
  }

  if (problems.length > 0) {
    throw new Error(`published content failed validation:\n  ${problems.join('\n  ')}`);
  }
  return { enemies, spawners };
};
