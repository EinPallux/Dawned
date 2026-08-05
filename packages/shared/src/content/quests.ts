/**
 * Quest content — `content_quests` (QUESTS_POI.md, DATABASE.md §3). The
 * authoring half of P11.
 *
 * A quest is one row: who gives it, what gates it, an ordered list of steps,
 * what it pays, and the found-voice prose the journal shows. Dialogue lives on
 * the row too rather than in its own table — a quest's lines are only ever read
 * by that quest, and splitting them would buy a join and cost the editor the
 * ability to show the whole thing on one page.
 *
 * The STEP is the interesting shape. Seven types, discriminated on `type`, each
 * carrying only the fields it can actually use — so a KILL step has no itemId to
 * leave dangling and the panel gets a natural card per type without a
 * hand-written form. Everything a step shares (tracker text, the map hint, the
 * on-complete hooks) lives in `stepCommon` and is spread into each member.
 *
 * Nothing in here decides whether a step is DONE — that is `formulas/quests.ts`,
 * which the server runs and the panel previews with, for the same reason the
 * TTK simulator runs the game's own ability selection.
 */

import { z } from 'zod';

/** `quest_<zone>_<name>` — readable in a journal, a log line and the editor. */
export const questSlug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^quest_[a-z0-9_]+$/, 'quest ids look like quest_<zone>_<name>');

/** `npc_<name>` — friendly NPCs (givers, turn-ins, delivery targets). */
export const npcSlug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^npc_[a-z0-9_]+$/, 'npc ids look like npc_<name>');

const itemRef = z
  .string()
  .min(3)
  .max(64)
  .regex(/^item_[a-z0-9_]+$/, 'item references look like item_<...>');

const enemyRef = z
  .string()
  .min(3)
  .max(64)
  .regex(/^enemy_[a-z0-9_]+$/, 'enemy references look like enemy_<...>');

/** A placed thing in the map bake: an interactable, a POI or a board. */
const placementRef = z.string().min(1).max(64);

/**
 * The whitelisted scripting hooks (§8). Deliberately tiny and deliberately a
 * closed union: "no arbitrary scripting language in 0.1.0" is enforced by the
 * schema rather than by everyone remembering it, and every hook is a dropdown
 * in the editor because a designer should never type a function name.
 */
export const questHookSchema = z.discriminatedUnion('hook', [
  z
    .object({
      hook: z.literal('spawnGroup'),
      /** A spawner id from the map's spawn layer — the ambush behind step 2. */
      spawnerId: placementRef,
    })
    .strict(),
  z
    .object({
      hook: z.literal('despawn'),
      /** Every enemy carrying this campTag leaves. */
      tag: z.string().min(1).max(48),
    })
    .strict(),
  z
    .object({
      hook: z.literal('playEmote'),
      npcId: npcSlug,
      /** A UAL clip the NPC's baked rig owns; publish checks it. */
      clip: z.string().min(1).max(48),
    })
    .strict(),
  z
    .object({
      hook: z.literal('toast'),
      text: z.string().min(1).max(160),
    })
    .strict(),
  z
    .object({
      hook: z.literal('grantBuff'),
      /** An ability/effect id the buff comes from. */
      effectId: z.string().min(1).max(64),
      durationMs: z.number().int().min(1000).max(3_600_000).default(60_000),
    })
    .strict(),
]);
export type QuestHook = z.infer<typeof questHookSchema>;

/**
 * A map hint (§1 rule 4): "the map hints ROUGHLY where (circle region, not an
 * X)". A circle, never a point, and nullable because an EXPLORE step is not
 * allowed one at all — clue text only.
 */
export const hintCircleSchema = z
  .object({
    x: z.number().min(-4096).max(4096),
    z: z.number().min(-4096).max(4096),
    radius: z.number().min(8).max(400).default(60),
  })
  .strict();
export type HintCircle = z.infer<typeof hintCircleSchema>;

/** What every step carries whatever its type. */
const stepCommon = {
  /** The tracker line, e.g. "Bog Blobs slain". Counters render after it. */
  trackerText: z.string().min(1).max(120),
  /** Roughly-where, or null for "the world will tell you". */
  hint: hintCircleSchema.nullable().default(null),
  /** Fired once, server-side, when this step completes. */
  hooks: z.array(questHookSchema).max(4).default([]),
} as const;

