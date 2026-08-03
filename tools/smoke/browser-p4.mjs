#!/usr/bin/env node
/**
 * P4 combat check in a real browser: enemies render with plates, the basic
 * combo lands with floating combat text and dummy HP drops, a glub camp
 * fights back with telegraphs, and the death → soul screen → respawn →
 * Dawned loop closes. Drives the REAL client (Vite dev) against the live
 * server; combat requests go through Connection.requestBasicAttack (pointer
 * lock is unreliable headless — the LMB→request wiring above it is thin and
 * covered by the input unit surface).
 *
 * Usage: node tools/smoke/browser-p4.mjs [http://localhost:5173] [--screenshots DIR]
 * Requires: game server (:8081, protocol v6 + P4 seeds), client dev server,
 * local Postgres. Restart the game server for deterministic camp state.
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

const combatState = (page) => page.evaluate(() => window.__dawned.combatState());

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

const main = async () => {
  console.log(`Dawned P4 browser check → ${BASE_URL}\n`);

  const token = await ensureAccount(BASE_URL, 'zz_p4_arena', PASSWORD);
  const fighter = await ensureCharacter(BASE_URL, token, 'Arenaprobe', 'warrior');
  const doomed = await ensureCharacter(BASE_URL, token, 'Arenadoom', 'rogue');
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  // Fighter starts IN REACH of the middle dummy (reach 2.6 m + its radius);
  // the doomed run inside the west camp.
  await db.query('UPDATE characters SET pos_x=0.5, pos_y=4.6, pos_z=382.6, hp=NULL WHERE id=$1', [
    fighter.id,
  ]);
  await db.query('UPDATE characters SET pos_x=-14, pos_y=5, pos_z=312, hp=4 WHERE id=$1', [
    doomed.id,
  ]);
  await db.end();
  ok('fixtures parked (fighter at the dummies, doomed inside the west camp)');

  const browser = await chromium.launch();
  try {
    await runFighter(browser, token);
    await runDoomed(browser, token);
  } finally {
    await browser.close();
  }
  console.log('\n⚔️  P4 browser check passed — enemies, combo, telegraphs, death loop.\n');
};

const runFighter = async (browser, token) => {
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

  await enterWorld(page, 'Arenaprobe', errors);
  ok('fighter in world beside the training line');

  // Enemies stream in with meta + views.
  await page.waitForFunction(
    () => {
      const s = window.__dawned.combatState();
      return s.enemies > 0 && s.enemiesInView > 0;
    },
    { timeout: 60000 },
  );
  const seen = await combatState(page);
  ok(`enemies stream with views (${seen.enemies} in AOI, ${seen.enemiesInView} rendered)`);

  // HUD vitals live.
  const hpText = await page.locator('.hud-hp-text').innerText();
  if (!/\d+ \/ \d+/.test(hpText)) fail(`HP readout wrong: "${hpText}"`);
  ok(`HP globe reads ${hpText}`);
  await shoot(page, 'p4-arena.png');

  // Soft-target: face the nearest dummy and confirm the plate appears.
  await page.evaluate(() => {
    const self = window.__dawned.connection.renderPosition();
    let best = null;
    let bestD = Infinity;
    for (const r of window.__dawned.connection.remotes.values()) {
      if (r.kind !== 1 || !r.enemyMeta) continue;
      const d = Math.hypot(r.render.x - self.x, r.render.z - self.z);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best) {
      window.__dawned.input.yaw = Math.atan2(best.render.x - self.x, best.render.z - self.z);
    }
  });
  await page.waitForFunction(() => window.__dawned.combatState().target !== null, {
    timeout: 20000,
  });
  ok(`soft-target locks (${(await combatState(page)).target})`);

  // Swing the combo at the dummy until damage text appears and its HP drops.
  const dummyHpBefore = await page.evaluate(() => {
    for (const r of window.__dawned.connection.remotes.values()) {
      if (r.enemyMeta?.typeId === 'enemy_training_dummy') return r.render.hpFraction;
    }
    return -1;
  });
  if (dummyHpBefore < 0) fail('no dummy in the remote set');
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__dawned.attack());
    await sleep(550);
  }
  await page.waitForFunction(
    (before) => {
      for (const r of window.__dawned.connection.remotes.values()) {
        if (r.enemyMeta?.typeId === 'enemy_training_dummy' && r.render.hpFraction < before - 0.02) {
          return true;
        }
      }
      return false;
    },
    dummyHpBefore,
    { timeout: 20000 },
  );
  ok('basic combo damages the dummy (hp bar fraction fell)');
  const texts = await combatState(page);
  if (texts.fctTotal === 0) fail('no floating combat text spawned');
  ok(`floating combat text spawns on resolve (${texts.fctTotal} so far)`);

  // MIXER TRUTH: the swing must actually PLAY on the rig — a clip can be
  // requested yet never move a bone (weight 0 / finished-action reuse; the
  // "everything is static" playtest). Assert the action runs with real weight.
  await page.evaluate(() => window.__dawned.attack());
  await page.waitForFunction(
    () => {
      const local = window.__dawned.animDebug().local;
      return (
        local !== null &&
        local.clip.startsWith('Sword_Regular') &&
        local.running &&
        local.weight > 0.5
      );
    },
    { timeout: 5000 },
  );
  ok('swing clip RUNS on the mixer (weight > 0.5, not just requested)');

  // Dodge: the roll must move the character ~4 m AND play the Roll clip.
  const dodgeFrom = await page.evaluate(() => window.__dawned.connection.renderPosition());
  let sawRollClip = false;
  await page.keyboard.down('v');
  for (let i = 0; i < 14 && !sawRollClip; i++) {
    sawRollClip = await page.evaluate(() => {
      const d = window.__dawned.animDebug();
      const local = d.local;
      return d.rollTimeLeft > 0 && local !== null && local.clip === 'Roll' && local.weight > 0.4;
    });
    await sleep(80);
  }
  await page.keyboard.up('v');
  if (!sawRollClip) fail('Roll never played on the mixer during the dodge');
  await sleep(700);
  const dodgeTo = await page.evaluate(() => window.__dawned.connection.renderPosition());
  const rolled = Math.hypot(dodgeTo.x - dodgeFrom.x, dodgeTo.z - dodgeFrom.z);
  if (rolled < 2.5) fail(`dodge displaced only ${rolled.toFixed(2)} m`);
  ok(`dodge rolls with the Roll clip playing (${rolled.toFixed(1)} m)`);

  // R8 REGRESSION — gliding: a swing while MOVING must ride the upper-body
  // overlay with the gait still live on the base layer. (Full-body swings
  // froze the legs; LMB spam while walking slid the rig across the ground.)
  await page.evaluate(() => {
    window.__dawned.input.yaw = Math.PI; // inland — open ground, no water
  });
  await page.keyboard.down('w');
  await sleep(400); // let the view classify the rig as moving
  let movingSwing = null;
  for (let i = 0; i < 20 && !movingSwing; i++) {
    await page.evaluate(() => window.__dawned.attack());
    movingSwing = await page.evaluate(() => {
      const d = window.__dawned.animDebug();
      const gait =
        d.local !== null &&
        (d.local.clip.startsWith('Jog_') ||
          d.local.clip.startsWith('Sprint') ||
          d.local.clip.startsWith('Walk'));
      const swing =
        d.overlay !== null && d.overlay.clip.startsWith('Sword_Regular') && d.overlay.running;
      return gait && swing ? { base: d.local.clip, overlay: d.overlay.clip } : null;
    });
    await sleep(120);
  }
  await page.keyboard.up('w');
  if (!movingSwing) fail('moving swing must overlay over a live gait (gliding regression)');
  ok(`moving swing overlays the gait (${movingSwing.overlay} over ${movingSwing.base})`);

  // R8 REGRESSION — roll priority: a dodge DURING a standing swing must show
  // Roll immediately; the swing's action lock may not swallow it.
  await sleep(600); // stand down: decel + dodge cooldown + stamina headroom
  await page.waitForFunction(
    () => {
      window.__dawned.attack();
      const local = window.__dawned.animDebug().local;
      return local !== null && local.clip.startsWith('Sword_Regular') && local.running;
    },
    undefined,
    { timeout: 10000 },
  );
  await page.keyboard.down('v');
  await sleep(200);
  const midSwingRoll = await page.evaluate(() => {
    const local = window.__dawned.animDebug().local;
    return local !== null && local.clip === 'Roll';
  });
  await page.keyboard.up('v');
  if (!midSwingRoll) fail('dodge during a swing must preempt the action lock with Roll');
  ok('dodge preempts a mid-swing action lock (Roll within 200 ms)');
  await shoot(page, 'p4-dummy-fight.png');

  // March to the glub camp, pick the fight by damage, expect a telegraph +
  // incoming damage.
  await page.evaluate(() => {
    window.__dawned.input.yaw = Math.PI; // inland, toward the camp
  });
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => {
      const p = window.__dawned.connection.renderPosition();
      return p.z < 338;
    },
    { timeout: 60000 },
  );
  await page.keyboard.up('w');
  await page.waitForFunction(
    () => {
      const self = window.__dawned.connection.renderPosition();
      for (const r of window.__dawned.connection.remotes.values()) {
        if (r.enemyMeta?.typeId === 'enemy_shore_glub' && (r.render.flags & (1 << 7)) === 0) {
          if (Math.hypot(r.render.x - self.x, r.render.z - self.z) < 12) return true;
        }
      }
      return false;
    },
    { timeout: 30000 },
  );
  // Face and poke the nearest glub — damage-aggro is unconditional.
  await page.evaluate(() => {
    const self = window.__dawned.connection.renderPosition();
    let best = null;
    let bestD = Infinity;
    for (const r of window.__dawned.connection.remotes.values()) {
      if (r.enemyMeta?.typeId !== 'enemy_shore_glub') continue;
      const d = Math.hypot(r.render.x - self.x, r.render.z - self.z);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best) {
      window.__dawned.input.yaw = Math.atan2(best.render.x - self.x, best.render.z - self.z);
    }
    window.__dawned.attack();
  });
  const hpBefore = (await combatState(page)).hp;
  await page.waitForFunction((before) => window.__dawned.combatState().hp < before, hpBefore, {
    timeout: 45000,
  });
  ok(`glubs fight back (hp ${hpBefore} → ${(await combatState(page)).hp})`);

  // Enemy swings must RUN on their mixers (windup + recover flow, not a
  // clamped freeze) — watch the camp until an ability clip is live.
  await page.waitForFunction(
    () => {
      for (const enemy of Object.values(window.__dawned.animDebug().enemies)) {
        const clip = enemy.clip.replace('CharacterArmature|', '');
        if ((clip === 'Headbutt' || clip === 'Punch') && enemy.running) return true;
      }
      return false;
    },
    { timeout: 45000 },
  );
  ok('enemy ability clips run on their mixers (windups animate)');

  // THE round-6 regression: swinging while the camp wails on you. Incoming
  // flinches must overlay, never preempt — the swing action keeps running.
  await page.waitForFunction(
    () => {
      window.__dawned.attack();
      const local = window.__dawned.animDebug().local;
      return (
        local !== null &&
        local.clip.startsWith('Sword_Regular') &&
        local.running &&
        local.weight > 0.5
      );
    },
    { timeout: 20000 },
  );
  ok('swings still play WHILE taking camp fire (flinches overlay, not replace)');

  await page.waitForFunction(() => window.__dawned.combatState().telegraphs > 0, {
    timeout: 45000,
  });
  ok('heavy attack draws its telegraph decal');
  await shoot(page, 'p4-camp-fight.png');

  const realErrors = errors.filter((line) => !/status of 401/.test(line));
  if (realErrors.length > 0) fail(`console errors:\n  ${realErrors.slice(0, 5).join('\n  ')}`);
  ok('fighter phase: no console errors');
  await context.close();
};

const runDoomed = async (browser, token) => {
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

  await enterWorld(page, 'Arenadoom', errors);
  ok('doomed character resumes inside the west camp');

  // The camp finishes it → the death clip PLAYS (round 6: dying used to leave
  // the rig standing bolt upright) → then the soul screen fades in.
  await page.waitForFunction(() => window.__dawned.combatState().dead, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const local = window.__dawned.animDebug().local;
      return local !== null && local.clip === 'Death01' && local.weight > 0.5;
    },
    { timeout: 5000 },
  );
  ok('death clip plays on the rig (Death01, real weight)');
  await shoot(page, 'p4-death-beat.png');
  await page.waitForSelector('.hud-death:not([hidden])', { timeout: 15000 });
  ok('death: soul screen up after the beat, controls parked');
  await shoot(page, 'p4-soul-screen.png');

  await page.click('.hud-death-button');
  await page.waitForFunction(
    () => {
      const s = window.__dawned.combatState();
      return !s.dead && s.hp === s.maxHp;
    },
    { timeout: 20000 },
  );
  const back = await page.evaluate(() => {
    const p = window.__dawned.connection.renderPosition();
    return Math.hypot(p.x - 0, p.z - 400);
  });
  if (back > 30) fail(`respawned ${back.toFixed(0)} m from the shrine`);
  const dawned = await combatState(page);
  if (dawned.dawnedMs <= 0) fail('no Dawned debuff after respawn');
  await page.waitForSelector('.hud-dawned:not([hidden])', { timeout: 10000 });
  ok(`respawn at the shrine, Dawned for ${(dawned.dawnedMs / 1000).toFixed(0)} s (chip shown)`);
  await shoot(page, 'p4-respawn-dawned.png');

  const realErrors = errors.filter((line) => !/status of 401/.test(line));
  if (realErrors.length > 0) fail(`console errors:\n  ${realErrors.slice(0, 5).join('\n  ')}`);
  ok('doomed phase: no console errors');
  await context.close();
};

main().catch((error) => {
  console.error(
    `\n❌ ${error instanceof SmokeFailure ? error.message : `unexpected: ${error.stack ?? error.message}`}\n`,
  );
  process.exit(1);
});
