/**
 * Client-authored quest and interaction intents (v14, `ClientOp.InteractOp`
 * and `ClientOp.QuestOp`).
 *
 * The third and fourth JSON envelopes the client may author, and they get the
 * same treatment as the first two: a zod gate at the boundary, because these
 * carry ids rather than being fixed-width binary the codec bounds by
 * construction (item-ops.ts has the long version of the argument).
 *
 * Every one of these is a REQUEST. Nothing about a quest is predicted — not the
 * accept, not the counter, not the reward — because a quest's state is the one
 * thing a player would most like to author themselves, and the next `QuestSync`
 * is always the answer. That is the same rule items shipped under at P8.
 */

import { z } from 'zod';

/** A placement id from the baked map, or an npc id. */
const worldRef = z.string().min(1).max(80);
const questRef = z.string().min(3).max(64);

export const interactOpSchema = z.discriminatedUnion('kind', [
  /**
   * Press `F` on something. The server decides what that MEANS from the
   * object's kind — open the chest, attune the shrine, read the sign, start
   * the conversation — because the client knowing the verb would mean the
   * client choosing the verb.
   */
  z.object({ kind: z.literal('use'), objectId: worldRef }).strict(),
  /**
   * Take a shrine hop. Separate from `use` because attuning and travelling are
   * different acts at the same object, and the second one charges gold.
   */
  z
    .object({
      kind: z.literal('travel'),
      /** The shrine being travelled FROM (proximity-checked). */
      fromId: worldRef,
      /** The attuned shrine being travelled TO. */
      toId: worldRef,
    })
    .strict(),
  /** Close whatever panel the last interaction opened. */
  z.object({ kind: z.literal('close') }).strict(),
]);
export type InteractOp = z.infer<typeof interactOpSchema>;

export const questOpSchema = z.discriminatedUnion('kind', [
  /**
   * Press a dialogue button. The index is into the node the SERVER last sent —
   * it re-checks that the node is still the open one, so a stale click from a
   * conversation that moved on is refused rather than applied to whatever
   * happens to be at that index now.
   */
  z
    .object({
      kind: z.literal('dialogue'),
      /** The node id the client believes it is answering. */
      nodeId: z.string().min(1).max(48),
      choice: z.number().int().min(0).max(2),
    })
    .strict(),
  /** Accept from a board or an item-started quest — no conversation involved. */
  z.object({ kind: z.literal('accept'), questId: questRef }).strict(),
  /** Give up on one. The quest returns to its giver rather than vanishing. */
  z.object({ kind: z.literal('abandon'), questId: questRef }).strict(),
  /** Tracker pinning — up to 3, the server enforces the cap (§4). */
  z.object({ kind: z.literal('pin'), questId: questRef }).strict(),
  z.object({ kind: z.literal('unpin'), questId: questRef }).strict(),
  /**
   * Choose one of a chain-end reward's per-class options. Sent WITH the
   * turn-in rather than after it, so there is never a window where the quest
   * is closed and the reward is still owed.
   */
  z
    .object({
      kind: z.literal('choose_reward'),
      questId: questRef,
      itemId: z.string().min(3).max(64),
    })
    .strict(),
]);
export type QuestOp = z.infer<typeof questOpSchema>;

/** Parse an op off the wire. `null` = malformed; the caller drops it. */
export const parseInteractOp = (raw: unknown): InteractOp | null => {
  const parsed = interactOpSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const parseQuestOp = (raw: unknown): QuestOp | null => {
  const parsed = questOpSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/**
 * Why an accept, a turn-in or a delivery was refused.
 *
 * Shared for the same reason the interaction refusals below are: the server
 * NAMES the reason and the client SPEAKS it, so a refusal the player cannot
 * read is impossible by construction. (This started life in the server's
 * `world/quests.ts`, which meant the one place the string had to be readable —
 * the HUD — could not reach it.)
 */
export const QUEST_REFUSALS = {
  Unknown: 'unknown_quest',
  NotAvailable: 'not_available',
  AlreadyHeld: 'already_held',
  NotComplete: 'not_complete',
  WrongNpc: 'wrong_npc',
  TooFar: 'too_far',
  BagFull: 'bag_full',
  MissingItems: 'missing_items',
} as const;
export type QuestRefusal = (typeof QUEST_REFUSALS)[keyof typeof QUEST_REFUSALS];

export const questRefusalText = (reason: string): string => {
  switch (reason) {
    case 'unknown_quest':
      return 'That quest is gone.';
    case 'not_available':
      return 'Not yet.';
    case 'already_held':
      return 'You already have that.';
    case 'not_complete':
      return "You haven't finished it.";
    case 'wrong_npc':
      return "That's not who asked.";
    case 'too_far':
      return 'Too far away.';
    case 'bag_full':
      return 'Your pack is too full for the reward.';
    case 'missing_items':
      return "You don't have what they asked for.";
    default:
      return 'No.';
  }
};

/**
 * Why an interaction was refused. Shared so the HUD line and the server's
 * reason are the same string — a refusal the player cannot read is the bug
 * P10's gather refusals were fixed for.
 */
export const INTERACT_REFUSALS = {
  TooFar: 'too_far',
  Busy: 'busy',
  NotAttuned: 'not_attuned',
  NoGold: 'no_gold',
  Emptied: 'emptied',
  BagFull: 'bag_full',
  Unknown: 'unknown',
} as const;
export type InteractRefusal = (typeof INTERACT_REFUSALS)[keyof typeof INTERACT_REFUSALS];

export const interactRefusalText = (reason: InteractRefusal): string => {
  switch (reason) {
    case 'too_far':
      return 'Too far away.';
    case 'busy':
      return 'You are busy.';
    case 'not_attuned':
      return 'You have not attuned to that shrine.';
    case 'no_gold':
      return "You can't afford the passage.";
    case 'emptied':
      return 'Already emptied.';
    case 'bag_full':
      return 'Your pack is full.';
    default:
      return "That doesn't work.";
  }
};
