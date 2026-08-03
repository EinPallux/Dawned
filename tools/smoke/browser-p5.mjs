#!/usr/bin/env node
/**
 * P5 ability check in a real browser: the hotbar renders from published
 * content, presses run the predicted evaluate→commit against the live server
 * (costs, cooldowns, rejects), Rage builds from landed basics, Rogue combo
 * points cycle through builder→finisher, buffs/debuffs sync onto the bars,
 * Charge dashes the body, and the RMB stance engages server-side (Blocking
 * flag echoes / Evasive drains Energy). Drives the REAL client (Vite dev).
 *
 * Usage: node tools/smoke/browser-p5.mjs [http://localhost:5173] [--screenshots DIR]
 * Requires: game server (:8081, protocol v7 + published P5 kits), client dev
 * server, local Postgres. Restart the game server for deterministic state.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5173';
const shotIndex = process.argv.indexOf('--screenshots');
const SHOT_DIR = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;
const PASSWORD = 'smoke-pass-123456';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://dawned:dawned@127.0.0.1:5432/dawned';

/** Blocking bit of EntityFlag (protocol v7) — keep in sync with opcodes.ts. */
const FLAG_BLOCKING = 1 << 9;

const ok = (message) => console.log(`✅ ${message}`);
class SmokeFailure extends Error {}
const fail = (message) => {
  throw new SmokeFailure(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shoot = async (page, name) => {
  if (!SHOT_DIR) return;
  try {
    await mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, name), timeout: 30000 });
  } catch (error) {
    console.warn(`⚠️  screenshot ${name} skipped (${error.message.split('\n')[0]})`);
  }
};

const abilityState = (page) => page.evaluate(() => window.__dawned.abilityState());
const combatState = (page) => page.evaluate(() => window.__dawned.combatState());
const pressSlot = (page, slot) => page.evaluate((s) => window.__dawned.pressSlot(s), slot);
const attack = (page) => page.evaluate(() => window.__dawned.attack());
const setStance = (page, held) => page.evaluate((h) => window.__dawned.setStance(h), held);

/** Poll a page-side condition with a friendly failure. */
const waitFor = async (label, fn, timeoutMs = 8000, everyMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  fail(`timed out waiting for ${label}`);
};

const enterWorld = async (page, characterName, errors) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  try {
    await page.click(`.char-card:has-text("${characterName}")`, { timeout: 60000 });
    await page.click('.btn--primary:has-text("ENTER WORLD")', { timeout: 60000 });
    await page.waitForSelector('.hud', { timeout: 90000 });
    await page.waitForFunction(
      () => document.querySelector('.hud-status')?.textContent?.includes('in world'),
      undefined,
      { timeout: 90000 },
    );
  } catch (error) {
    fail(
      `never reached the world as ${characterName} (${error.message.split('\n')[0]})` +
        (errors.length ? `; page errors:\n  ${errors.slice(0, 5).join('\n  ')}` : ''),
    );
  }
};

/**
 * Aim the camera EXACTLY at the nearest training dummy (fresh fixture
 * characters store an arbitrary yaw; a rough sweep can lock a dummy 15 m down
 * the line and every melee swing whiffs). Returns the distance to it.
 */
