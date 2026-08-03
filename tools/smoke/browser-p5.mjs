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

/** Aim at the nearest living dummy and close to melee range if needed. */
const closeOnDummy = async (page, maxDist = 2.2) => {
  const dist = await aimAtNearestDummy(page);
  if (dist <= maxDist) return true;
  await page.keyboard.down('KeyW');
  await sleep(180);
  await page.keyboard.up('KeyW');
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
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  // Both park in reach of the middle training dummy (same spot the P4 smoke
  // uses); full HP so nothing dies mid-probe; level 25 so the WHOLE kit is
  // unlocked (SLOT_UNLOCK_LEVELS gates slots 2–8 between levels 3 and 25).
  await db.query(
    'UPDATE characters SET pos_x=0.5, pos_y=4.6, pos_z=382.6, hp=NULL, level=25 WHERE id = ANY($1)',
    [[warrior.id, rogue.id]],
  );
  await db.end();
  ok('fixtures parked at the training line (warrior + rogue, level 25)');

  const browser = await chromium.launch();
  try {
    await runWarrior(browser, token);
    await runRogue(browser, token);
  } finally {
    await browser.close();
  }
  console.log('\n🗡️  P5 browser check passed — kits, resources, stances, buffs.\n');
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
  ok('hotbar renders 8 slots from published content');

  // 2. Rage starts empty: Crushing Blow (25 Rage) refuses LOCALLY — no
  //    request, no cooldown, red seam pulse on the slot.
  let state = await abilityState(page);
  if (state.resource.type !== 'rage' || state.resource.value > 0) {
    fail(`fresh warrior should sit at 0 rage (got ${state.resource.type} ${state.resource.value})`);
  }
  await pressSlot(page, 1);
  const refused = await page.evaluate(
    () =>
      document.querySelector('.hud-slot[data-slot="1"]')?.classList.contains('is-refused') ?? false,
  );
  state = await abilityState(page);
  if (state.hotbar[0].cooldownMs > 0) fail('refused press must not start a cooldown');
  if (!refused) fail('refused press should pulse the red seam on slot 1');
  ok('insufficient Rage refuses locally (red seam, no request)');

  // 3. Landed basics build Rage (+4 rider per hit, snapshot-rebased).
  await waitFor(
    'Rage from landed basics',
    async () => {
      if (!(await closeOnDummy(page))) return false;
      await attack(page);
      await sleep(450);
      return (await abilityState(page)).resource.value >= 30;
    },
    30000,
    50,
  );
  ok('Rage builds from landed basics (combat rider)');

  // 4. Charge (slot 3): free, 12 s cooldown, dash carries the body. Aim at a
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

  // 5. Crushing Blow with Rage banked: accepted, Rage drops, dummy bleeds FCT.
  await waitFor(
    'Rage ≥ 30 again',
    async () => {
      if (!(await closeOnDummy(page))) return false;
      await attack(page);
      await sleep(420);
      return (await abilityState(page)).resource.value >= 30;
    },
    30000,
    50,
  );
  const rageBefore = (await abilityState(page)).resource.value;
  const fctBefore = (await combatState(page)).fctTotal;
  await pressSlot(page, 1);
  await sleep(700);
  state = await abilityState(page);
  const fctAfter = (await combatState(page)).fctTotal;
  if (state.resource.value > rageBefore - 15) {
    fail(`Crushing Blow should spend ~25 Rage (was ${rageBefore}, now ${state.resource.value})`);
  }
  if (fctAfter <= fctBefore) fail('Crushing Blow should land damage numbers on the dummy');
  ok('Crushing Blow spends Rage and lands (predicted commit, server resolve)');

  // 6. Shield Wall (slot 7, self buff): EffectSync puts it on the buff bar.
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

  // 7. Rending Slash (slot 4): bleed debuff on the dummy + DoT ticks.
  await waitFor(
    'Rage ≥ 35 for Rending Slash',
    async () => {
      if (!(await closeOnDummy(page))) return false;
      await attack(page);
      await sleep(420);
      return (await abilityState(page)).resource.value >= 35;
    },
    30000,
    50,
  );
  await waitFor('dummy in reach for Rending Slash', () => closeOnDummy(page), 25000, 50);
  await pressSlot(page, 4);
  await waitFor('bleed on the target strip', async () => {
    const s = await abilityState(page);
    return s.targetEffects.length > 0;
  });
  const dotBase = (await combatState(page)).fctTotal;
  await sleep(2600);
  const dotAfter = (await combatState(page)).fctTotal;
  if (dotAfter <= dotBase) fail('the bleed should tick damage numbers without further presses');
  ok('Rending Slash applies a bleed (target strip + DoT ticks)');

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
    { timeout: 90000 },
  );
  //     Sink energy first (Fan of Knives, 30) so the pool can't hit its cap
  //     mid-measurement — at the cap drain and regen are indistinguishable.
  await waitFor(
    'energy for Fan of Knives',
    async () => (await abilityState(page)).resource.value >= 30,
  );
  await pressSlot(page, 4);
  await sleep(250);
  const energyBefore = (await abilityState(page)).resource.value;
  await setStance(page, true);
  await sleep(2000);
  const energyHeld = (await abilityState(page)).resource.value;
  await setStance(page, false);
  // Regen is +12/s vs drain −3/s; while held net is +9/s vs +12/s free. The
  // clean observable: value must stay BELOW a free-regen projection.
  const freeProjection = Math.min(100, energyBefore + 2 * 12);
  if (energyHeld >= freeProjection) {
    fail(
      `Evasive should slow the Energy curve (held ${energyHeld}, free would be ~${freeProjection})`,
    );
  }
  ok('Evasive Stance drains Energy while held (server-mirrored)');

  await shoot(page, 'p5-rogue.png');
  if (errors.length > 0) {
    fail(`rogue phase console errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
  }
  ok('rogue phase: no console errors');
  await context.close();
};

main().catch((error) => {
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
});
