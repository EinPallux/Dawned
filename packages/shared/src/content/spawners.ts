/**
 * Spawner content rows — `content_spawners` (docs/tech/DATABASE.md §3,
 * docs/design/NPCS_ENEMIES.md §3). Placed by the Map Editor from A2; P4 seeds
 * ship as published rows. The server owns respawn tickets; these rows are the
 * where/what/how-often.
 */

import { z } from 'zod';
import { contentSlug } from './enemies.js';

export const spawnerEntrySchema = z.object({
  enemyId: contentSlug,
  /** How many of this entry the spawner keeps alive. */
  count: z.number().int().min(1).max(12),
  /** Level within the enemy's band; null = roll uniformly in [levelMin, levelMax]. */
  level: z.number().int().min(1).max(30).nullable().default(null),
});

export const spawnerDefSchema = z.object({
  id: contentSlug,
  kind: z.enum(['point', 'area']),
  x: z.number().min(-1024).max(1024),
  z: z.number().min(-1024).max(1024),
  /** Area spawners scatter within this radius (point spawners: small jitter). */
  radius: z.number().min(0).max(48).default(6),
  entries: z.array(spawnerEntrySchema).min(1).max(6),
  /** Respawn delay after a death ticket, ms (±20% jitter server-side). */
  respawnMs: z.number().int().min(5000).max(600_000).default(90_000),
  /** Camp tag shared with enemy rows for social aggro; null = independent. */
  campTag: z.string().max(40).nullable().default(null),
  /** Inert until P14 day/night: night-only spawning flag ships disabled. */
  nightOnly: z.boolean().default(false),
});

export type SpawnerEntry = z.infer<typeof spawnerEntrySchema>;
export type SpawnerDef = z.infer<typeof spawnerDefSchema>;
