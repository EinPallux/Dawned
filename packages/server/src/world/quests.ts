/**
 * Quest runtime (P11, docs/design/QUESTS_POI.md).
 *
 * The server owns every quest's state and is the only thing that may change it.
 * What lives HERE is the plumbing — one character's quest log, the fan-out that
 * offers a world event to every quest that might care, and the reward payout —
 * while the rules about what an event MEANS live in `@dawned/shared`'s
 * `formulas/quests.ts`, so the panel's preview and this cannot disagree.
 *
 * The shape worth explaining is the fan-out. Every kill, every item, every
 * interact is offered to each of the player's active quests, and the
 * overwhelmingly common answer is "not relevant". That is deliberately the
 * cheap path: a player holds at most a handful of quests, each with one active
 * step, so an event costs a handful of switch statements rather than an index
 * that has to be kept correct as quests are accepted and abandoned.
 */

import {
  advanceQuest,
  currentStep,
  questAvailability,
  questComplete,
  questTurnInNpc,
  startQuest,
  stepTarget,
  type QuestActor,
  type QuestDef,
  type QuestEvent,
  type QuestHook,
  type QuestState,
  type QuestStep,
} from '@dawned/shared';

/** One character's whole quest log, keyed by quest id. */
export type QuestLog = Map<string, QuestState>;

/** Pinned-to-the-tracker quest ids, in the order the player pinned them. */
export const MAX_PINNED = 3;

export interface QuestContent {
  defs: ReadonlyMap<string, QuestDef>;
}

/** What the world did, and what the quest system decided about it. */
export interface QuestOutcome {
  /** Quests whose counter moved — the tracker bumps. */
  touched: string[];
  /** Steps that completed, with the quest they belong to (hooks fire per step). */
  stepsCompleted: { questId: string; step: QuestStep }[];
  /** Quests that became turn-in-able this tick. */
  completed: string[];
  /** Every hook the completed steps asked for, in order. */
  hooks: QuestHook[];
}

const emptyOutcome = (): QuestOutcome => ({
  touched: [],
  stepsCompleted: [],
  completed: [],
  hooks: [],
});

/**
 * Offer one world event to every active quest a character holds.
 *
 * Mutates the log in place and reports what changed. Order is the log's
 * iteration order, which is insertion order — two quests wanting the same kill
 * both get it, because sharing an objective between quests is a feature (§5's
 * "kill-and-collect overlap keeps it one trip"), not a conflict to resolve.
 *
 * `skip` exists for one case and is worth naming: a DELIVER step is credited by
 * a `talk` at the named NPC, and whether the player is actually carrying the
 * goods is the server's business (shared cannot see an inventory). So the
 * caller checks the stack, refuses the ones that come up short, and passes
 * those quest ids here — otherwise the very same talk would advance the step it
 * just refused, and you could hand Bran five mossbloom you do not have.
 */
export const applyQuestEvent = (
  log: QuestLog,
  content: QuestContent,
  event: QuestEvent,
  skip: ReadonlySet<string> = new Set(),
): QuestOutcome => {
  const outcome = emptyOutcome();
  for (const [questId, state] of log) {
    if (state.status !== 'active' || skip.has(questId)) continue;
    const def = content.defs.get(questId);
    if (!def) continue;
    const advance = advanceQuest(def, state, event);
    if (!advance.changed) continue;
    log.set(questId, advance.state);
    outcome.touched.push(questId);
    for (const step of advance.stepsCompleted) {
      outcome.stepsCompleted.push({ questId, step });
      outcome.hooks.push(...step.hooks);
    }
    if (advance.completed) outcome.completed.push(questId);
  }
  return outcome;
};

/** Why an accept/turn-in was refused, so the HUD can say something true. */
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

