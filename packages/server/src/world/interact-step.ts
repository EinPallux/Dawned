/**
 * The interaction step (P11-B): what one tick does with the `InteractOp` and
 * `QuestOp` envelopes players sent.
 *
 * Split out of `world.ts` because it is a self-contained state machine over
 * one player — press F, resolve what the object is, maybe open a conversation,
 * walk the conversation, hand a quest over — and folding another six hundred
 * lines into the tick file would have made the tick itself unreadable.
 *
 * Everything here is a REQUEST resolution. The client asked; this decides, and
 * the `QuestSync`/`DialogueState`/`InteractState` that follow are the answer.
 */

import {
  INTERACT_REFUSALS,
  questTurnInNpc,
  type InteractOp,
  type InteractRefusal,
  type QuestActor,
  type QuestDef,
  type QuestOp,
  type DialogueNode,
} from '@dawned/shared';
import type { ServerPlayer, OpenDialogue } from './player.js';
import {
  chestCooldownUntil,
  emptyRecord,
  planTravel,
  useObject,
  withinInteractRange,
  type InteractionRecord,
  type PlacedInteractable,
  type ServerNpc,
} from './interactables.js';
import {
  abandonQuest,
  acceptQuest,
  boardQuestOffers,
  npcQuestOffers,
  pinQuest,
  turnInQuest,
  unpinQuest,
  type QuestContent,
} from './quests.js';

/** What the world has to hand this step. */
export interface InteractWorld {
  objects: ReadonlyMap<string, PlacedInteractable>;
  npcs: ReadonlyMap<string, ServerNpc>;
  content: QuestContent;
  nowMs: number;
}

/** What the step decided — the world turns these into events and messages. */
export interface InteractEffects {
  /** Roll this loot table into the player's bag. */
  loot: { lootTableId: string; objectId: string }[];
  /** Move the player here (portal, shrine hop). */
  teleport: { x: number; z: number } | null;
  /** Charge this much gold (shrine hop). */
  spendGold: number;
  /** Pay these out (quest turn-in). */
  payouts: {
    questId: string;
    xp: number;
    gold: number;
    items: { itemId: string; qty: number }[];
    title: string;
  }[];
  /** HUD lines: refusals, signpost text, "Discovered". */
  notices: { objectId: string; text: string; kind: string }[];
  /** Quest ids whose state changed — the caller resyncs and persists. */
  questsDirty: string[];
  /** Object ids whose per-character record changed — persist these. */
  objectsDirty: string[];
  /** The dialogue panel changed (opened, advanced, closed). */
  dialogueDirty: boolean;
  /** Quest beats worth a toast. */
  notices2: { kind: string; questId: string; text: string }[];
  /**
   * The NPC this interaction talked to, if any. The world turns it into a
   * `talk` quest event — which is how a TALK step counts and how a DELIVER
   * step is handed over, once the world has checked the pack.
   */
  talkedTo: string | null;
}

export const emptyEffects = (): InteractEffects => ({
  loot: [],
  teleport: null,
  spendGold: 0,
  payouts: [],
  notices: [],
  questsDirty: [],
  objectsDirty: [],
  dialogueDirty: false,
  notices2: [],
  talkedTo: null,
});

const refuse = (effects: InteractEffects, objectId: string, reason: InteractRefusal): void => {
  effects.notices.push({ objectId, text: reason, kind: 'refused' });
};

const recordFor = (player: ServerPlayer, objectId: string): InteractionRecord => {
  const existing = player.interactions.get(objectId);
  if (existing) return existing;
  const fresh = emptyRecord();
  player.interactions.set(objectId, fresh);
  return fresh;
};

export const actorOf = (player: ServerPlayer): QuestActor => ({
  level: player.level,
  quests: player.quests,
  discoveries: player.poisSeen,
});

/**
 * Press `F` on something.
 *
 * The verb comes from the OBJECT, never from the client (see `useObject`), and
 * an NPC is handled separately because talking is a conversation rather than a
 * one-shot effect.
 */
