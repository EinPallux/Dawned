/**
 * Published enemy definitions from the game server (content-as-data): the
 * client renders enemies from the same rows the server simulates — ability
 * clip names by ordinal, capsules, scales. Fetched once per world entry.
 */

import { enemyDefSchema, type EnemyDef } from '@dawned/shared';

export const loadEnemyDefs = async (): Promise<Map<string, EnemyDef>> => {
  const defs = new Map<string, EnemyDef>();
  try {
    const response = await fetch('/api/content/enemies');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { enemies?: unknown[] };
    for (const raw of payload.enemies ?? []) {
      const parsed = enemyDefSchema.safeParse(raw);
      if (parsed.success) defs.set(parsed.data.id, parsed.data);
    }
  } catch (error) {
    // Enemies still render (meta carries model/scale) — ability wind-up clips
    // degrade to the generic move/idle set until a reload.
    console.warn('[content] enemy defs unavailable:', error);
  }
  return defs;
};
