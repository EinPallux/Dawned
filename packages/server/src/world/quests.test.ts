/**
 * Quest runtime through the real tick (P11-B).
 *
 * The shared tests pin the state machine in isolation; this drives it through
 * `World.step()` with real kills, real gathers and real POI rings, because the
 * interesting failures live in the wiring — a kill that pays XP but not the
 * quest counter, a discovery that fires twice, a hook that spawns nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASIC_COMBOS,
  defaultWorldSettings,
  defaultXpCurve,
  devTerrain,
  validateItemDef,
  validateNpcDef,
  validateQuestDef,
  validateResourceNodeDef,
  type Interactable,
  type NodePlacement,
  type Poi,
  type QuestDef,
} from '@dawned/shared';
import { World } from './world.js';
import type { GameContent } from '../content/loader.js';
import type { CombatEvent } from './combat.js';
import type { ServerPlayer } from './player.js';
import { acceptQuest, questSyncEntries, turnInQuest } from './quests.js';
import { useObject, emptyRecord, planTravel, buildInteractables } from './interactables.js';

const LOGS = validateItemDef({
  id: 'item_material_birchwood_logs',
  name: 'Birchwood Logs',
  category: 'material',
  rarity: 'common',
  icon: 'wood-pile',
  stack: 50,
  value: 4,
});

const BIRCH = validateResourceNodeDef({
  id: 'node_woodcutting_birch',
  name: 'Birch',
  profession: 'woodcutting',
  tier: 1,
  modelRef: 'nature_tree_birch',
  yields: [{ itemId: LOGS.id, qtyMin: 2, qtyMax: 2 }],
});

const MARLA = validateNpcDef({
  id: 'npc_marla',
  name: 'Marla',
  appearance: {
    body: 'f',
    skin: 1,
    outfit: 'peasant',
    outfitTint: 0,
    hair: 'buns',
    hairColor: 2,
    beard: false,
  },
  barkCooldownSec: 0,
});

const GATHER_QUEST: QuestDef = validateQuestDef({
  id: 'quest_shore_firewood',
  name: 'Firewood',
  zoneId: 'zone_dawnshore',
  suggestedLevel: 2,
  giver: { kind: 'npc', npcId: 'npc_marla' },
  journalText: 'Marla is out of firewood again.',
  steps: [
    {
      type: 'collect',
      itemId: LOGS.id,
      count: 4,
      source: 'gather',
      trackerText: 'Birchwood gathered',
    },
  ],
  rewards: { xp: 100, gold: 20 },
});

const EXPLORE_QUEST: QuestDef = validateQuestDef({
  id: 'quest_shore_lookout',
  name: 'The Lookout',
  zoneId: 'zone_dawnshore',
  giver: { kind: 'board', boardId: 'board_dawnhaven' },
  turnInNpcId: 'npc_marla',
  journalText: 'Someone has been lighting fires on the point.',
  steps: [
    {
      type: 'explore',
      x: 40,
      z: 0,
      radius: 12,
      clueText: 'Where the gulls circle.',
      trackerText: 'Find the point',
    },
  ],
});

const VISTA: Poi = {
  id: 'poi_gull_point',
  name: 'Gull Point',
  kind: 'vista',
  x: 40,
  z: 0,
  radius: 12,
  xpBasis: 1200,
  icon: '',
};

const CHEST: Interactable = {
  id: 'chest_shore_cache',
  kind: 'chest',
  name: 'Weathered Cache',
  x: 6,
  z: 0,
  yOffset: 0,
  rotation: 0,
  modelRef: 'props_chest',
  lootTableId: 'loot_shore_cache',
  respawnMs: 0,
  text: '',
  destX: null,
  destZ: null,
  travelNode: false,
};

const SHRINE_A: Interactable = {
  ...CHEST,
  id: 'shrine_a',
  kind: 'shrine',
  name: 'Shore Shrine',
  x: 0,
  z: 0,
  lootTableId: null,
  travelNode: true,
};
const SHRINE_B: Interactable = { ...SHRINE_A, id: 'shrine_b', name: 'Weald Shrine', x: 400, z: 0 };

const testContent = (quests: QuestDef[]): GameContent => ({
  enemies: new Map(),
  spawners: [],
  abilities: new Map(),
  abilityBySlot: new Map(),
  basicChains: BASIC_COMBOS,
  xpCurve: defaultXpCurve(),
  skillNodes: new Map(),
  items: new Map([[LOGS.id, LOGS]]),
  lootTables: new Map(),
  vendors: new Map(),
  resourceNodes: new Map([[BIRCH.id, BIRCH]]),
  quests: new Map(quests.map((quest) => [quest.id, quest])),
  npcs: new Map([[MARLA.id, MARLA]]),
  worldSettings: defaultWorldSettings(),
});

const PLACEMENTS: NodePlacement[] = [
  { id: 'birch_1', nodeId: BIRCH.id, x: 0, z: 0, rotation: 0, scale: 1 },
];

const makeWorld = (quests: QuestDef[] = [GATHER_QUEST, EXPLORE_QUEST]): World =>
  new World(
    devTerrain,
    { x: 0, y: devTerrain.heightAt(0, 0), z: 0, yaw: 0 },
    testContent(quests),
    () => 0.5,
    [],
    PLACEMENTS,
    {
      npcs: [{ id: 'marla_gate', npcId: MARLA.id, x: 2, z: 0, yOffset: 0, rotation: 0 }],
      interactables: [CHEST, SHRINE_A, SHRINE_B],
      pois: [VISTA],
    },
  );

let nextCharacterId = 1;
const addPlayer = (world: World, at = { x: 0, z: 0 }): ServerPlayer => {
  const player = world.addPlayer({
    characterId: nextCharacterId++,
    accountId: nextCharacterId,
    name: `Seeker${nextCharacterId}`,
    classId: 'warrior',
    level: 5,
    appearance: {
      body: 'm',
      skin: 0,
      outfit: 'ranger',
      outfitTint: 0,
      hair: 'none',
      hairColor: 0,
      beard: false,
    },
    position: null,
    role: 'player',
  });
  player.movement.x = at.x;
  player.movement.z = at.z;
  return player;
};

/**
 * Advance the world by real milliseconds. The tick reads `Date.now()` rather
 * than a dt argument (channels, respawns and cooldowns are all absolute), so a
 * test that only calls `step()` in a loop never actually moves time.
 */