const aimAtNearestDummy = (page) =>
  page.evaluate(() => {
    const DEAD = 1 << 7; // EntityFlag.Dead — corpses are not targets
    const c = window.__dawned.connection;
    const p = c.renderPosition();
    let best = null;
    let bestD = 1e9;
    for (const r of c.remotes.values()) {
      if (r.enemyMeta?.typeId !== 'enemy_training_dummy') continue;
      if ((r.render.flags & DEAD) !== 0) continue;
      const d = Math.hypot(r.render.x - p.x, r.render.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best) window.__dawned.input.yaw = Math.atan2(best.render.x - p.x, best.render.z - p.z);
    return bestD;
  });

/** Aim at the nearest living dummy and close to melee range if needed.
 * With every dummy momentarily dead, STAND STILL — they respawn in 15 s and
 * walking blind marches the character off the training line. */
const closeOnDummy = async (page, maxDist = 2.2) => {
  const dist = await aimAtNearestDummy(page);
  if (dist <= maxDist) return true;
  if (dist < 1e8) {
    await page.keyboard.down('KeyW');
    await sleep(180);
    await page.keyboard.up('KeyW');
  } else {
    await sleep(400);
  }
  return false;
};

/** Wait for the dummies to stream in, aim at the nearest, confirm the lock. */
const acquireDummy = async (page) => {
  await page.waitForFunction(
    () => {
      for (const r of window.__dawned.connection.remotes.values()) {
        if (r.enemyMeta?.typeId === 'enemy_training_dummy') return true;
      }
      return false;
    },
    undefined,
    { timeout: 30000 },
  );
  await waitFor(
    'soft-target (dummy)',
    async () => {
      await aimAtNearestDummy(page);
      return (await combatState(page)).target;
    },
    25000,
    200,
  );
};

const openPage = async (browser, token) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript((sessionToken) => {
    localStorage.setItem('dawned.token', sessionToken);
  }, token);
  return { context, page, errors };
};

const main = async () => {
  console.log(`Dawned P5 browser check → ${BASE_URL}\n`);

  const token = await ensureAccount(BASE_URL, 'zz_p5_arena', PASSWORD);
  const warrior = await ensureCharacter(BASE_URL, token, 'Kitwarrior', 'warrior');
  const rogue = await ensureCharacter(BASE_URL, token, 'Kitrogue', 'rogue');
  const ranger = await ensureCharacter(BASE_URL, token, 'Kitvsranged', 'rogue');
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  // Both park in reach of the middle training dummy (same spot the P4 smoke
  // uses); full HP so nothing dies mid-probe; level 25 so the WHOLE kit is
  // unlocked (SLOT_UNLOCK_LEVELS gates slots 2–8 between levels 3 and 25).
  await db.query(
    'UPDATE characters SET pos_x=0.5, pos_y=4.6, pos_z=382.6, hp=NULL, level=25 WHERE id = ANY($1)',
    [[warrior.id, rogue.id]],
  );
  // The third run parks at the Spore Ridge camp CENTER (P5's Ranged test camp
  // at 16,300): the nearest lobber panic-melees while the others kite out and
  // volley — every ranged system fires while the first kill comes fast.
  // Level 12, not parity: the bot never dodges — 3 focus-firing lobbers kill
  // a parity character who stands in every bolt (verified; at 10 the race
  // between first-kill and bot-death still flipped roughly 1 run in 4). The
  // owner's DoD run is the parity test; this asserts the SYSTEMS.
  await db.query(
    'UPDATE characters SET pos_x=16, pos_y=5, pos_z=300, hp=NULL, level=12 WHERE id=$1',
    [ranger.id],
  );
  await db.end();
  ok('fixtures parked (warrior + rogue at the dummies, one inside the spore ridge)');

  const browser = await chromium.launch();
  try {
    await runWarrior(browser, token);
    await runRogue(browser, token);
    await runRangedCamp(browser, token);
  } finally {
    await browser.close();
  }
  console.log('\n🗡️  P5 browser check passed — kits, resources, stances, buffs, ranged camp.\n');
};

// ---------------------------------------------------------------------------
// Warrior: Rage gating, builders→spenders, Charge dash, bleed, Shield Wall, Block
// ---------------------------------------------------------------------------