export const applyInteract = (
  player: ServerPlayer,
  op: InteractOp,
  world: InteractWorld,
  gold: number,
  effects: InteractEffects,
): void => {
  if (op.kind === 'close') {
    if (player.dialogue) {
      player.dialogue = null;
      effects.dialogueDirty = true;
    }
    return;
  }

  if (op.kind === 'travel') {
    const from = world.objects.get(op.fromId);
    const to = world.objects.get(op.toId);
    const plan = planTravel(from, to, player.interactions, player, gold);
    if (plan.kind === 'refused') {
      refuse(effects, op.fromId, plan.reason);
      return;
    }
    effects.spendGold += plan.cost;
    effects.teleport = { x: plan.x, z: plan.z };
    effects.notices.push({ objectId: op.toId, text: 'travelled', kind: 'travelled' });
    return;
  }

  // `use` — an NPC first, since a villager and a chest can share an id space.
  const npc = world.npcs.get(op.objectId);
  if (npc) {
    if (!withinInteractRange(npc, player)) {
      refuse(effects, op.objectId, INTERACT_REFUSALS.TooFar);
      return;
    }
    // Walking up to someone IS the talk, whatever the conversation turns out
    // to be. A TALK step that only counted when a quest happened to open a
    // panel would be satisfiable by one NPC and not by another.
    effects.talkedTo = npc.npcId;
    openNpcDialogue(player, npc, world, effects);
    return;
  }

  const object = world.objects.get(op.objectId);
  if (!object) {
    refuse(effects, op.objectId, INTERACT_REFUSALS.Unknown);
    return;
  }
  if (!withinInteractRange(object.row, player)) {
    refuse(effects, op.objectId, INTERACT_REFUSALS.TooFar);
    return;
  }

  // A quest board is an object that offers quests rather than doing something.
  const boardOffers = boardQuestOffers(world.content, actorOf(player), object.row.id);
  if (object.row.kind === 'quest_prop' && boardOffers.length > 0) {
    openBoard(player, object.row.id, boardOffers, effects);
    return;
  }

  const record = recordFor(player, object.row.id);
  const result = useObject(object, record, world.nowMs);
  switch (result.kind) {
    case 'refused':
      refuse(effects, object.row.id, result.reason);
      return;
    case 'loot':
      record.openedUntilMs = chestCooldownUntil(object.row, world.nowMs);
      effects.loot.push({ lootTableId: result.lootTableId, objectId: result.objectId });
      effects.objectsDirty.push(object.row.id);
      break;
    case 'attuned':
      record.attuned = true;
      effects.objectsDirty.push(object.row.id);
      effects.notices.push({ objectId: object.row.id, text: object.row.name, kind: 'attuned' });
      break;
    case 'travel_menu':
      effects.notices.push({ objectId: object.row.id, text: object.row.name, kind: 'travel_menu' });
      break;
    case 'rest':
      effects.notices.push({ objectId: object.row.id, text: object.row.name, kind: 'rest' });
      break;
    case 'read':
      effects.notices.push({ objectId: object.row.id, text: result.text, kind: 'read' });
      break;
    case 'teleport':
      effects.teleport = { x: result.x, z: result.z };
      break;
    case 'touch':
      break;
    default:
      break;
  }
  // Every successful interaction is quest fodder — an INTERACT step counts the
  // touch whatever the object also did, which is what lets "inspect 4 stumps"
  // be four signposts, four props, or four chests without a special kind.
  record.uses += 1;
  effects.objectsDirty.push(object.row.id);
  effects.notices.push({ objectId: object.row.id, text: '', kind: 'interacted' });
};

/**
 * Open a conversation with an NPC.
 *
 * Priority is turn-in → in-progress → offer (see `npcQuestOffers`). Walking up
 * to someone you owe a finished quest and being handed a new one first is the
 * most annoying thing a quest NPC can do, so it cannot happen here.
 */