/**
 * Where a COLLECT step's items may legally come from. This is not flavour: it
 * is what stops "collect 5 Mossbloom" being solved at a vendor. `gather` means
 * a resource node only, `drops` means a kill, `world` means a placed prop.
 */
export const collectSourceSchema = z.enum(['drops', 'gather', 'world', 'any']);
export type CollectSource = z.infer<typeof collectSourceSchema>;

export const questStepSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...stepCommon,
      type: z.literal('kill'),
      /** Either a specific enemy… */
      enemyId: enemyRef.nullable().default(null),
      /** …or anything wearing this tag (a camp, a family). One of the two. */
      enemyTag: z.string().max(48).nullable().default(null),
      count: z.number().int().min(1).max(999).default(1),
    })
    .strict(),
  z
    .object({
      ...stepCommon,
      type: z.literal('collect'),
      itemId: itemRef,
      count: z.number().int().min(1).max(999).default(1),
      source: collectSourceSchema.default('any'),
    })
    .strict(),
  z
    .object({
      ...stepCommon,
      type: z.literal('deliver'),
      itemId: itemRef,
      count: z.number().int().min(1).max(99).default(1),
      npcId: npcSlug,
    })
    .strict(),
  z
    .object({
      ...stepCommon,
      type: z.literal('talk'),
      npcId: npcSlug,
    })
    .strict(),
  z
    .object({
      ...stepCommon,
      type: z.literal('explore'),
      /** The region that satisfies it — never drawn on the map (§1 rule 4). */
      x: z.number().min(-4096).max(4096),
      z: z.number().min(-4096).max(4096),
      radius: z.number().min(8).max(400).default(40),
      /** What the player has to go on instead of a marker. */
      clueText: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      ...stepCommon,
      type: z.literal('interact'),
      /** A specific placed object… */
      objectId: placementRef.nullable().default(null),
      /** …or any of the four marked stumps, by tag. */
      objectTag: z.string().max(48).nullable().default(null),
      count: z.number().int().min(1).max(99).default(1),
    })
    .strict(),
  z
    .object({
      ...stepCommon,
      type: z.literal('use_at'),
      itemId: itemRef,
      x: z.number().min(-4096).max(4096),
      z: z.number().min(-4096).max(4096),
      radius: z.number().min(4).max(200).default(15),
    })
    .strict(),
]);
export type QuestStep = z.infer<typeof questStepSchema>;
export type QuestStepType = QuestStep['type'];

/** Every step type, for editor dropdowns and exhaustiveness in tests. */
export const QUEST_STEP_TYPES = [
  'kill',
  'collect',
  'deliver',
  'talk',
  'explore',
  'interact',
  'use_at',
] as const satisfies readonly QuestStepType[];

/**
 * How a step counts. A step whose target is 1 renders as a checkbox rather than
 * "0/1", which is why this is derived rather than stored — one fewer field to
 * get out of step with `count`.
 */
export const stepTarget = (step: QuestStep): number => ('count' in step ? step.count : 1);

/**
 * Who hands the quest over. Objects and boards matter: §1 rule 2 wants ~30 % of
 * quests to start from a note on a corpse or a board, not from an NPC with a
 * glyph over their head.
 */
export const questGiverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npc'), npcId: npcSlug }).strict(),
  z.object({ kind: z.literal('object'), objectId: placementRef }).strict(),
  z.object({ kind: z.literal('board'), boardId: placementRef }).strict(),
  /**
   * A quest that starts when an ITEM lands in your bag — "Message in a Bottle"
   * is a fishing proc. There is nothing in the world to walk up to, which is
   * the point.
   */
  z.object({ kind: z.literal('item'), itemId: itemRef }).strict(),
]);
export type QuestGiver = z.infer<typeof questGiverSchema>;

