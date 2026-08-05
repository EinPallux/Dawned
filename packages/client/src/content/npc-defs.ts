/**
 * Published NPC definitions (P11): who each villager standing in the baked map
 * IS. The bake gives the client WHERE — an id, a position, a rotation — and
 * this gives it everything else, so the wire never has to carry an NPC's
 * appearance, barks or role.
 *
 * Same shape as the resource-node loader, and survivable in the same way: with
 * no definitions nobody renders and no prompt appears, which reads as an empty
 * village rather than as a broken world.
 */

import { npcDefSchema, type NpcDef } from '@dawned/shared';

export const loadNpcDefs = async (): Promise<Map<string, NpcDef>> => {
  const defs = new Map<string, NpcDef>();
  try {
    const response = await fetch('/api/content/npcs');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { npcs?: unknown[] };
    for (const raw of payload.npcs ?? []) {
      const parsed = npcDefSchema.safeParse(raw);
      if (parsed.success) defs.set(parsed.data.id, parsed.data);
    }
  } catch (error) {
    console.warn('[content] npc defs unavailable:', error);
  }
  return defs;
};
