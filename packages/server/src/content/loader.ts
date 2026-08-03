/**
 * Published-content loader (docs/tech/DATABASE.md §3): the game server reads
 * ONLY `status='published'` rows and validates every one through the shared
 * zod schemas at boot. Invalid content fails the boot loudly — a server
 * quietly running half a bestiary is a debugging nightmare, not resilience.
 */

import { eq } from 'drizzle-orm';
import {
  BASIC_COMBOS,
  abilityDefSchema,
  buildBasicChains,
  type ComboChain,
  enemyDefSchema,
  spawnerDefSchema,
  validateEnemyDef,
  type AbilityDef,
  type ClassId,
  type EnemyDef,
  type SpawnerDef,
} from '@dawned/shared';
import { contentAbilities, contentEnemies, contentSpawners } from '@dawned/shared/schema';
import type { Db } from '../db/client.js';

export interface GameContent {
  enemies: Map<string, EnemyDef>;
  spawners: SpawnerDef[];
  /** All published abilities by id. */
  abilities: Map<string, AbilityDef>;
  /** Hotbar lookup: `${classId}:${slot}` → def (request routing). */
  abilityBySlot: Map<string, AbilityDef>;
  /** Basic combo chains — content-sourced (falls back to code until 0005 seeds). */
  basicChains: Record<ClassId, ComboChain>;
}

export const slotKey = (classId: ClassId, slot: number): string => `${classId}:${slot}`;

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

  const abilities = new Map<string, AbilityDef>();
  const abilityBySlot = new Map<string, AbilityDef>();
  const abilityRows = await db
    .select()
    .from(contentAbilities)
    .where(eq(contentAbilities.status, 'published'));
  for (const row of abilityRows) {
    const parsed = abilityDefSchema.safeParse(row.def);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push(
        `ability ${row.id}: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`,
      );
      continue;
    }
    const def = parsed.data;
    abilities.set(def.id, def);
    if (def.binding.kind === 'slot') {
      const key = slotKey(def.classId, def.binding.slot);
      if (abilityBySlot.has(key)) {
        problems.push(
          `ability ${row.id}: slot ${key} already bound to ${abilityBySlot.get(key)!.id}`,
        );
        continue;
      }
      abilityBySlot.set(key, def);
    }
  }

  if (problems.length > 0) {
    throw new Error(`published content failed validation:\n  ${problems.join('\n  ')}`);
  }

  // Basics from content (COMBAT.md §3 as-built): the shared fallback covers a
  // database that predates the kit seed migration — warn, never half-load.
  const basicChains = buildBasicChains([...abilities.values()]) ?? BASIC_COMBOS;
  if (buildBasicChains([...abilities.values()]) === null) {
    console.warn('[content] basic-combo rows missing/incomplete — using shared BASIC_COMBOS');
  }

  return { enemies, spawners, abilities, abilityBySlot, basicChains };
};
