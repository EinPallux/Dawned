/**
 * The quest state machine (P11-A). This is the anti-drift layer: the server
 * advances quests with it, the panel previews flows with it, and the client
 * renders the tracker from it, so the interesting cases are the ones where a
 * naive implementation would quietly disagree with itself.
 */

import { describe, expect, it } from 'vitest';
import { validateQuestDef, validateQuestFlow, type QuestDef } from '../content/quests.js';
import {
  advanceQuest,
  currentStep,
  eventCredit,
  questAvailability,
  questComplete,
  questHintCoverage,
  questProgress,
  startQuest,
  suggestedQuestGold,
  suggestedQuestXp,
  type QuestActor,
  type QuestState,
} from './quests.js';

const quest = (over: Partial<Record<string, unknown>> = {}): QuestDef =>
  validateQuestDef({
    id: 'quest_shore_boil_trouble',
    name: 'Boil Trouble',
    zoneId: 'zone_dawnshore',
    suggestedLevel: 3,
    giver: { kind: 'npc', npcId: 'npc_marla' },
    journalText: "Marla's fence posts are dissolving.",
    steps: [
      {
        type: 'kill',
        enemyId: 'enemy_bog_blob',
        count: 8,
        trackerText: 'Bog Blobs slain',
      },
      {
        type: 'collect',
        itemId: 'item_material_unpopped_boil',
        count: 3,
        source: 'drops',
        trackerText: 'Unpopped Boils',
      },
    ],
    ...over,
  });

const actor = (over: Partial<QuestActor> = {}): QuestActor => ({
  level: 10,
  quests: new Map(),
  discoveries: new Set(),
  ...over,
});

const held = (state: QuestState): QuestActor =>
  actor({ quests: new Map([[state.questId, state]]) });

describe('availability gates', () => {
  it('is available with nothing in the way', () => {
    expect(questAvailability(quest(), actor())).toBe('available');
  });

  it('locks on level but stays visible — a level gate is worth telling you about', () => {
    const gated = quest({ prerequisites: { level: 12 } });
    expect(questAvailability(gated, actor({ level: 5 }))).toBe('locked');
  });

  /**
   * The distinction that matters: a discovery gate must HIDE, because a locked
   * entry saying "find the Elder Grove hermit first" advertises exactly the
   * secret it is protecting (§5).
   */
  it('hides — not locks — behind an undiscovered POI', () => {
    const gated = quest({ prerequisites: { discoveryIds: ['poi_elder_grove'] } });
    expect(questAvailability(gated, actor())).toBe('hidden');
    expect(questAvailability(gated, actor({ discoveries: new Set(['poi_elder_grove']) }))).toBe(
      'available',
    );
  });

  it('hides until every prior link of the chain is turned in', () => {
    const link = quest({ prerequisites: { questIds: ['quest_weald_silence_1'] } });
    const done = new Map<string, QuestState>([
      [
        'quest_weald_silence_1',
        { questId: 'quest_weald_silence_1', step: 1, counter: 0, status: 'turned_in' },
      ],
    ]);
    const merely = new Map<string, QuestState>([
      [
        'quest_weald_silence_1',
        { questId: 'quest_weald_silence_1', step: 1, counter: 0, status: 'complete' },
      ],
    ]);
    expect(questAvailability(link, actor({ quests: merely }))).toBe('hidden');
    expect(questAvailability(link, actor({ quests: done }))).toBe('available');
  });

  /**
   * Gates describe how you GET a quest, not whether you may finish one you
   * already hold. Re-checking them would abandon a chain quest the moment a
   * later patch raised its level gate — a live-content footgun.
   */
  it('does not re-gate a quest already accepted', () => {
    const gated = quest({ prerequisites: { level: 25 } });
    const state = startQuest(gated);
    expect(questAvailability(gated, { ...held(state), level: 3 })).toBe('active');
  });

  it('reports ready once the steps are done, and done after turn-in', () => {
    const q = quest();
    expect(
      questAvailability(q, held({ questId: q.id, step: 2, counter: 0, status: 'active' })),
    ).toBe('ready');
    expect(
      questAvailability(q, held({ questId: q.id, step: 2, counter: 0, status: 'turned_in' })),
    ).toBe('done');
  });

  it('puts an abandoned quest back on its giver rather than deleting it', () => {
    const q = quest();
    expect(
      questAvailability(q, held({ questId: q.id, step: 1, counter: 4, status: 'abandoned' })),
    ).toBe('available');
  });
});

