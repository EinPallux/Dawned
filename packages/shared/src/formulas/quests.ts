/**
 * Quest state — availability, counters, completion (QUESTS_POI.md §2, P11-A).
 *
 * This is the anti-drift layer for quests. The SERVER owns quest state and is
 * the only thing that may change it, but the panel's quest editor previews a
 * quest's flow and the client renders its tracker, and all three have to agree
 * about what "step 2 is done" means. So the rules live here, once, as pure
 * functions over (definition, state, event) — the same argument that put
 * `selectableEnemyAbilities` and `rollGather` in shared.
 *
 * Nothing here reads the world. A step is advanced by an EVENT the caller
 * already resolved ("this kill was enemy_bog_blob, tagged blob_bog"), which is
 * what lets the panel replay a fabricated event list to preview a quest and the
 * server feed it real ones.
 */

import { QUEST_STEP_TYPES, stepTarget, type QuestDef, type QuestStep } from '../content/quests.js';

/** Where a character stands on one quest. */
export interface QuestState {
  questId: string;
  /** 0-based index into `steps`. Equal to `steps.length` once every step is done. */
  step: number;
  /** Progress on the CURRENT step only — steps are ordered and one at a time. */
  counter: number;
  status: QuestStatus;
}

export const QUEST_STATUSES = ['active', 'complete', 'turned_in', 'abandoned'] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];

/**
 * What the player can do with a quest right now. `hidden` and `locked` are
 * different on purpose: a level gate is worth telling someone about ("comes
 * back at 8"), a discovery gate is not — a quest you have not found the POI for
 * must be invisible, or the gate advertises exactly what it is hiding (§5).
 */
export const QUEST_AVAILABILITIES = [
  'hidden',
  'locked',
  'available',
  'active',
  'ready',
  'done',
] as const;
export type QuestAvailability = (typeof QUEST_AVAILABILITIES)[number];

/** What the caller knows about a character, for gate checks. */
export interface QuestActor {
  level: number;
  /** Quest id → its state. Missing = never accepted. */
  quests: ReadonlyMap<string, QuestState>;
  /** POI/zone ids already discovered. */
  discoveries: ReadonlySet<string>;
}

/**
 * The one place that decides what a quest looks like to a character.
 *
 * Order matters and is deliberate: a quest already taken reports its own state
 * before any gate is consulted, because prerequisites describe how you GET a
 * quest, not whether you may finish one you already hold. Re-checking them
 * would abandon a chain quest the moment a later patch raised its level gate.
 */
export const questAvailability = (quest: QuestDef, actor: QuestActor): QuestAvailability => {
  const state = actor.quests.get(quest.id);
  if (state) {
    if (state.status === 'turned_in') return quest.repeatable ? 'available' : 'done';
    if (state.status === 'active') return questComplete(quest, state) ? 'ready' : 'active';
    if (state.status === 'complete') return 'ready';
    // 'abandoned' falls through to the gates: dropping a quest puts it back on
    // the giver rather than deleting it from the world.
  }
  for (const discoveryId of quest.prerequisites.discoveryIds) {
    if (!actor.discoveries.has(discoveryId)) return 'hidden';
  }
  for (const questId of quest.prerequisites.questIds) {
    const prior = actor.quests.get(questId);
    if (!prior || prior.status !== 'turned_in') return 'hidden';
  }
  if (actor.level < quest.prerequisites.level) return 'locked';
  return 'available';
};

/** Fresh state for a quest just accepted. */
export const startQuest = (quest: QuestDef): QuestState => ({
  questId: quest.id,
  step: 0,
  counter: 0,
  status: 'active',
});

/** True once every step is behind us. */
export const questComplete = (quest: QuestDef, state: QuestState): boolean =>
  state.step >= quest.steps.length;

/** The step being worked on, or null when the quest is ready to hand in. */
export const currentStep = (quest: QuestDef, state: QuestState): QuestStep | null =>
  quest.steps[state.step] ?? null;

/**
 * Something happened in the world. The caller has already resolved it into
 * these terms — the shape is flat rather than a union per type because a single
 * event often satisfies two step kinds at once (picking a herb is both a
 * `gather` and an `item` arriving), and a union would force the caller to guess
 * which one the active quest cares about.
 */
