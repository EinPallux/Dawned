/**
 * Published resource-node definitions (P10): what each node standing in the
 * baked map IS. The bake gives the client WHERE — an id, a position, a
 * rotation and a scale — and this gives it everything else, so the wire never
 * has to carry a node's model, tier or hold time.
 */

import { resourceNodeDefSchema, type ResourceNodeDef } from '@dawned/shared';

export const loadResourceNodeDefs = async (): Promise<Map<string, ResourceNodeDef>> => {
  const defs = new Map<string, ResourceNodeDef>();
  try {
    const response = await fetch('/api/content/resource-nodes');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { nodes?: unknown[] };
    for (const raw of payload.nodes ?? []) {
      const parsed = resourceNodeDefSchema.safeParse(raw);
      if (parsed.success) defs.set(parsed.data.id, parsed.data);
    }
  } catch (error) {
    // Survivable: without defs no node renders and the prompt never appears,
    // which reads as "there is nothing here" rather than as a broken world.
    console.warn('[content] resource-node defs unavailable:', error);
  }
  return defs;
};