describe('crediting events to steps', () => {
  const killStep = quest().steps[0]!;
  const collectStep = quest().steps[1]!;

  it('credits the named enemy and nothing else', () => {
    expect(eventCredit(killStep, { kind: 'kill', refId: 'enemy_bog_blob' })).toBe(1);
    expect(eventCredit(killStep, { kind: 'kill', refId: 'enemy_mushnub' })).toBe(0);
    expect(eventCredit(killStep, { kind: 'item', refId: 'enemy_bog_blob' })).toBe(0);
  });

  it('credits by tag when the step names a tag', () => {
    const tagged = validateQuestDef({
      ...quest(),
      steps: [{ type: 'kill', enemyTag: 'blob_bog', count: 5, trackerText: 'Bog cleared' }],
    }).steps[0]!;
    expect(eventCredit(tagged, { kind: 'kill', refId: 'enemy_bog_blob', tag: 'blob_bog' })).toBe(1);
    expect(eventCredit(tagged, { kind: 'kill', refId: 'enemy_bog_blob', tag: 'weald' })).toBe(0);
  });

  /**
   * The rule that stops "collect 5 Mossbloom" being solved at a vendor. It is
   * the whole reason a COLLECT step carries a source at all.
   */
  it('refuses an item that arrived by the wrong route', () => {
    expect(
      eventCredit(collectStep, {
        kind: 'item',
        refId: 'item_material_unpopped_boil',
        source: 'drops',
      }),
    ).toBe(1);
    expect(
      eventCredit(collectStep, {
        kind: 'item',
        refId: 'item_material_unpopped_boil',
        source: 'gather',
      }),
    ).toBe(0);
  });

  it('takes a whole stack at once', () => {
    expect(
      eventCredit(collectStep, {
        kind: 'item',
        refId: 'item_material_unpopped_boil',
        source: 'drops',
        qty: 3,
      }),
    ).toBe(3);
  });

  it('credits an explore step only inside its circle', () => {
    const step = validateQuestDef({
      ...quest(),
      steps: [
        {
          type: 'explore',
          x: 100,
          z: 50,
          radius: 20,
          clueText: 'Where the road ends.',
          trackerText: 'Find it',
        },
      ],
    }).steps[0]!;
    expect(eventCredit(step, { kind: 'enter', x: 110, z: 55 })).toBe(1);
    expect(eventCredit(step, { kind: 'enter', x: 160, z: 50 })).toBe(0);
    // A position-less event can never satisfy a positional step.
    expect(eventCredit(step, { kind: 'enter' })).toBe(0);
  });
});