export interface QuestEvent {
  kind: 'kill' | 'item' | 'talk' | 'interact' | 'enter' | 'use';
  /** enemy id / item id / npc id / object id — whatever `kind` implies. */
  refId?: string;
  /** Enemy campTag or object tag, when the thing carries one. */
  tag?: string;
  /** How many (a kill is 1; an item stack can be more). */
  qty?: number;
  /** Where it happened — EXPLORE and USE_AT are the only steps that care. */
  x?: number;
  z?: number;
  /** For `item`: how it was obtained, checked against a COLLECT step's source. */
  source?: 'drops' | 'gather' | 'world' | 'any';
}

/**
 * Does this event count towards this step, and for how much?
 *
 * Returns 0 for "not relevant", which is the overwhelmingly common answer —
 * every kill in the world is offered to every active quest.
 */
export const eventCredit = (step: QuestStep, event: QuestEvent): number => {
  const qty = Math.max(1, Math.floor(event.qty ?? 1));
  switch (step.type) {
    case 'kill':
      if (event.kind !== 'kill') return 0;
      if (step.enemyId) return event.refId === step.enemyId ? qty : 0;
      if (step.enemyTag) return event.tag === step.enemyTag ? qty : 0;
      return 0;
    case 'collect':
      if (event.kind !== 'item' || event.refId !== step.itemId) return 0;
      // `any` accepts every route; a specific source rejects the others, which
      // is what stops "collect 5 Mossbloom" being solved at a vendor.
      if (step.source !== 'any' && event.source !== step.source) return 0;
      return qty;
    case 'deliver':
      // Delivery is an act, not an acquisition: it completes when the player
      // hands the stack over at the named NPC, so a `talk` at that NPC is the
      // event and the inventory check is the server's business.
      return event.kind === 'talk' && event.refId === step.npcId ? 1 : 0;
    case 'talk':
      return event.kind === 'talk' && event.refId === step.npcId ? 1 : 0;
    case 'explore':
      if (event.kind !== 'enter') return 0;
      return withinRadius(event, step.x, step.z, step.radius) ? 1 : 0;
    case 'interact':
      if (event.kind !== 'interact') return 0;
      if (step.objectId) return event.refId === step.objectId ? 1 : 0;
      if (step.objectTag) return event.tag === step.objectTag ? qty : 0;
      return 0;
    case 'use_at':
      if (event.kind !== 'use' || event.refId !== step.itemId) return 0;
      return withinRadius(event, step.x, step.z, step.radius) ? 1 : 0;
    default:
      return 0;
  }
};

const withinRadius = (event: QuestEvent, x: number, z: number, radius: number): boolean => {
  if (event.x === undefined || event.z === undefined) return false;
  const dx = event.x - x;
  const dz = event.z - z;
  return dx * dx + dz * dz <= radius * radius;
};

/** What one event did to one quest — the caller turns this into messages. */
export interface QuestAdvance {
  state: QuestState;
  /** True when the counter moved (tracker bump, tick sound). */
  changed: boolean;
  /** Steps finished by this event, in order — each fires its hooks. */
  stepsCompleted: QuestStep[];
  /** True when the last step fell and the quest became turn-in-able. */
  completed: boolean;
}

/**
 * Apply one event to one quest.
 *
 * A single event can close SEVERAL steps: an `interact` that finishes step 2
 * can immediately satisfy a step 3 that wants the same thing, and a player who
 * already carries the collect items should not have to drop and re-pick them.
 * So this cascades until the event stops crediting — but only ever forward, and
 * never past the end.
 */
export const advanceQuest = (
  quest: QuestDef,
  state: QuestState,
  event: QuestEvent,
): QuestAdvance => {
  const result: QuestAdvance = {
    state,
    changed: false,
    stepsCompleted: [],
    completed: false,
  };
  if (state.status !== 'active') return result;

  let step = state.step;
  let counter = state.counter;
  for (;;) {
    const active = quest.steps[step];
    if (!active) break;
    const credit = eventCredit(active, event);
    if (credit <= 0) break;
    counter += credit;
    result.changed = true;
    if (counter < stepTarget(active)) break;
    result.stepsCompleted.push(active);
    step += 1;
    counter = 0;
  }

  if (!result.changed) return result;
  result.state = {
    ...state,
    step,
    counter: Math.min(counter, step < quest.steps.length ? stepTarget(quest.steps[step]!) : 0),
  };
  result.completed = step >= quest.steps.length;
  return result;
};