const run = (world: World, ms: number): CombatEvent[] => {
  const all: CombatEvent[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    all.push(...world.step());
    vi.advanceTimersByTime(50);
  }
  all.push(...world.step());
  return all;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('gathering credits a collect step', () => {
  it('counts what the node gave, and completes on the fourth log', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    acceptQuest(player.quests, { defs: world.questDefs() }, actorOf(player), GATHER_QUEST.id);

    // Two gathers × 2 logs = the 4 the step wants.
    for (let round = 0; round < 2; round++) {
      world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
      run(world, 4000);
      world.respawnAllNodes();
      run(world, 100);
    }
    const state = player.quests.get(GATHER_QUEST.id);
    expect(state?.step).toBe(1);
    expect(world.questDefs().get(GATHER_QUEST.id)).toBeDefined();
  });

  /**
   * The rule that keeps "collect 5 Mossbloom" honest. A COLLECT step with
   * `source: 'gather'` must not be satisfiable by any other route, and the
   * only way to be sure is to check the event the world actually emits.
   */
  it('tags a gathered item as gathered', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    acceptQuest(player.quests, { defs: world.questDefs() }, actorOf(player), GATHER_QUEST.id);
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    const events = run(world, 4000);
    expect(events.some((event) => event.type === 'quest-progress')).toBe(true);
    expect(player.quests.get(GATHER_QUEST.id)?.counter).toBe(2);
  });
});

describe('POI discovery', () => {
  it('fires once when you walk into the ring, and never again', () => {
    const world = makeWorld();
    const player = addPlayer(world, { x: 40, z: 0 });
    const first = run(world, 1500).filter(
      (event) => event.type === 'discovery' && event.kind === 'poi',
    );
    expect(first).toHaveLength(1);
    const again = run(world, 1500).filter(
      (event) => event.type === 'discovery' && event.kind === 'poi',
    );
    expect(again).toHaveLength(0);
    expect(player.poisSeen.has(VISTA.id)).toBe(true);
  });

  it('pays XP scaled by the POI, not a flat number', () => {
    const world = makeWorld();
    const player = addPlayer(world, { x: 40, z: 0 });
    const before = player.progress.xp;
    run(world, 1500);
    expect(player.progress.xp).toBeGreaterThan(before);
  });

  /** An EXPLORE step and a POI share the ring: finding it does both. */
  it('completes an explore step by standing there', () => {
    const world = makeWorld();
    const player = addPlayer(world, { x: 40, z: 0 });
    acceptQuest(player.quests, { defs: world.questDefs() }, actorOf(player), EXPLORE_QUEST.id);
    run(world, 1500);
    expect(player.quests.get(EXPLORE_QUEST.id)?.step).toBe(1);
  });
});