/** What must already be true before the quest is even visible. */
export const questPrerequisitesSchema = z
  .object({
    level: z.number().int().min(1).max(30).default(1),
    /** Every one of these must be COMPLETE (chain links). */
    questIds: z.array(questSlug).max(8).default([]),
    /**
     * Discovery-gated (§5): the quest does not exist until the POI is found.
     * Three quests in 0.1.0 use this — "rewards for the curious".
     */
    discoveryIds: z.array(placementRef).max(4).default([]),
  })
  .strict();
export type QuestPrerequisites = z.infer<typeof questPrerequisitesSchema>;

/** One class's version of a chain-end weapon choice. */
export const rewardChoiceSchema = z
  .object({
    classId: z.enum(['warrior', 'rogue', 'mage', 'cleric']),
    itemId: itemRef,
    qty: z.number().int().min(1).max(99).default(1),
  })
  .strict();

export const questRewardsSchema = z
  .object({
    /** Flat XP. `suggestedQuestXp` is the ƒ-button behind it in the editor. */
    xp: z.number().int().min(0).max(100_000).default(0),
    gold: z.number().int().min(0).max(100_000).default(0),
    /** Handed to everyone who turns it in. */
    items: z
      .array(
        z.object({ itemId: itemRef, qty: z.number().int().min(1).max(99).default(1) }).strict(),
      )
      .max(6)
      .default([]),
    /** Pick-one-per-class (chain ends). Empty = no choice offered. */
    choices: z.array(rewardChoiceSchema).max(4).default([]),
    /** Cosmetic title, e.g. "Friend of the Weald". */
    title: z.string().max(48).default(''),
  })
  .strict();
export type QuestRewards = z.infer<typeof questRewardsSchema>;

/**
 * One dialogue beat. `choices` is 1–3 buttons; a choice either advances the
 * conversation, accepts the quest, or closes it. There is deliberately no
 * branching STATE in 0.1.0 (§3) — a flavour question is a detour that returns,
 * not a fork the save file has to remember.
 */
export const dialogueChoiceSchema = z
  .object({
    text: z.string().min(1).max(80),
    /** What pressing it does. `goto` jumps within this quest's node list. */
    action: z.enum(['accept', 'decline', 'goto', 'close', 'turn_in']),
    /** Node id for `goto`; ignored otherwise. */
    goto: z.string().max(48).default(''),
  })
  .strict();

export const dialogueNodeSchema = z
  .object({
    id: z.string().min(1).max(48),
    /** Whoever is talking — the camera frames them. */
    npcId: npcSlug.nullable().default(null),
    /** §3: typewriter text, lint at 220 chars in the editor. */
    text: z.string().min(1).max(400),
    /** A UAL clip played while the line is on screen. */
    emote: z.string().max(48).default(''),
    choices: z.array(dialogueChoiceSchema).min(1).max(3),
  })
  .strict();
export type DialogueNode = z.infer<typeof dialogueNodeSchema>;

/** The three conversations a quest can own. */
export const questDialogueSchema = z
  .object({
    /** Shown when you walk up before accepting. Must contain an `accept`. */
    offer: z.array(dialogueNodeSchema).max(6).default([]),
    /** Shown when you come back with it unfinished. */
    inProgress: z.array(dialogueNodeSchema).max(4).default([]),
    /** Shown at turn-in. Must contain a `turn_in`. */
    complete: z.array(dialogueNodeSchema).max(6).default([]),
  })
  .strict();
export type QuestDialogue = z.infer<typeof questDialogueSchema>;

export const questDefSchema = z
  .object({
    id: questSlug,
    name: z.string().min(1).max(64),
    /** Which zone's journal section it files under. */
    zoneId: z.string().min(1).max(64),
    suggestedLevel: z.number().int().min(1).max(30).default(1),
    giver: questGiverSchema,
    /** Who closes it. Defaults to the giver when the giver is an NPC. */
    turnInNpcId: npcSlug.nullable().default(null),
    prerequisites: questPrerequisitesSchema.prefault({}),
    /** 0.1.0 ships no repeatables; the field exists so the system supports them. */
    repeatable: z.boolean().default(false),
    /**
     * Chain membership — purely for the journal's grouping and the editor's
     * graph. The ORDER is enforced by `prerequisites.questIds`, not by this.
     */
    chainId: z.string().max(64).default(''),
    steps: z.array(questStepSchema).min(1).max(6),
    rewards: questRewardsSchema.prefault({}),
    dialogue: questDialogueSchema.prefault({}),
    /** Found-voice prose (§4): "Marla swears the bees weren't this big…". */
    journalText: z.string().min(1).max(600),
    /** Per-quest opt-out of tracking (§1 rule 4). */
    trackable: z.boolean().default(true),
  })
  .strict();