/**
 * Suggested XP for a quest at a level — the ƒ-button in the editor's rewards
 * builder (§1 rule 5: "every reward is worth the walk").
 *
 * Anchored to the progression curve rather than invented: a quest is worth
 * about a fifth of the level it is suggested for, so a three-step quest at
 * level 3 pays roughly what clearing a camp does, and the number keeps its
 * meaning when the curve is retuned.
 */
export const suggestedQuestXp = (
  suggestedLevel: number,
  steps: number,
  xpToNext: (level: number) => number,
): number => {
  const level = Math.min(30, Math.max(1, Math.round(suggestedLevel)));
  const span = Math.min(6, Math.max(1, Math.round(steps)));
  const share = 0.12 + 0.04 * span;
  return Math.round((xpToNext(level) * share) / 5) * 5;
};

/**
 * Suggested gold, on the same principle (ITEMS_LOOT §5's economy): a quest pays
 * about as much as selling what a trip's worth of trash drops.
 */
export const suggestedQuestGold = (suggestedLevel: number, steps: number): number => {
  const level = Math.min(30, Math.max(1, Math.round(suggestedLevel)));
  const span = Math.min(6, Math.max(1, Math.round(steps)));
  return Math.round((8 + level * 4) * (0.6 + 0.25 * span));
};

/** Progress for one active quest, ready to render. */
export interface QuestProgressLine {
  index: number;
  type: QuestStep['type'];
  text: string;
  have: number;
  need: number;
  done: boolean;
}

/**
 * The tracker/journal view of a quest: every step, with the ones behind you
 * shown as done. Rendering the WHOLE list rather than just the current step is
 * what makes a three-step quest read as a small story instead of a single
 * changing line.
 */
export const questProgress = (quest: QuestDef, state: QuestState): QuestProgressLine[] =>
  quest.steps.map((step, index) => ({
    index,
    type: step.type,
    text: step.trackerText,
    have: index < state.step ? stepTarget(step) : index === state.step ? state.counter : 0,
    need: stepTarget(step),
    done: index < state.step,
  }));

/** What a hint circle actually covers. `null` targets mean "nothing placed". */
export interface QuestHintCoverage {
  /** Metres from the circle's centre to the nearest target. */
  nearestM: number;
  /** True when at least one target stands inside the circle. */
  covered: boolean;
  /** How much larger the radius would have to be to reach the nearest one. */
  shortfallM: number;
  /** How many of the targets the circle contains. */
  inside: number;
}

/**
 * Does a step's hint circle contain the thing the step is about?
 *
 * A hint is the ONLY pointer the world map gives for a kill, collect, interact
 * or deliver step, and it is authored by hand in the quest editor while the
 * thing it points at is placed in a different editor — spawners in the enemies
 * page, props and nodes on the map. Nothing ever compared the two, and the P11
 * pilot set shipped with FOUR kill circles 85–170 m from their only spawner:
 * you could open the map, walk to the ring, and find empty ground.
 *
 * It lives in shared rather than in the panel for the usual reason — the panel
 * warns with it at publish time, and anything in the game that ever wants to
 * ask the same question (a "your hint is stale" GM check, a map-bake gate) has
 * to get the same answer. Pure geometry: the CALLER resolves what the targets
 * are, because that resolution needs published content the formula cannot see.
 */
export const questHintCoverage = (
  hint: { readonly x: number; readonly z: number; readonly radius: number },
  targets: readonly { readonly x: number; readonly z: number }[],
): QuestHintCoverage | null => {
  if (targets.length === 0) return null;
  let nearestM = Number.POSITIVE_INFINITY;
  let inside = 0;
  for (const target of targets) {
    const distance = Math.hypot(target.x - hint.x, target.z - hint.z);
    if (distance < nearestM) nearestM = distance;
    if (distance <= hint.radius) inside++;
  }
  return {
    nearestM,
    covered: inside > 0,
    shortfallM: Math.max(0, nearestM - hint.radius),
    inside,
  };
};

/** Every step type — re-exported so consumers need one import. */
export { QUEST_STEP_TYPES };
