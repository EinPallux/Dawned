/**
 * Published skill-tree nodes from the game server (content-as-data): the
 * client draws the K-panel trees from — and predicts allocations against —
 * the SAME rows the server validates and folds. Fetched once per world entry.
 */

import { skillNodeDefSchema, type SkillNodeDef } from '@dawned/shared';

export const loadSkillNodeDefs = async (): Promise<SkillNodeDef[]> => {
  const defs: SkillNodeDef[] = [];
  try {
    const response = await fetch('/api/content/skill-nodes');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { nodes?: unknown[] };
    for (const raw of payload.nodes ?? []) {
      const parsed = skillNodeDefSchema.safeParse(raw);
      if (parsed.success) defs.push(parsed.data);
    }
  } catch (error) {
    // Without node defs the trees render empty and allocation clicks no-op;
    // the server keeps playing fine — a reload recovers.
    console.warn('[content] skill node defs unavailable:', error);
  }
  return defs;
};