export const questRefusalText = (reason: QuestRefusal): string => {
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

export type QuestAcceptResult =
  { ok: true; state: QuestState } | { ok: false; reason: QuestRefusal };

/**
 * Take a quest. The gate check is the SHARED one, so a quest the panel says is
 * hidden cannot be accepted by a client that sends its id anyway — which is
 * exactly the attack a discovery-gated quest invites (§5).
 */
export const acceptQuest = (
  log: QuestLog,
  content: QuestContent,
  actor: QuestActor,
  questId: string,
): QuestAcceptResult => {
  const def = content.defs.get(questId);
  if (!def) return { ok: false, reason: QUEST_REFUSALS.Unknown };
  const availability = questAvailability(def, actor);
  if (availability === 'active' || availability === 'ready') {
    return { ok: false, reason: QUEST_REFUSALS.AlreadyHeld };
  }
  if (availability !== 'available') return { ok: false, reason: QUEST_REFUSALS.NotAvailable };
  const state = startQuest(def);
  log.set(questId, state);
  return { ok: true, state };
};

/** What a turn-in owes the player once the server has agreed to it. */
export interface QuestPayout {
  xp: number;
  gold: number;
  items: { itemId: string; qty: number }[];
  title: string;
}

export type QuestTurnInResult =
  { ok: true; payout: QuestPayout; state: QuestState } | { ok: false; reason: QuestRefusal };

/**
 * Hand a quest in.
 *
 * `chosenItem` is the per-class reward pick, sent WITH the turn-in rather than
 * after it so there is never a window where the quest is closed and the reward
 * is still owed. An invalid pick is ignored rather than refused — the quest is
 * finished either way, and refusing at this point would strand the player.
 */
export const turnInQuest = (
  log: QuestLog,
  content: QuestContent,
  questId: string,
  atNpcId: string | null,
  chosenItem: string | null,
): QuestTurnInResult => {
  const def = content.defs.get(questId);
  if (!def) return { ok: false, reason: QUEST_REFUSALS.Unknown };
  const state = log.get(questId);
  if (!state || state.status === 'turned_in') {
    return { ok: false, reason: QUEST_REFUSALS.Unknown };
  }
  if (!questComplete(def, state)) return { ok: false, reason: QUEST_REFUSALS.NotComplete };
  const expected = questTurnInNpc(def);
  // A quest with no NPC turn-in closes wherever it was finished (a found-object
  // quest whose last step IS the discovery). One that names an NPC must be
  // closed at that NPC — the caller has already range-checked them.
  if (expected && atNpcId !== expected) return { ok: false, reason: QUEST_REFUSALS.WrongNpc };

  const items = def.rewards.items.map((entry) => ({ ...entry }));
  if (def.rewards.choices.length > 0) {
    const pick =
      def.rewards.choices.find((choice) => choice.itemId === chosenItem) ?? def.rewards.choices[0];
    if (pick) items.push({ itemId: pick.itemId, qty: pick.qty });
  }
  const next: QuestState = { ...state, status: 'turned_in' };
  log.set(questId, next);
  return {
    ok: true,
    state: next,
    payout: { xp: def.rewards.xp, gold: def.rewards.gold, items, title: def.rewards.title },
  };
};

/** Drop a quest. It goes back to its giver rather than out of the world. */
export const abandonQuest = (log: QuestLog, questId: string): boolean => {
  const state = log.get(questId);
  if (!state || state.status !== 'active') return false;
  log.set(questId, { ...state, step: 0, counter: 0, status: 'abandoned' });
  return true;
};

/**
 * Which quests this NPC has to say something about, and in what state.
 *
 * The order is the priority the conversation uses: a turn-in beats an offer,
 * because walking up to someone you owe a finished quest and being offered a
 * new one first is the single most annoying thing a quest NPC can do.
 */
export interface NpcQuestOffer {
  quest: QuestDef;
  kind: 'complete' | 'in_progress' | 'offer';
}

export const npcQuestOffers = (
  content: QuestContent,
  actor: QuestActor,
  npcId: string,
): NpcQuestOffer[] => {
  const complete: NpcQuestOffer[] = [];
  const inProgress: NpcQuestOffer[] = [];
  const offers: NpcQuestOffer[] = [];
  for (const quest of content.defs.values()) {
    const availability = questAvailability(quest, actor);
    const turnIn = questTurnInNpc(quest);
    if (availability === 'ready' && turnIn === npcId) {
      complete.push({ quest, kind: 'complete' });
      continue;
    }
    if (availability === 'active' && turnIn === npcId) {
      inProgress.push({ quest, kind: 'in_progress' });
      continue;
    }
    if (availability === 'available' && quest.giver.kind === 'npc' && quest.giver.npcId === npcId) {
      offers.push({ quest, kind: 'offer' });
    }
  }
  return [...complete, ...inProgress, ...offers];
};

/** The quests a board is holding out right now (§7). */
export const boardQuestOffers = (
  content: QuestContent,
  actor: QuestActor,
  boardId: string,
): QuestDef[] => {
  const offers: QuestDef[] = [];
  for (const quest of content.defs.values()) {
    if (quest.giver.kind !== 'board' || quest.giver.boardId !== boardId) continue;
    if (questAvailability(quest, actor) !== 'available') continue;
    offers.push(quest);
  }
  return offers;
};

/**
 * Pin a quest to the tracker, evicting the oldest when full.
 *
 * Silently evicting rather than refusing is the right call for a 3-slot
 * tracker: someone pinning a fourth quest wants to see it, and making them
 * unpin something first is a modal problem for a convenience feature.
 */
export const pinQuest = (log: QuestLog, pinned: string[], questId: string): string[] => {
  const state = log.get(questId);
  if (!state || state.status !== 'active') return pinned;
  if (pinned.includes(questId)) return pinned;
  const next = [...pinned, questId];
  return next.length > MAX_PINNED ? next.slice(next.length - MAX_PINNED) : next;
};

export const unpinQuest = (pinned: string[], questId: string): string[] =>
  pinned.filter((id) => id !== questId);

/** The wire shape of one quest in `QuestSync`. */
export interface QuestSyncEntry {
  questId: string;
  name: string;
  zoneId: string;
  status: QuestState['status'];
  step: number;
  counter: number;
  /** How many the CURRENT step needs; 0 once the quest is done. */
  target: number;
  pinned: boolean;
  /** Where the current step's hint circle is, if it has one. */
  hint: { x: number; z: number; radius: number } | null;
  journalText: string;
  steps: { text: string; have: number; need: number; done: boolean; type: string }[];
  rewards: QuestDef['rewards'];
  suggestedLevel: number;
  chainId: string;
  trackable: boolean;
  /** True once every step is behind you — the journal shows "Return to…". */
  ready: boolean;
  turnInNpcId: string | null;
}

/** Build the whole log for the wire. The client never derives quest state. */
export const questSyncEntries = (
  log: QuestLog,
  content: QuestContent,
  pinned: readonly string[],
): QuestSyncEntry[] => {
  const entries: QuestSyncEntry[] = [];
  for (const [questId, state] of log) {
    // An abandoned quest is not in the journal — it is back on its giver.
    if (state.status === 'abandoned') continue;
    const def = content.defs.get(questId);
    if (!def) continue;
    const step = currentStep(def, state);
    entries.push({
      questId,
      name: def.name,
      zoneId: def.zoneId,
      status: state.status,
      step: state.step,
      counter: state.counter,
      target: step ? stepTarget(step) : 0,
      pinned: pinned.includes(questId),
      hint: step && def.trackable ? (step.type === 'explore' ? null : (step.hint ?? null)) : null,
      journalText: def.journalText,
      steps: def.steps.map((entry, index) => ({
        text: entry.trackerText,
        have: index < state.step ? stepTarget(entry) : index === state.step ? state.counter : 0,
        need: stepTarget(entry),
        done: index < state.step,
        type: entry.type,
      })),
      rewards: def.rewards,
      suggestedLevel: def.suggestedLevel,
      chainId: def.chainId,
      trackable: def.trackable,
      ready: questComplete(def, state),
      turnInNpcId: questTurnInNpc(def),
    });
  }
  return entries;
};

/**
 * The clue text of an active EXPLORE step, which is all the player gets — no
 * marker, by design (§1 rule 4). Exposed separately because the tracker shows
 * it in place of a counter.
 */
export const exploreClue = (def: QuestDef, state: QuestState): string | null => {
  const step = currentStep(def, state);
  return step && step.type === 'explore' ? step.clueText : null;
};