const openNpcDialogue = (
  player: ServerPlayer,
  npc: ServerNpc,
  world: InteractWorld,
  effects: InteractEffects,
): void => {
  const offers = npcQuestOffers(world.content, actorOf(player), npc.npcId);
  const first = offers[0];
  if (!first) {
    // Nothing quest-shaped to say. A vendor opens their shop; anyone else says
    // a bark, which is cheaper than a conversation with one "Goodbye" button.
    effects.notices.push({
      objectId: npc.id,
      text: npc.def.role === 'vendor' ? (npc.def.vendorId ?? '') : pickBark(npc),
      kind: npc.def.role === 'vendor' ? 'vendor' : 'bark',
    });
    return;
  }
  const phase =
    first.kind === 'complete' ? 'complete' : first.kind === 'offer' ? 'offer' : 'inProgress';
  const nodes = first.quest.dialogue[phase];
  const node = nodes[0];
  if (!node) {
    // A quest with no lines for this phase still has to be usable: an offer
    // with no dialogue is accepted directly, a completion with none is handed
    // in directly. Content should have lines, but a missing conversation must
    // not be a dead end.
    if (phase === 'offer') {
      const accepted = acceptQuest(player.quests, world.content, actorOf(player), first.quest.id);
      if (accepted.ok) {
        effects.questsDirty.push(first.quest.id);
        effects.notices2.push({
          kind: 'accepted',
          questId: first.quest.id,
          text: first.quest.name,
        });
      }
    } else if (phase === 'complete') {
      finishQuest(player, first.quest, npc.npcId, null, world, effects);
    }
    return;
  }
  player.dialogue = {
    questId: first.quest.id,
    phase,
    nodeId: node.id,
    npcPlacementId: npc.id,
    npcId: npc.npcId,
  };
  effects.dialogueDirty = true;
};

const pickBark = (npc: ServerNpc): string => {
  if (npc.def.barks.length === 0) return '';
  // Deterministic per placement rather than random: a villager who says a
  // different line every single press reads as a slot machine, not a person.
  const index = npc.id.length % npc.def.barks.length;
  return npc.def.barks[index]?.text ?? '';
};

/**
 * A board posting is a SYNTHETIC dialogue node.
 *
 * §7 wants a parchment list you accept from without an NPC, and the protocol
 * already carries a conversation — so a board reuses it with a node id no
 * authored quest can collide with, the posting's own journal prose as the text,
 * and two fixed buttons. The id and the buttons live HERE, next to the code
 * that resolves a press, and the gateway imports them: a board that was built
 * with one node id and resolved against another would be a posting you can read
 * and cannot take, which is exactly what shipped before this comment existed.
 */
export const BOARD_NODE_ID = '__board__';
export const BOARD_CHOICES: { text: string; action: string }[] = [
  { text: 'Take the job.', action: 'accept' },
  { text: 'Leave it.', action: 'decline' },
];

/** A board is a list, not a conversation — accept straight off the parchment. */
const openBoard = (
  player: ServerPlayer,
  boardId: string,
  offers: QuestDef[],
  effects: InteractEffects,
): void => {
  player.dialogue = {
    questId: offers[0]?.id ?? '',
    phase: 'offer',
    nodeId: BOARD_NODE_ID,
    npcPlacementId: boardId,
    npcId: '',
  };
  effects.dialogueDirty = true;
};

/** Walk one step of the open conversation. */
export const applyQuestOp = (
  player: ServerPlayer,
  op: QuestOp,
  world: InteractWorld,
  effects: InteractEffects,
): void => {
  switch (op.kind) {
    case 'pin':
      player.pinnedQuests = pinQuest(player.quests, player.pinnedQuests, op.questId);
      effects.questsDirty.push(op.questId);
      return;
    case 'unpin':
      player.pinnedQuests = unpinQuest(player.pinnedQuests, op.questId);
      effects.questsDirty.push(op.questId);
      return;
    case 'abandon':
      if (abandonQuest(player.quests, op.questId)) {
        player.pinnedQuests = unpinQuest(player.pinnedQuests, op.questId);
        effects.questsDirty.push(op.questId);
        effects.notices2.push({ kind: 'abandoned', questId: op.questId, text: '' });
      }
      return;
    case 'accept': {
      // Board/item accepts. The gate check is the shared one, so a quest the
      // journal is hiding cannot be taken by a client that sends its id anyway.
      const result = acceptQuest(player.quests, world.content, actorOf(player), op.questId);
      if (!result.ok) {
        effects.notices2.push({ kind: 'refused', questId: op.questId, text: result.reason });
        return;
      }
      effects.questsDirty.push(op.questId);
      const def = world.content.defs.get(op.questId);
      effects.notices2.push({ kind: 'accepted', questId: op.questId, text: def?.name ?? '' });
      return;
    }
    case 'choose_reward':
      // Remembered until the turn-in lands, so there is never a window where
      // the quest is closed and the reward is still owed.
      player.pendingRewardChoice = { questId: op.questId, itemId: op.itemId };
      return;
    case 'dialogue':
      applyDialogueChoice(player, op.nodeId, op.choice, world, effects);
      return;
    default:
      return;
  }
};

