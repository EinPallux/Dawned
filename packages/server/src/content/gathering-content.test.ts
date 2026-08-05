/**
 * The P10 gathering catalogue, checked against the REAL published rows
 * (seeded by migration 0017, authored through the panel's Professions editor).
 *
 * The publish rail already refuses an unpublished yield and an unbaked model,
 * so this is not a second copy of that gate. It checks the things a rail
 * cannot: that the LADDER is whole — every profession reaches every tier,
 * every tier's node actually rolls the material of its own tier, every gate is
 * reachable from the tier below, and no two nodes quietly share a model or an
 * item. Those are the failures that read as "gathering feels thin" months
 * later rather than as an error at publish time.
 *
 * Skipped with a loud warning when no database is reachable (CI provides one
 * as a service container, like the auth suite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_NODE_TIER,
  MIN_NODE_TIER,
  PROFESSIONS,
  gateForTier,
  nodeItemRefs,
  rollGather,
  tierForLevel,
  type ItemDef,
  type ResourceNodeDef,
} from '@dawned/shared';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadContent, type GameContent } from './loader.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://dawned:dawned@127.0.0.1:5432/dawned';

let content: GameContent | null = null;

beforeAll(async () => {
  try {
    const db = createDb(DATABASE_URL);
    await runMigrations(DATABASE_URL);
    content = await loadContent(db.db);
  } catch (error) {
    console.warn(
      `⚠️  gathering-content: no database (${(error as Error).message.split('\n')[0]}) — skipping`,
    );
  }
});

const nodes = (): ResourceNodeDef[] => [...(content?.resourceNodes.values() ?? [])];
const items = (): Map<string, ItemDef> => content?.items ?? new Map<string, ItemDef>();
const has = (): boolean => nodes().length > 0;

describe('the gathering ladder', () => {
  it('gives every profession a node at every tier', () => {
    if (!has()) return;
    const missing: string[] = [];
    for (const profession of PROFESSIONS) {
      for (let tier = MIN_NODE_TIER; tier <= MAX_NODE_TIER; tier++) {
        const found = nodes().some((def) => def.profession === profession && def.tier === tier);
        if (!found) missing.push(`${profession} T${tier}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * A tier whose gate is unreachable from the tier below is a wall, not a
   * gate: you would need XP from nodes you are not allowed to touch.
   */
  it('leaves every tier reachable by gathering the tier below it', () => {
    if (!has()) return;
    for (let tier = MIN_NODE_TIER + 1; tier <= MAX_NODE_TIER; tier++) {
      const gate = gateForTier(tier);
      expect(tierForLevel(gate - 1)).toBe(tier - 1);
      expect(tierForLevel(gate)).toBe(tier);
    }
  });

  it('rolls something on every gather — §1.1 promises no fail-rolls', () => {
    if (!has()) return;
    for (const def of nodes()) {
      // Sweep the yield-pick roll across its whole range: a weight table with
      // a hole would return nothing for some slice of it.
      for (const pick of [0, 0.17, 0.33, 0.5, 0.67, 0.83, 0.999]) {
        const rolled = rollGather(
          def,
          { yieldPick: pick, yieldQty: 0.5, proc: 1, procPick: 0, procQty: 0 },
          0,
        );
        expect(rolled.yields.length, `${def.id} gave nothing at pick ${pick}`).toBeGreaterThan(0);
        for (const stack of rolled.yields) expect(stack.qty).toBeGreaterThan(0);
      }
    }
  });

  it('resolves every yield and proc to a published item', () => {
    if (!has()) return;
    const unknown: string[] = [];
    for (const def of nodes()) {
      for (const itemId of nodeItemRefs(def)) {
        if (!items().has(itemId)) unknown.push(`${def.id} → ${itemId}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  /**
   * The tier tell. A T4 vein that mostly gives T1 stone would be a node whose
   * whole reason to exist — being further up the ladder — is invisible in the
   * bag. Every node must be able to roll at least one item whose level band
   * matches its own tier.
   */
  it('gives each node at least one yield from its own tier band', () => {
    if (!has()) return;
    const flat: string[] = [];
    for (const def of nodes()) {
      const band = { 1: [1, 6], 2: [7, 12], 3: [13, 18], 4: [19, 24], 5: [25, 30] }[def.tier] ?? [
        1, 30,
      ];
      const onTier = def.yields.some((entry) => {
        const item = items().get(entry.itemId);
        return item !== undefined && item.ilvl >= band[0]! && item.ilvl <= band[1]!;
      });
      if (!onTier) flat.push(def.id);
    }
    expect(flat).toEqual([]);
  });

  /**
   * Two nodes on one model means two things a player cannot tell apart while
   * standing in front of them. Fishing spots are exempt in principle but do
   * not need to be in practice, so the check covers everything.
   */
  it('gives every node its own standing model', () => {
    if (!has()) return;
    const byModel = new Map<string, string[]>();
    for (const def of nodes()) {
      byModel.set(def.modelRef, [...(byModel.get(def.modelRef) ?? []), def.id]);
    }
    const shared = [...byModel].filter(([, ids]) => ids.length > 1);
    expect(shared).toEqual([]);
  });

  it('never sells the same material out of two different item rows', () => {
    if (!has()) return;
    const byName = new Map<string, string[]>();
    for (const def of nodes()) {
      for (const itemId of nodeItemRefs(def)) {
        const item = items().get(itemId);
        if (!item) continue;
        byName.set(item.name, [...new Set([...(byName.get(item.name) ?? []), itemId])]);
      }
    }
    expect([...byName].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });

  it('respawns inside the §1.1 window, except the one node that says otherwise', () => {
    if (!has()) return;
    for (const def of nodes()) {
      // Dawnpetal is the deliberate exception: ten minutes, because it is the
      // only node in the game you make a journey FOR (§4).
      const max = def.id === 'node_herbalism_dawnpetal' ? 600_000 : 180_000;
      expect(def.respawnMs, def.id).toBeGreaterThanOrEqual(90_000);
      expect(def.respawnMs, def.id).toBeLessThanOrEqual(max);
    }
  });
});
