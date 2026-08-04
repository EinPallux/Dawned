/**
 * Published item definitions from the game server (content-as-data): the wire
 * only ever carries item IDs, so this is where a bag cell learns its name,
 * icon, rarity, stat block and flavour line. Fetched once per world entry.
 */

import { itemDefSchema, type ItemDef } from '@dawned/shared';

export const loadItemDefs = async (): Promise<Map<string, ItemDef>> => {
  const defs = new Map<string, ItemDef>();
  try {
    const response = await fetch('/api/content/items');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { items?: unknown[] };
    for (const raw of payload.items ?? []) {
      const parsed = itemDefSchema.safeParse(raw);
      if (parsed.success) defs.set(parsed.data.id, parsed.data);
    }
  } catch (error) {
    // Without defs the bag renders ids instead of names — the pack itself is
    // server state and stays correct; a reload recovers the catalogue.
    console.warn('[content] item defs unavailable:', error);
  }
  return defs;
};
