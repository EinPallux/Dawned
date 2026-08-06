/**
 * NPC definitions and the two client-authored P11 envelopes (P11-A).
 *
 * The schema tests are deliberately thin — zod is doing the work — but the
 * per-role rules and the op gates are hand-written, and both of them are the
 * kind of thing that fails silently in the world rather than loudly at parse.
 */

import { describe, expect, it } from 'vitest';
import { npcPlacementSchema, validateNpc, validateNpcDef } from './npcs.js';
import { parseInteractOp, parseQuestOp, interactRefusalText } from '../protocol/quest-ops.js';

const npc = (over: Record<string, unknown> = {}) =>
  validateNpcDef({
    id: 'npc_marla',
    name: 'Marla',
    title: 'Dawnhaven gate farmer',
    appearance: {
      body: 'f',
      skin: 1,
      outfit: 'peasant',
      outfitTint: 0,
      hair: 'buns',
      hairColor: 2,
      beard: false,
    },
    ...over,
  });

describe('npc definitions', () => {
  it('fills the defaults an author should not have to type', () => {
    const marla = npc();
    expect(marla.role).toBe('villager');
    // `Idle_Loop`, not `Idle`. The UAL library has no clip called `Idle`, a rig
    // plays nothing at all for a name it does not have, and the four pilot
    // villagers therefore stood in Dawnhaven in a bind-pose T until a
    // screenshot caught it. The default has to be a clip that exists.
    expect(marla.idleClip).toBe('Idle_Loop');
    expect(marla.scale).toBe(1);
    expect(marla.barks).toEqual([]);
  });

  it('refuses ids that are not npc slugs', () => {
    expect(() => npc({ id: 'marla' })).toThrow();
    expect(() => npc({ id: 'enemy_marla' })).toThrow();
  });

  /**
   * A vendor NPC with no shop is the "empty chest" bug in another costume: it
   * passes every schema check and does nothing when you press F.
   */
  it('catches a vendor with no shop, and a shop on a non-vendor', () => {
    expect(validateNpc(npc({ role: 'vendor' })).join(' ')).toContain('needs a vendorId');
    expect(validateNpc(npc({ role: 'vendor', vendorId: 'vendor_dawnhaven_smith' }))).toEqual([]);
    expect(
      validateNpc(npc({ role: 'villager', vendorId: 'vendor_dawnhaven_smith' })).join(' '),
    ).toContain('only vendor NPCs');
  });

  it('warns about a villager who was given a bark cooldown but no lines', () => {
    expect(validateNpc(npc()).join(' ')).toContain('will never speak');
    expect(validateNpc(npc({ barkCooldownSec: 0 }))).toEqual([]);
    expect(validateNpc(npc({ barks: [{ text: 'Mind the bees.' }] }))).toEqual([]);
  });

  it('places one with a thin row — everything else is on the definition', () => {
    const placed = npcPlacementSchema.parse({ id: 'marla_gate', npcId: 'npc_marla', x: 12, z: -4 });
    expect(placed).toEqual({
      id: 'marla_gate',
      npcId: 'npc_marla',
      x: 12,
      z: -4,
      yOffset: 0,
      rotation: 0,
    });
  });
});

describe('the client-authored envelopes', () => {
  it('accepts the shapes the client is allowed to send', () => {
    expect(parseInteractOp({ kind: 'use', objectId: 'chest_shore_1' })).toEqual({
      kind: 'use',
      objectId: 'chest_shore_1',
    });
    expect(
      parseInteractOp({ kind: 'travel', fromId: 'shrine_a', toId: 'shrine_b' }),
    ).not.toBeNull();
    expect(parseQuestOp({ kind: 'dialogue', nodeId: 'hello', choice: 1 })).not.toBeNull();
    expect(parseQuestOp({ kind: 'pin', questId: 'quest_shore_boil_trouble' })).not.toBeNull();
  });

  it('drops anything else rather than trusting it', () => {
    expect(parseInteractOp({ kind: 'use' })).toBeNull();
    expect(parseInteractOp({ kind: 'teleport', objectId: 'x' })).toBeNull();
    // Out-of-range choice index: three buttons is the design maximum (§3).
    expect(parseQuestOp({ kind: 'dialogue', nodeId: 'hello', choice: 7 })).toBeNull();
    expect(parseQuestOp('accept')).toBeNull();
    expect(parseQuestOp({ kind: 'accept', questId: 'q' })).toBeNull();
  });

  it('gives every refusal a line a player can read', () => {
    for (const reason of [
      'too_far',
      'busy',
      'not_attuned',
      'no_gold',
      'emptied',
      'bag_full',
    ] as const) {
      expect(interactRefusalText(reason).length).toBeGreaterThan(3);
    }
    expect(interactRefusalText('unknown')).toBe("That doesn't work.");
  });
});