describe('advancing', () => {
  it('bumps the counter without moving the step', () => {
    const q = quest();
    const after = advanceQuest(q, startQuest(q), { kind: 'kill', refId: 'enemy_bog_blob' });
    expect(after.changed).toBe(true);
    expect(after.state.counter).toBe(1);
    expect(after.state.step).toBe(0);
    expect(after.stepsCompleted).toHaveLength(0);
  });

  it('rolls to the next step when the target is met, resetting the counter', () => {
    const q = quest();
    let state = startQuest(q);
    for (let i = 0; i < 8; i++) {
      state = advanceQuest(q, state, { kind: 'kill', refId: 'enemy_bog_blob' }).state;
    }
    expect(state.step).toBe(1);
    expect(state.counter).toBe(0);
  });

  /**
   * "Kill 8, collect 3 from the same enemy" is one trip by design. The 8th kill
   * can drop the 3rd boil, and the player must not have to drop and re-pick it
   * because the step rolled over in the same instant.
   */
  it('cascades one event through several steps', () => {
    const q = validateQuestDef({
      ...quest(),
      steps: [
        { type: 'interact', objectTag: 'stump', count: 1, trackerText: 'Inspect a stump' },
        { type: 'interact', objectTag: 'stump', count: 1, trackerText: 'And another' },
      ],
    });
    const after = advanceQuest(q, startQuest(q), { kind: 'interact', tag: 'stump', qty: 2 });
    expect(after.stepsCompleted).toHaveLength(2);
    expect(after.completed).toBe(true);
    expect(questComplete(q, after.state)).toBe(true);
  });

  /**
   * `count` on a DELIVER step is the size of the stack, not a repeat count.
   * Treating it as a target asked the player to hold four separate
   * conversations with the same NPC — and the second one finds a step that was
   * already credited, so the quest could never finish at all.
   */
  it('finishes a delivery in one conversation, whatever the stack size', () => {
    const q = validateQuestDef({
      ...quest(),
      steps: [
        {
          type: 'deliver',
          itemId: 'item_material_mossbloom',
          count: 5,
          npcId: 'npc_bran',
          trackerText: 'Take the mossbloom to Bran',
        },
      ],
    });
    const after = advanceQuest(q, startQuest(q), { kind: 'talk', refId: 'npc_bran' });
    expect(after.stepsCompleted).toHaveLength(1);
    expect(after.completed).toBe(true);
    expect(questProgress(q, after.state)[0]).toMatchObject({ done: true, have: 1, need: 1 });
  });

  it('never runs past the last step', () => {
    const q = quest();
    const done: QuestState = { questId: q.id, step: 2, counter: 0, status: 'active' };
    const after = advanceQuest(q, done, { kind: 'kill', refId: 'enemy_bog_blob' });
    expect(after.changed).toBe(false);
    expect(after.state.step).toBe(2);
    expect(currentStep(q, after.state)).toBeNull();
  });

  it('ignores events once the quest is not active', () => {
    const q = quest();
    const turnedIn: QuestState = { questId: q.id, step: 2, counter: 0, status: 'turned_in' };
    expect(advanceQuest(q, turnedIn, { kind: 'kill', refId: 'enemy_bog_blob' }).changed).toBe(
      false,
    );
  });

  it('reports every step for the journal, with finished ones full', () => {
    const q = quest();
    const lines = questProgress(q, { questId: q.id, step: 1, counter: 2, status: 'active' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ done: true, have: 8, need: 8 });
    expect(lines[1]).toMatchObject({ done: false, have: 2, need: 3 });
  });
});