/**
 * A dialogue button was pressed.
 *
 * The `nodeId` the client sends must match the node the server has open. A
 * stale click — the player pressed twice, or the conversation moved on — is
 * DROPPED rather than applied to whatever is at that index now, which is the
 * difference between a double-press being harmless and it accepting a quest
 * you never read.
 */
const applyDialogueChoice = (
  player: ServerPlayer,
  nodeId: string,
  choiceIndex: number,
  world: InteractWorld,
  effects: InteractEffects,
): void => {
  const open = player.dialogue;
  if (!open || open.nodeId !== nodeId) return;
  const npc = world.npcs.get(open.npcPlacementId);
  // Walking away closes the conversation, and so does a choice pressed from
  // out of range — otherwise a dialogue is a remote control for an NPC.
  if (npc && !withinInteractRange(npc, player)) {
    player.dialogue = null;
    effects.dialogueDirty = true;
    return;
  }
  const quest = world.content.defs.get(open.questId);
  if (!quest) {
    player.dialogue = null;
    effects.dialogueDirty = true;
    return;
  }
  const node = findNode(quest, open, nodeId);
  const choice = node?.choices[choiceIndex];
  if (!choice) return;

  switch (choice.action) {
    case 'accept': {
      const result = acceptQuest(player.quests, world.content, actorOf(player), quest.id);
      if (result.ok) {
        effects.questsDirty.push(quest.id);
        effects.notices2.push({ kind: 'accepted', questId: quest.id, text: quest.name });
      } else {
        effects.notices2.push({ kind: 'refused', questId: quest.id, text: result.reason });
      }
      player.dialogue = null;
      effects.dialogueDirty = true;
      return;
    }
    case 'turn_in':
      finishQuest(
        player,
        quest,
        open.npcId,
        player.pendingRewardChoice?.itemId ?? null,
        world,
        effects,
      );
      player.dialogue = null;
      effects.dialogueDirty = true;
      return;
    case 'goto': {
      const next = findNode(quest, open, choice.goto);
      if (!next) {
        player.dialogue = null;
      } else {
        player.dialogue = { ...open, nodeId: next.id };
      }
      effects.dialogueDirty = true;
      return;
    }
    case 'decline':
    case 'close':
    default:
      player.dialogue = null;
      effects.dialogueDirty = true;
      return;
  }
};

const findNode = (
  quest: QuestDef,
  open: OpenDialogue,
  nodeId: string,
): DialogueNode | undefined => {
  // A board posting has no authored node — it IS the synthetic one, so resolve
  // it here rather than falling through to "the first offer line", which for a
  // board quest is usually nothing at all.
  if (nodeId === BOARD_NODE_ID) {
    return {
      id: BOARD_NODE_ID,
      npcId: '',
      text: quest.journalText,
      emote: '',
      choices: BOARD_CHOICES.map((choice) => ({
        text: choice.text,
        action: choice.action as DialogueNode['choices'][number]['action'],
        goto: '',
      })),
    };
  }
  const all = [...quest.dialogue.offer, ...quest.dialogue.inProgress, ...quest.dialogue.complete];
  return all.find((node) => node.id === nodeId) ?? quest.dialogue[open.phase][0];
};

/** Hand a quest in and record what it owes. */
const finishQuest = (
  player: ServerPlayer,
  quest: QuestDef,
  atNpcId: string,
  chosenItem: string | null,
  world: InteractWorld,
  effects: InteractEffects,
): void => {
  const result = turnInQuest(player.quests, world.content, quest.id, atNpcId, chosenItem);
  if (!result.ok) {
    effects.notices2.push({ kind: 'refused', questId: quest.id, text: result.reason });
    return;
  }
  player.pinnedQuests = unpinQuest(player.pinnedQuests, quest.id);
  player.pendingRewardChoice = null;
  effects.questsDirty.push(quest.id);
  effects.payouts.push({ questId: quest.id, ...result.payout });
  effects.notices2.push({ kind: 'rewarded', questId: quest.id, text: quest.name });
};

/** The NPC a quest must be handed to, for the range check. */
export const turnInNpcOf = questTurnInNpc;