export type QuestDef = z.infer<typeof questDefSchema>;

export const validateQuestDef = (row: unknown): QuestDef => questDefSchema.parse(row);

/**
 * Rules the flat schema cannot express. Returns problems, `[]` = ok — the same
 * shape `validateInteractable` uses, so publish can concatenate them.
 *
 * These are the ones that make a quest silently unfinishable rather than
 * invalid: a KILL step naming neither an enemy nor a tag counts nothing
 * forever, an NPC-given quest with no turn-in has no way to end, and an offer
 * conversation with no `accept` button cannot be taken at all.
 */
export const validateQuestFlow = (quest: QuestDef): string[] => {
  const problems: string[] = [];
  quest.steps.forEach((step, index) => {
    const where = `${quest.id} step ${index + 1}`;
    if (step.type === 'kill' && !step.enemyId && !step.enemyTag) {
      problems.push(`${where}: a kill step needs an enemyId or an enemyTag, or it counts nothing`);
    }
    if (step.type === 'kill' && step.enemyId && step.enemyTag) {
      problems.push(`${where}: a kill step takes an enemyId OR an enemyTag, not both`);
    }
    if (step.type === 'interact' && !step.objectId && !step.objectTag) {
      problems.push(`${where}: an interact step needs an objectId or an objectTag`);
    }
    if (step.type === 'explore' && step.hint) {
      problems.push(`${where}: explore steps are never marked on the map (QUESTS_POI §1.4)`);
    }
  });
  const turnIn = questTurnInNpc(quest);
  if (!turnIn && quest.dialogue.complete.length > 0) {
    problems.push(`${quest.id}: has turn-in dialogue but nobody to turn it in to`);
  }
  if (quest.giver.kind === 'npc' && !turnIn) {
    problems.push(`${quest.id}: an NPC-given quest needs a turn-in NPC (it cannot be closed)`);
  }
  if (quest.dialogue.offer.length > 0 && !hasChoice(quest.dialogue.offer, 'accept')) {
    problems.push(
      `${quest.id}: the offer conversation has no [Accept] — the quest cannot be taken`,
    );
  }
  if (quest.dialogue.complete.length > 0 && !hasChoice(quest.dialogue.complete, 'turn_in')) {
    problems.push(`${quest.id}: the completion conversation has no turn-in button`);
  }
  for (const node of [
    ...quest.dialogue.offer,
    ...quest.dialogue.inProgress,
    ...quest.dialogue.complete,
  ]) {
    for (const choice of node.choices) {
      if (choice.action !== 'goto') continue;
      const target = quest.dialogue.offer
        .concat(quest.dialogue.inProgress, quest.dialogue.complete)
        .some((candidate) => candidate.id === choice.goto);
      if (!target) {
        problems.push(
          `${quest.id}: dialogue "${node.id}" jumps to "${choice.goto}", which does not exist`,
        );
      }
    }
  }
  if (quest.prerequisites.questIds.includes(quest.id)) {
    problems.push(`${quest.id}: requires itself`);
  }
  return problems;
};

const hasChoice = (nodes: readonly DialogueNode[], action: string): boolean =>
  nodes.some((node) => node.choices.some((choice) => choice.action === action));

/**
 * Who actually closes the quest. An NPC giver turns it in to themselves unless
 * the row says otherwise, which is the common case and saves the author a
 * field; an object/board/item giver must name one.
 */
export const questTurnInNpc = (quest: QuestDef): string | null => {
  if (quest.turnInNpcId) return quest.turnInNpcId;
  return quest.giver.kind === 'npc' ? quest.giver.npcId : null;
};
