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
  defaultWorldSettings,
  defaultXpCurve,
  enemyDefSchema,
  spawnerDefSchema,
  buildXpCurve,
  validateEnemyDef,
  validateSkillNodeDef,
  validateXpCurveEntry,
  worldSettingsSchema,
  type AbilityDef,
  type ClassId,
  type EnemyDef,
  type SkillNodeDef,
  type SpawnerDef,
  type WorldSettings,
  type XpCurve,
  type XpCurveEntry,
  validateItemDef,
  validateLootTableDef,
  validateVendorDef,
  validateResourceNodeDef,
  type ItemDef,
  type LootTableDef,
  type VendorDef,
  type ResourceNodeDef,
} from '@dawned/shared';
import {
  contentAbilities,
  contentEnemies,
  contentSkillNodes,
  contentSpawners,
  contentWorldSettings,
  contentXpCurve,
  contentItems,
  contentLootTables,
  contentVendors,
  contentResourceNodes,
} from '@dawned/shared/schema';
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
  /** Level curve (P7): published rows, or the formula defaults pre-seed. */
  xpCurve: XpCurve;
  /** Skill-tree nodes by id (P7): empty pre-seed — trees simply offer nothing. */
  skillNodes: Map<string, SkillNodeDef>;
  /** Published world settings (xpRate now; more keys as phases land). */
  worldSettings: WorldSettings;
  /** Item definitions (P8): empty pre-seed — nothing drops, nothing breaks. */
  items: Map<string, ItemDef>;
  /** Loot tables (P8) keyed by id; enemies reference them by slug. */
  lootTables: Map<string, LootTableDef>;
  /** Vendors (P8) — stock + world anchors for the market posts. */
  vendors: Map<string, VendorDef>;
  /** Resource-node definitions (P10) — what each kind of node yields. */
  resourceNodes: Map<string, ResourceNodeDef>;
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

  // Items, loot tables and vendors (P8). Each row is validated by its shared
  // schema; a bad row is a publish bug, so it fails the boot loudly rather
  // than letting the world run with half a reward engine.
  const items = new Map<string, ItemDef>();
  const itemRows = await db.select().from(contentItems).where(eq(contentItems.status, 'published'));
  for (const row of itemRows) {
    try {
      const def = validateItemDef(row.def);
      items.set(def.id, def);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  // §8: every item carries a UNIQUE icon. The panel enforces it at publish;
  // boot re-checks so a hand-edited database can't ship duplicate art.
  const iconOwners = new Map<string, string>();
  for (const def of items.values()) {
    const owner = iconOwners.get(def.icon);
    if (owner) problems.push(`items ${owner} and ${def.id} share icon "${def.icon}"`);
    else iconOwners.set(def.icon, def.id);
  }

  const lootTables = new Map<string, LootTableDef>();
  const lootRows = await db
    .select()
    .from(contentLootTables)
    .where(eq(contentLootTables.status, 'published'));
  for (const row of lootRows) {
    try {
      const def = validateLootTableDef(row.def);
      lootTables.set(def.id, def);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  const vendors = new Map<string, VendorDef>();
  const vendorRows = await db
    .select()
    .from(contentVendors)
    .where(eq(contentVendors.status, 'published'));
  for (const row of vendorRows) {
    try {
      const def = validateVendorDef(row.def);
      vendors.set(def.id, def);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  const resourceNodes = new Map<string, ResourceNodeDef>();
  const resourceNodeRows = await db
    .select()
    .from(contentResourceNodes)
    .where(eq(contentResourceNodes.status, 'published'));
  for (const row of resourceNodeRows) {
    try {
      const def = validateResourceNodeDef(row.def);
      resourceNodes.set(def.id, def);
    } catch (error) {
      problems.push((error as Error).message);
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

  // XP curve (P7): published rows must be COMPLETE (levels 1..29 once each) —
  // buildXpCurve throws into `problems` otherwise. A database that predates
  // the P7 seed runs the formula defaults and says so.
  let xpCurve: XpCurve = defaultXpCurve();
  const curveRows = await db
    .select()
    .from(contentXpCurve)
    .where(eq(contentXpCurve.status, 'published'));
  if (curveRows.length > 0) {
    const entries: XpCurveEntry[] = [];
    for (const row of curveRows) {
      try {
        entries.push(validateXpCurveEntry(row.def));
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    if (problems.length === 0) {
      try {
        xpCurve = buildXpCurve(entries);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
  } else {
    console.warn('[content] no published xp_curve rows — using formula defaults');
  }

  // Skill nodes (P7): every published row validates or the boot fails. An
  // EMPTY set is legal (pre-seed databases) — the trees simply offer nothing.
  const skillNodes = new Map<string, SkillNodeDef>();
  const nodeRows = await db
    .select()
    .from(contentSkillNodes)
    .where(eq(contentSkillNodes.status, 'published'));
  for (const row of nodeRows) {
    try {
      const def = validateSkillNodeDef(row.def);
      skillNodes.set(def.id, def);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  // World settings: one published row per key; missing keys take schema
  // defaults (xpRate 1.0). Unknown keys are a publish bug — fail loud.
  let worldSettings: WorldSettings = defaultWorldSettings();
  const settingRows = await db
    .select()
    .from(contentWorldSettings)
    .where(eq(contentWorldSettings.status, 'published'));
  if (settingRows.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const row of settingRows) merged[row.key] = row.value;
    const parsed = worldSettingsSchema.safeParse(merged);
    if (parsed.success) {
      worldSettings = parsed.data;
    } else {
      problems.push(
        `world settings: ${parsed.error.issues[0]?.path.join('.') ?? '?'}: ${
          parsed.error.issues[0]?.message ?? 'invalid'
        }`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`published content failed validation:\n  ${problems.join('\n  ')}`);
  }

  return {
    enemies,
    spawners,
    abilities,
    abilityBySlot,
    basicChains,
    xpCurve,
    skillNodes,
    worldSettings,
    items,
    lootTables,
    vendors,
    resourceNodes,
  };
};
