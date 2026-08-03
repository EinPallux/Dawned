/**
 * Published ability definitions from the game server (content-as-data): the
 * client predicts hotbar presses with the SAME rows the server validates —
 * costs, cooldowns, clips, targeting. Fetched once per world entry.
 */

import { abilityDefSchema, type AbilityDef } from '@dawned/shared';

export const loadAbilityDefs = async (): Promise<AbilityDef[]> => {
  const defs: AbilityDef[] = [];
  try {
    const response = await fetch('/api/content/abilities');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { abilities?: unknown[] };
    for (const raw of payload.abilities ?? []) {
      const parsed = abilityDefSchema.safeParse(raw);
      if (parsed.success) defs.push(parsed.data);
    }
  } catch (error) {
    // Without defs the hotbar renders empty and presses no-op — basics and
    // movement still work; a reload recovers.
    console.warn('[content] ability defs unavailable:', error);
  }
  return defs;
};