const runWarrior = async (browser, token) => {
  const { context, page, errors } = await openPage(browser, token);

  await enterWorld(page, 'Kitwarrior', errors);
  await acquireDummy(page);
  ok('warrior in world with a dummy under the reticle');

  // 1. Hotbar renders all 8 published defs (content → prediction layer).
  await waitFor(
    'ability defs on the hotbar',
    async () => (await abilityState(page)).defsLoaded === 8,
  );
  const slotCount = await page.evaluate(
    () => document.querySelectorAll('.hud-hotbar .hud-slot:not(.is-dodge)').length,
  );
  if (slotCount !== 8) fail(`hotbar DOM has ${slotCount} slots, want 8`);
  // Round 7: every slot wears its baked game-icons icon (masked SVG tile).
  await waitFor(
    'ability icons on the tiles',
    () => page.evaluate(() => document.querySelectorAll('.hud-hotbar .hud-slot-icon').length >= 8),
    10000,
    200,
  );
  ok('hotbar renders 8 slots from published content, all with icons');

  // 2. Rage starts empty: Crushing Blow (25 Rage) refuses LOCALLY — no
  //    request, no cooldown, red seam pulse on the slot.
  let state = await abilityState(page);
  if (state.resource.type !== 'rage' || state.resource.value > 0) {
    fail(`fresh warrior should sit at 0 rage (got ${state.resource.type} ${state.resource.value})`);
  }
  await pressSlot(page, 1);
  const refusal = await page.evaluate(() => ({
    seam:
      document.querySelector('.hud-slot[data-slot="1"]')?.classList.contains('is-refused') ?? false,
    text: document.querySelector('.hud-refusal')?.textContent ?? '',
    tileState: document.querySelector('.hud-slot[data-slot="1"]')?.getAttribute('data-state'),
  }));
  state = await abilityState(page);
  if (state.hotbar[0].cooldownMs > 0) fail('refused press must not start a cooldown');
  if (!refusal.seam) fail('refused press should pulse the red seam on slot 1');
  if (!refusal.text.includes('Rage')) fail(`refusal should say why (got "${refusal.text}")`);
  if (refusal.tileState !== 'poor') {
    fail(`0-Rage slot should read data-state=poor (got ${refusal.tileState})`);
  }
  ok('insufficient Rage refuses IN WORDS (floating reason + red seam + dark tile)');

  // 3. Landed basics build Rage (+4 rider per hit, snapshot-rebased). ≥20 is
  //    five landed hits — proof of the rider without needing a healthy arena
  //    (spender steps below bank their own Rage with role-committed loops).
  await waitFor(
    'Rage from landed basics',
    async () => {
      if (!(await closeOnDummy(page))) return false;
      await attack(page);
      await sleep(450);
      return (await abilityState(page)).resource.value >= 20;
    },
    45000,
    50,
  );
  ok('Rage builds from landed basics (combat rider)');

  // Aim at the fullest LIVING dummy and close on it; also reports how many
  // are alive. Fullest-first matters twice over: dummies reset to full 5 s
  // out of combat, and at level 25 a chewed host dies to the direct hit.
  const closeOnFullestDummy = async () => {
    const status = await page.evaluate(() => {
      const DEAD = 1 << 7;
      const c = window.__dawned.connection;
      const p = c.renderPosition();
      let best = null;
      let bestId = 0;
      let bestScore = -1;
      let bestD = 1e9;
      let bestHp = 0;
      let living = 0;
      for (const [id, r] of c.remotes) {
        if (r.enemyMeta?.typeId !== 'enemy_training_dummy') continue;
        if ((r.render.flags & DEAD) !== 0) continue;
        living += 1;
        const d = Math.hypot(r.render.x - p.x, r.render.z - p.z);
        const score = r.render.hpFraction - d * 0.001; // fullest, ties → nearest
        if (score > bestScore) {
          bestScore = score;
          bestD = d;
          bestHp = r.render.hpFraction;
          best = r;
          bestId = id;
        }
      }
      if (best) window.__dawned.input.yaw = Math.atan2(best.render.x - p.x, best.render.z - p.z);
      return { dist: bestD, hpFraction: bestHp, living, id: bestId };
    });
    if (status.dist > 2.2) {
      if (status.dist < 1e8) {
        await page.keyboard.down('KeyW');
        await sleep(180);
        await page.keyboard.up('KeyW');
      } else {
        await sleep(400); // line wiped — wait where we stand for the respawn
      }
      return null;
    }
    return status;
  };

  /** Re-aim at a SPECIFIC entity (keeps the soft-target lock on it). */
  const aimAtEntity = (id) =>
    page.evaluate((entityId) => {
      const c = window.__dawned.connection;
      const r = c.remotes.get(entityId);
      if (!r || (r.render.flags & (1 << 7)) !== 0) return false;
      const p = c.renderPosition();
      window.__dawned.input.yaw = Math.atan2(r.render.x - p.x, r.render.z - p.z);
      return true;
    }, id);

  // 4. Rending Slash (slot 4): bleed debuff on the dummy + DoT ticks.
  //    `targetEffects` reads the CURRENT SOFT TARGET's effects, so the press
  //    and the verify are BOUND to one entity. Choreography (round 8, after
  //    three failure modes reproduced): commit to ROLES up front — one dummy
  //    is the rage BUILDER, a DIFFERENT one is the bleed HOST. Ad-hoc
  //    per-iteration choices let the roles flip-flop (chew the nearest → it
  //    disqualifies → the other resets → walk over → Rage decays → rebuild →
  //    chew the new host…) and starve the whole budget. With the host never
  //    the rage source, it idles to a 5 s out-of-combat full reset while the
  //    builder soaks the basics, and the press meets a full body every cycle.
  const dummyRoles = () =>
    page.evaluate(() => {
      const DEAD = 1 << 7;
      const c = window.__dawned.connection;
      const p = c.renderPosition();
      const living = [];
      for (const [id, r] of c.remotes) {
        if (r.enemyMeta?.typeId !== 'enemy_training_dummy') continue;
        if ((r.render.flags & DEAD) !== 0) continue;
        living.push({
          id,
          hp: r.render.hpFraction,
          dist: Math.hypot(r.render.x - p.x, r.render.z - p.z),
        });
      }
      if (living.length < 2) return null;
      living.sort((a, b) => a.dist - b.dist);
      const builder = living[0];
      const host = living
        .slice(1)
        .reduce((best, d) => (d.hp - d.dist * 0.001 > best.hp - best.dist * 0.001 ? d : best));
      return { builderId: builder.id, hostId: host.id, hostHp: host.hp };
    });
  const approachEntity = async (id, maxDist) => {
    for (let i = 0; i < 60; i++) {
      const dist = await page.evaluate((entityId) => {
        const c = window.__dawned.connection;
        const r = c.remotes.get(entityId);
        if (!r || (r.render.flags & (1 << 7)) !== 0) return null;
        const p = c.renderPosition();
        window.__dawned.input.yaw = Math.atan2(r.render.x - p.x, r.render.z - p.z);
        return Math.hypot(r.render.x - p.x, r.render.z - p.z);
      }, id);
      if (dist === null) return false; // died — caller repicks roles
      if (dist <= maxDist) return true;
      await page.keyboard.down('KeyW');
      await sleep(180);
      await page.keyboard.up('KeyW');
    }
    return false;
  };
  await waitFor(
    'bleed on the target strip',
    async () => {
      const roles = await dummyRoles();
      if (!roles) {
        await sleep(800); // fewer than 2 living — respawns land within 15 s
        return false;
      }
      // Build phase: basics at the BUILDER only, until 45 Rage is banked
      // (cost 30 + decay margin for the walk to the host).
      for (let i = 0; i < 24; i++) {
        if ((await abilityState(page)).resource.value >= 45) break;
        if (!(await approachEntity(roles.builderId, 2.2))) return false; // builder died
        await attack(page);
        await sleep(430);
      }
      if ((await abilityState(page)).resource.value < 40) return false;
      // Press phase: walk to the untouched host, settle, verify bound to it.
      if (!(await approachEntity(roles.hostId, 2.2))) return false;
      await sleep(500); // let any in-flight basic land — no corpse presses
      if (!(await aimAtEntity(roles.hostId))) return false;
      const ready = await abilityState(page);
      const hostHp = await page.evaluate((id) => {
        const r = window.__dawned.connection.remotes.get(id);
        return r ? r.render.hpFraction : 0;
      }, roles.hostId);
      // A refused press arms no cooldown and applies nothing — never press
      // under the 30 cost (Rage decays 2/s OOC during the walk + settle).
      if (hostHp < 0.6 || ready.resource.value < 32 || ready.hotbar[3].cooldownMs > 0) {
        return false;
      }
      await pressSlot(page, 4);
      // Hold the reticle on the pressed host until its bleed shows (contact
      // ~440 ms + EffectSync); bail to the outer retry if it dies anyway.
      for (let i = 0; i < 12; i++) {
        await sleep(250);
        if (!(await aimAtEntity(roles.hostId))) return false;
        if ((await abilityState(page)).targetEffects.length > 0) return true;
      }
      return false;
    },
    90000,
    100,
  );
  // DoT proof: damage numbers keep coming with NO further presses. At level
  // 25 the host dummy can die under the bleed mid-window, so re-arm on a
  // living target when the strip empties (Rending is off cooldown by then).
  await waitFor(
    'bleed DoT ticks (FCT without presses)',
    async () => {
      const before = (await combatState(page)).fctTotal;
      await sleep(1400);
      if ((await combatState(page)).fctTotal > before) return true;
      const state = await abilityState(page);
      if (state.targetEffects.length === 0 && (await closeOnDummy(page))) {
        if (state.resource.value >= 30 && state.hotbar[3].cooldownMs <= 0) {
          await pressSlot(page, 4);
        } else {
          await attack(page); // rebuild Rage toward the re-arm
        }
      }
      return false;
    },
    30000,
    100,
  );
  ok('Rending Slash applies a bleed (target strip + DoT ticks)');

  // 5. Charge (slot 3): free, 12 s cooldown, dash carries the body. Aim at a
  //    CLEAR heading first — stopOnHit against the dummy 2.6 m away would cut
  //    the dash short and prove nothing.
  await page.evaluate(() => {
    const dawned = window.__dawned;
    const base = dawned.input.yaw;
    for (let i = 1; i <= 8; i++) {
      dawned.input.yaw = base + (i * Math.PI) / 4;
      if (!dawned.combatState().target) return;
    }
  });
  const before = await page.evaluate(() => window.__dawned.connection.renderPosition());
  await pressSlot(page, 3);
  await sleep(600);
  const after = await page.evaluate(() => window.__dawned.connection.renderPosition());
  const dashed = Math.hypot(after.x - before.x, after.z - before.z);
  if (dashed < 2.5) fail(`Charge should dash the body (moved ${dashed.toFixed(2)} m)`);
  state = await abilityState(page);
  if (state.hotbar[2].cooldownMs <= 0) fail('Charge must be cooling after use');
  ok(`Charge dashes the body (${dashed.toFixed(1)} m) and starts its cooldown`);

  // Walk back into melee reach before the melee asserts (dash left the line):
  // face the nearest living dummy exactly and hold W in bursts until close.
  await waitFor('back in dummy reach', () => closeOnDummy(page), 25000, 50);

  // 6. Crushing Blow with Rage banked: accepted, Rage drops, dummy bleeds FCT.
  //    Press ONLY over a verified healthy host: at level 25 the rage-building
  //    basics can finish a chewed dummy with the killing hit still in flight,
  //    and a slot press over the fresh corpse commits, debits and whiffs into
  //    empty air — no damage numbers ever (round-8 flake, reproduced). The
  //    settle sleep lets any in-flight basic contact before the re-check.
  await waitFor(
    'Crushing Blow lands on a healthy host',
    async () => {
      let s = await abilityState(page);
      if (s.resource.value < 34) {
        if (await closeOnDummy(page)) await attack(page);
        await sleep(420);
        return false;
      }
      const host = await closeOnFullestDummy();
      if (!host || host.hpFraction < 0.5) return false; // resets/respawns land
      await sleep(500);
      const settled = await closeOnFullestDummy();
      if (!settled || settled.hpFraction < 0.5) return false;
      s = await abilityState(page);
      const rageBefore = s.resource.value;
      // ≥28, not ≥25: OOC decay keeps running between this read and the press,
      // and an edge-exact pool refuses AT the press — which the spend check
      // below would misread as broken cost math (round 8: "was 27, now 23").
      if (rageBefore < 28) return false;
      const fctBefore = (await combatState(page)).fctTotal;
      await pressSlot(page, 1);
      await sleep(700);
      const after = await abilityState(page);
      if (after.resource.value > rageBefore - 15) {
        fail(
          `Crushing Blow should spend ~25 Rage (was ${rageBefore}, now ${after.resource.value})`,
        );
      }
      // No numbers = the host still died under us — Crushing is cd-0, retry.
      return (await combatState(page)).fctTotal > fctBefore;
    },
    60000,
    100,
  );
  ok('Crushing Blow spends Rage and lands (predicted commit, server resolve)');

  // 7. Shield Wall (slot 7, self buff): EffectSync puts it on the buff bar.
  await pressSlot(page, 7);
  await waitFor('Shield Wall on the self buff bar', async () => {
    const s = await abilityState(page);
    return s.selfEffects.length > 0;
  });
  const chip = await page.evaluate(
    () => document.querySelectorAll('.hud-effects .hud-effect').length,
  );
  if (chip < 1) fail('self buff row should render a chip for Shield Wall');
  ok('Shield Wall syncs onto the buff bar (EffectSync → chips)');

  // 8. RMB Block: the server folds the stance and echoes the Blocking flag.
  await setStance(page, true);
  await waitFor('Blocking flag from the server', async () => {
    const s = await abilityState(page);
    return (s.selfFlags & FLAG_BLOCKING) !== 0;
  });
  await setStance(page, false);
  ok('RMB Block engages server-side (Blocking flag echoed in snapshots)');

  await shoot(page, 'p5-warrior.png');
  if (errors.length > 0) {
    fail(`warrior phase console errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
  }
  ok('warrior phase: no console errors');
  await context.close();
};

// ---------------------------------------------------------------------------
// Rogue: Energy economy, builder → combo points → finisher, Evasive drain
// ---------------------------------------------------------------------------

const runRogue = async (browser, token) => {
  const { context, page, errors } = await openPage(browser, token);

  await enterWorld(page, 'Kitrogue', errors);
  await acquireDummy(page);
  await waitFor(
    'ability defs on the hotbar',
    async () => (await abilityState(page)).defsLoaded === 8,
  );
  ok('rogue in world with the kit loaded');

  // 9. Energy pool starts full; Twin Strike spends 25 and grants a combo point.
  let state = await abilityState(page);
  if (state.resource.type !== 'energy' || state.resource.value < 95) {
    fail(`fresh rogue should sit near 100 energy (got ${state.resource.value})`);
  }
  await waitFor('dummy in reach for Twin Strike', () => closeOnDummy(page), 25000, 50);
  await pressSlot(page, 1);
  // The commit debits instantly (prediction); read before regen refills it.
  const energyAfterPress = (await abilityState(page)).resource.value;
  if (energyAfterPress > 80) {
    fail(`Twin Strike should spend ~25 energy (at ${energyAfterPress} right after the press)`);
  }
  await waitFor('combo point from Twin Strike', async () => {
    const s = await abilityState(page);
    return s.resource.comboPoints >= 1;
  });
  const litPips = await page.evaluate(
    () => document.querySelectorAll('.hud-cp .hud-cp-pip[data-lit="true"]').length,
  );
  if (litPips < 1) fail('combo point pips should light over the resource globe');
  ok('Twin Strike spends Energy and lights combo pips');

  // 9b. R8 REGRESSION — cd-0 spam: a SECOND press of the same zero-cooldown
  // slot must commit again. (commitUse burned a charge that nothing ever
  // refilled, bricking every cd-0 spender after one use — on both sides, so
  // the server agreed and no smoke caught it via a single press.)
  await waitFor('energy + GCD for a second Twin Strike', async () => {
    const s = await abilityState(page);
    return s.resource.value >= 95;
  });
  await pressSlot(page, 1);
  const energySecondPress = (await abilityState(page)).resource.value;
  if (energySecondPress > 80) {
    fail(
      `second Twin Strike press must spend again (at ${energySecondPress} — ` +
        'zero-cooldown charge bricked?)',
    );
  }
  ok('zero-cooldown ability casts repeatedly (second press spends again)');

  // 10. Eviscerate (finisher) spends ALL combo points.
  await waitFor(
    'energy for Eviscerate',
    async () => (await abilityState(page)).resource.value >= 30,
  );
  await waitFor('dummy in reach for Eviscerate', () => closeOnDummy(page), 25000, 50);
  await pressSlot(page, 3);
  await waitFor('combo points spent by the finisher', async () => {
    const s = await abilityState(page);
    return s.resource.comboPoints === 0;
  });
  ok('Eviscerate spends the combo points (finisher path)');

  // 11. Evasive Stance: held RMB drains Energy server-side (3/s, mirrored).
  //     The stance rides movement INTENTS, which only flow once the sim gate
  //     opens (ground streamed under the player) — wait for streaming first.
  await page.waitForFunction(
    () => {
      const t = window.__dawned.terrainStats();
      return t.resident > 0 && t.pending === 0;
    },
    undefined,
    { timeout: 90000 },
  );
  //     Measurement design (round 8): the DISPLAYED pool re-bases onto the
  //     wire's integer floor nearly every snapshot, so a single absolute
  //     "held < free projection" check rides ±2 of floor jitter and fails on
  //     the boundary while the server drains perfectly (verified). Instead,
  //     compare a FREE window and a HELD window measured IDENTICALLY — same
  //     entry gate, one Twin Strike sink (25, cd-0 — keeps the window off the
  //     100 cap), same settle — so read-timing bias mirrors and cancels. The
  //     ~7.5 energy gap (3/s × 2.5 s) dwarfs the jitter.
  const measureRegenWindow = async (held) => {
    // Entry state: catch the rising pool just past 65 → sink → ~41 → settle
    // (+18) → window start ~59, free end ~89 — never capped.
    await waitFor(
      'energy past 65 for a drain window',
      async () => (await abilityState(page)).resource.value >= 65,
      20000,
      100,
    );
    await pressSlot(page, 1);
    await sleep(1500); // spend adopted server-side; display converged
    if (held) await setStance(page, true);
    const start = (await abilityState(page)).resource.value;
    await sleep(2500);
    const delta = (await abilityState(page)).resource.value - start;
    if (held) await setStance(page, false);
    return delta;
  };
  const freeDelta = await measureRegenWindow(false);
  const heldDelta = await measureRegenWindow(true);
  if (heldDelta > freeDelta - 3) {
    fail(
      `Evasive should slow the Energy curve (free +${freeDelta} vs held +${heldDelta} ` +
        'over 2500 ms — expected a ≥3 gap from the 3/s drain)',
    );
  }
  ok(`Evasive Stance drains Energy while held (free +${freeDelta} vs held +${heldDelta})`);

  await shoot(page, 'p5-rogue.png');
  if (errors.length > 0) {
    fail(`rogue phase console errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
  }
  ok('rogue phase: no console errors');
  await context.close();
};

// ---------------------------------------------------------------------------
// Ranged camp: Spore Lobbers volley dodgeable bolts, and the kit clears them
// ---------------------------------------------------------------------------

const runRangedCamp = async (browser, token) => {
  const { context, page, errors } = await openPage(browser, token);

  await enterWorld(page, 'Kitvsranged', errors);

  // 12. The camp streams in on dry land.
  await page.waitForFunction(
    () => {
      let count = 0;
      for (const r of window.__dawned.connection.remotes.values()) {
        if (r.enemyMeta?.typeId === 'enemy_spore_lobber') count++;
      }
      return count >= 3;
    },
    undefined,
    { timeout: 30000 },
  );
  const dry = await page.evaluate(() => {
    for (const r of window.__dawned.connection.remotes.values()) {
      if (r.enemyMeta?.typeId === 'enemy_spore_lobber' && r.render.y < 0.5) return false;
    }
    return true;
  });
  if (!dry) fail('spore ridge spawned in water — move the spawner');
  ok('spore ridge streams in (3 lobbers on dry land)');

  // 13–14. One live fight, three staged proofs: volleys fly (ProjectileSpawn
  // events), bolts connect (hp drops), and the kit kills a lobber. The bot
  // fights from second one — standing around under 3 snipers is how bots die.
  await page.evaluate(() => {
    const c = window.__dawned.connection;
    window.__boltSpawns = 0;
    const prev = c.events.onProjectileSpawn;
    c.events.onProjectileSpawn = (m) => {
      window.__boltSpawns += 1;
      prev?.(m);
    };
  });
  const aimAtLobber = () =>
    page.evaluate(() => {
      const DEAD = 1 << 7;
      const c = window.__dawned.connection;
      const p = c.renderPosition();
      let best = null;
      let bestD = 1e9;
      for (const r of c.remotes.values()) {
        if (r.enemyMeta?.typeId !== 'enemy_spore_lobber') continue;
        if ((r.render.flags & DEAD) !== 0) continue;
        const d = Math.hypot(r.render.x - p.x, r.render.z - p.z);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      if (best) window.__dawned.input.yaw = Math.atan2(best.render.x - p.x, best.render.z - p.z);
      return bestD;
    });
  let sawVolley = false;
  let sawBoltHit = false;
  await waitFor(
    'ranged-camp fight (volleys + hits + first kill)',
    async () => {
      if (!sawVolley && (await page.evaluate(() => window.__boltSpawns >= 2))) {
        sawVolley = true;
        ok('lobbers volley projectiles at the intruder');
      }
      const s = await combatState(page);
      if (!sawBoltHit && s.hp > 0 && s.hp < s.maxHp) {
        sawBoltHit = true;
        ok('spore bolts connect (hp dropping under ranged fire)');
      }
      if (s.dead) {
        fail('the intruder died to the camp — retune the fixture or the lobbers');
      }
      const dead = await page.evaluate(() => {
        const DEAD = 1 << 7;
        let count = 0;
        for (const r of window.__dawned.connection.remotes.values()) {
          if (r.enemyMeta?.typeId === 'enemy_spore_lobber' && (r.render.flags & DEAD) !== 0) {
            count++;
          }
        }
        return count;
      });
      if (dead >= 1 && sawVolley && sawBoltHit) return true;

      const dist = await aimAtLobber();
      const state = await abilityState(page);
      if (dist > 6 && dist < 1e8 && state.hotbar[1].cooldownMs <= 0 && state.resource.value >= 20) {
        // Shadowstep behind the kiter — the kit's own answer to ranged flight.
        await pressSlot(page, 2);
        await sleep(250);
      } else if (dist > 2.0 && dist < 1e8) {
        // Sprint burst: a kiting lobber backs off at 60% speed — walk loses.
        await page.keyboard.down('ShiftLeft');
        await page.keyboard.down('KeyW');
        await sleep(380);
        await page.keyboard.up('KeyW');
        await page.keyboard.up('ShiftLeft');
      }
      await aimAtLobber();
      await attack(page);
      await pressSlot(page, 1); // Twin Strike whenever Energy allows
      await sleep(260);
      return false;
    },
    90000,
    50,
  );
  ok('the kit clears a lobber (Shadowstep closes, melee finishes)');

  await shoot(page, 'p5-ranged.png');
  if (errors.length > 0) {
    fail(`ranged phase console errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
  }
  ok('ranged phase: no console errors');
  await context.close();
};

main().catch((error) => {
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
});