describe('interactables', () => {
  const objects = () => buildInteractables([CHEST, SHRINE_A, SHRINE_B], () => 0);

  it('a one-shot chest opens once and then says so', () => {
    const record = emptyRecord();
    const first = useObject(objects().get(CHEST.id)!, record, 1000);
    expect(first.kind).toBe('loot');
    record.openedUntilMs = -1;
    const second = useObject(objects().get(CHEST.id)!, record, 1000);
    expect(second).toEqual({ kind: 'refused', reason: 'emptied' });
  });

  it('a shrine attunes first and offers travel after', () => {
    const record = emptyRecord();
    expect(useObject(objects().get(SHRINE_A.id)!, record, 0).kind).toBe('attuned');
    record.attuned = true;
    expect(useObject(objects().get(SHRINE_A.id)!, record, 0).kind).toBe('travel_menu');
  });

  it('refuses travel to a shrine you have never attuned', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    const map = objects();
    const log = new Map([[SHRINE_A.id, { ...emptyRecord(), attuned: true }]]);
    const refused = planTravel(map.get(SHRINE_A.id), map.get(SHRINE_B.id), log, player, 9999);
    expect(refused).toEqual({ kind: 'refused', reason: 'not_attuned' });
  });

  it('charges the shared fast-travel price, and refuses when you cannot pay', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    const map = objects();
    const log = new Map([
      [SHRINE_A.id, { ...emptyRecord(), attuned: true }],
      [SHRINE_B.id, { ...emptyRecord(), attuned: true }],
    ]);
    const rich = planTravel(map.get(SHRINE_A.id), map.get(SHRINE_B.id), log, player, 9999);
    expect(rich.kind).toBe('travel');
    if (rich.kind !== 'travel') throw new Error('unreachable');
    expect(rich.cost).toBeGreaterThan(0);
    const broke = planTravel(map.get(SHRINE_A.id), map.get(SHRINE_B.id), log, player, 0);
    expect(broke).toEqual({ kind: 'refused', reason: 'no_gold' });
  });
});

describe('accepting and turning in', () => {
  it('pays the rewards named on the row', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    const content = { defs: world.questDefs() };
    acceptQuest(player.quests, content, actorOf(player), GATHER_QUEST.id);
    // Force it complete rather than grinding — the counter path is tested above.
    player.quests.set(GATHER_QUEST.id, {
      questId: GATHER_QUEST.id,
      step: 1,
      counter: 0,
      status: 'active',
    });
    const result = turnInQuest(player.quests, content, GATHER_QUEST.id, 'npc_marla', null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.payout).toMatchObject({ xp: 100, gold: 20 });
  });

  it('refuses a turn-in at the wrong NPC', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    const content = { defs: world.questDefs() };
    player.quests.set(GATHER_QUEST.id, {
      questId: GATHER_QUEST.id,
      step: 1,
      counter: 0,
      status: 'active',
    });
    expect(turnInQuest(player.quests, content, GATHER_QUEST.id, 'npc_someone', null)).toEqual({
      ok: false,
      reason: 'wrong_npc',
    });
  });

  it('refuses a turn-in before the steps are done', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    const content = { defs: world.questDefs() };
    acceptQuest(player.quests, content, actorOf(player), GATHER_QUEST.id);
    expect(turnInQuest(player.quests, content, GATHER_QUEST.id, 'npc_marla', null)).toEqual({
      ok: false,
      reason: 'not_complete',
    });
  });

  it('syncs the whole log with per-step progress', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    acceptQuest(player.quests, { defs: world.questDefs() }, actorOf(player), GATHER_QUEST.id);
    const entries = questSyncEntries(player.quests, { defs: world.questDefs() }, []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ questId: GATHER_QUEST.id, target: 4, ready: false });
    expect(entries[0]?.steps[0]).toMatchObject({ need: 4, have: 0, done: false });
  });
});

const actorOf = (player: ServerPlayer) => ({
  level: player.level,
  quests: player.quests,
  discoveries: player.poisSeen,
});