describe('flow validation', () => {
  it('passes a well-formed quest', () => {
    expect(validateQuestFlow(quest())).toEqual([]);
  });

  it('catches a kill step that counts nothing forever', () => {
    const broken = validateQuestDef({
      ...quest(),
      steps: [{ type: 'kill', count: 3, trackerText: 'Kill things' }],
    });
    expect(validateQuestFlow(broken).join(' ')).toContain('enemyId or an enemyTag');
  });

  it('catches an NPC quest with no way to close it', () => {
    const broken = validateQuestDef({
      ...quest(),
      giver: { kind: 'object', objectId: 'obj_note' },
      turnInNpcId: null,
      dialogue: { complete: [] },
    });
    expect(validateQuestFlow(broken)).toEqual([]);
    const npcGiven = validateQuestDef({ ...quest(), turnInNpcId: null });
    // An NPC giver turns it in to themselves, so this one is fine…
    expect(validateQuestFlow(npcGiven)).toEqual([]);
  });

  it('refuses a map hint on an explore step (QUESTS_POI §1.4)', () => {
    const broken = validateQuestDef({
      ...quest(),
      steps: [
        {
          type: 'explore',
          x: 0,
          z: 0,
          radius: 30,
          clueText: 'Follow the gulls.',
          trackerText: 'Find the sandbar',
          hint: { x: 0, z: 0, radius: 30 },
        },
      ],
    });
    expect(validateQuestFlow(broken).join(' ')).toContain('never marked on the map');
  });

  it('catches a dialogue jump to a node that does not exist', () => {
    const broken = validateQuestDef({
      ...quest(),
      dialogue: {
        offer: [
          {
            id: 'hello',
            text: 'The bog is eating my fence.',
            choices: [
              { text: 'Tell me more', action: 'goto', goto: 'nowhere' },
              { text: "I'll help", action: 'accept' },
            ],
          },
        ],
      },
    });
    expect(validateQuestFlow(broken).join(' ')).toContain('which does not exist');
  });

  it('catches an offer nobody can accept', () => {
    const broken = validateQuestDef({
      ...quest(),
      dialogue: {
        offer: [{ id: 'hello', text: 'Hello.', choices: [{ text: 'Bye', action: 'close' }] }],
      },
    });
    expect(validateQuestFlow(broken).join(' ')).toContain('no [Accept]');
  });

  it('catches a quest that requires itself', () => {
    const broken = validateQuestDef({
      ...quest(),
      prerequisites: { questIds: ['quest_shore_boil_trouble'] },
    });
    expect(validateQuestFlow(broken).join(' ')).toContain('requires itself');
  });
});

describe('reward ƒ-suggests', () => {
  const curve = (level: number) => Math.round((100 * Math.pow(level, 1.9)) / 10) * 10;

  it('scales with the level and with how much work the quest is', () => {
    const short = suggestedQuestXp(3, 1, curve);
    const long = suggestedQuestXp(3, 4, curve);
    const later = suggestedQuestXp(12, 1, curve);
    expect(long).toBeGreaterThan(short);
    expect(later).toBeGreaterThan(short);
  });

  it('rounds to something an author would type', () => {
    expect(suggestedQuestXp(3, 2, curve) % 5).toBe(0);
  });

  it('clamps nonsense input instead of returning nonsense', () => {
    expect(suggestedQuestXp(-4, 99, curve)).toBe(suggestedQuestXp(1, 6, curve));
    expect(suggestedQuestGold(0, 0)).toBe(suggestedQuestGold(1, 1));
  });
});

describe('hint circles', () => {
  it('says nothing when there is nothing placed to point at', () => {
    expect(questHintCoverage({ x: 0, z: 0, radius: 40 }, [])).toBeNull();
  });

  it('counts how many targets the circle actually contains', () => {
    const coverage = questHintCoverage({ x: 0, z: 0, radius: 40 }, [
      { x: 10, z: 0 },
      { x: 30, z: 20 },
      { x: 200, z: 0 },
    ]);
    expect(coverage).toMatchObject({ covered: true, inside: 2, shortfallM: 0 });
    expect(coverage?.nearestM).toBeCloseTo(10);
  });

  /**
   * The pilot set's real numbers. `quest_weald_silence_4` pointed a 60 m circle
   * at (-150, 60) while the only Mushroom King spawner stands at (0, 140): you
   * could follow the map exactly and be 110 m short of the boss.
   */
  it('reports the shortfall for a circle that points at nothing', () => {
    const coverage = questHintCoverage({ x: -150, z: 60, radius: 60 }, [{ x: 0, z: 140 }]);
    expect(coverage?.covered).toBe(false);
    expect(coverage?.inside).toBe(0);
    expect(coverage?.nearestM).toBeCloseTo(170, 0);
    expect(coverage?.shortfallM).toBeCloseTo(110, 0);
  });

  it('treats a target exactly on the rim as covered', () => {
    expect(questHintCoverage({ x: 0, z: 0, radius: 25 }, [{ x: 25, z: 0 }])).toMatchObject({
      covered: true,
      shortfallM: 0,
    });
  });
});
