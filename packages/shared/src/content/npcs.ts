/**
 * Friendly NPC content — `content_npcs` (QUESTS_POI.md §3, NPCS_ENEMIES.md).
 *
 * The same definition/placement split enemies and resource nodes use: this row
 * says who Marla IS (her rig, her voice, what she sells, what she mutters when
 * you walk past), and a thin placement in the map bake says where she stands.
 * One definition can therefore be re-placed, and moving her is a map publish
 * rather than a content publish.
 *
 * NPCs are NOT enemies with a friendly flag. They have no combat state, no
 * threat, no leash — they idle, they talk, and they emote. Sharing the enemy
 * pipeline would have meant carrying an AI brain and a health bar around
 * Dawnhaven for forty villagers, which is the sort of thing that quietly eats a
 * 1-core VPS.
 */

import { z } from 'zod';
import { WORLD_SIZE_M } from '../world/map.js';
import { appearanceSchema } from '../api/requests.js';
import { npcSlug } from './quests.js';

const worldX = z.number().min(-WORLD_SIZE_M).max(WORLD_SIZE_M);

/**
 * A proximity one-liner (§3: "cheap life"). Text bubbles on a cooldown, never
 * a conversation — walking past should feel inhabited without opening a UI.
 */
export const npcBarkSchema = z
  .object({
    text: z.string().min(1).max(120),
    /** Optional UAL clip played with it. */
    emote: z.string().max(48).default(''),
  })
  .strict();
export type NpcBark = z.infer<typeof npcBarkSchema>;

/** What an NPC's `F` does when they have nothing quest-shaped to say. */
export const NPC_ROLES = ['villager', 'vendor', 'quest_giver', 'guard', 'trainer'] as const;
export type NpcRole = (typeof NPC_ROLES)[number];

export const npcDefSchema = z
  .object({
    id: npcSlug,
    name: z.string().min(1).max(48),
    /** Shown under the name on the nameplate — "Dawnhaven gate farmer". */
    title: z.string().max(64).default(''),
    role: z.enum(NPC_ROLES).default('villager'),
    /**
     * NPCs wear the PLAYER appearance, not a `modelRef`.
     *
     * A character in this game is composed — base body + outfit + hair, one
     * skeleton — so pointing an NPC at a single baked mesh would stand a
     * floating tunic in Dawnhaven. Reusing the composition the client already
     * runs for players means every villager gets the UAL clip library for free
     * (idle, talking, gestures), which is exactly what a quest giver needs and
     * exactly what the enemy pipeline does NOT have.
     */
    appearance: appearanceSchema,
    /**
     * Idle clip. `Idle_Loop` is the UAL library's name for standing still —
     * NOT `Idle`, which is what this defaulted to at P11-A and is the reason
     * the first four villagers stood in Dawnhaven in a bind-pose T. The rig
     * plays nothing at all for a clip it does not have, so a wrong name here is
     * silent everywhere except on screen.
     */
    idleClip: z.string().min(1).max(48).default('Idle_Loop'),
    talkClip: z.string().max(48).default(''),
    /** `vendor` role: which published vendor row their `F` opens. */
    vendorId: z.string().max(64).nullable().default(null),
    /** Ambient one-liners, picked at random on a cooldown. */
    barks: z.array(npcBarkSchema).max(8).default([]),
    /** Seconds between barks for one listener. 0 = never bark. */
    barkCooldownSec: z.number().int().min(0).max(600).default(45),
    /** Uniform scale — a child villager, a tall smith. */
    scale: z.number().min(0.5).max(2).default(1),
  })
  .strict();
export type NpcDef = z.infer<typeof npcDefSchema>;

export const validateNpcDef = (row: unknown): NpcDef => npcDefSchema.parse(row);

/**
 * Where one NPC stands. Thin, like a resource-node placement: everything about
 * WHO they are is on the definition, so a village of ten villagers costs the
 * bake ten short rows.
 */
export const npcPlacementSchema = z
  .object({
    id: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'ids are snake_case slugs'),
    npcId: npcSlug,
    x: worldX,
    z: worldX,
    /** Lift off the sampled ground (a shopkeeper on a step). */
    yOffset: z.number().min(-20).max(60).default(0),
    /** Which way they face, radians. */
    rotation: z.number().default(0),
  })
  .strict();
export type NpcPlacement = z.infer<typeof npcPlacementSchema>;

/** Per-role rules the flat schema cannot express. Returns problems, [] = ok. */
export const validateNpc = (npc: NpcDef): string[] => {
  const problems: string[] = [];
  if (npc.role === 'vendor' && !npc.vendorId) {
    problems.push(`${npc.id}: a vendor NPC needs a vendorId (an empty shop is a bug, not content)`);
  }
  if (npc.role !== 'vendor' && npc.vendorId) {
    problems.push(`${npc.id}: only vendor NPCs open a shop`);
  }
  if (npc.barkCooldownSec > 0 && npc.barks.length === 0 && npc.role === 'villager') {
    // Not fatal — a silent villager is still scenery — but it is almost always
    // an author who meant to write lines and did not, so it is worth saying.
    problems.push(`${npc.id}: has a bark cooldown but no barks (they will never speak)`);
  }
  return problems;
};
