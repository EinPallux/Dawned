#!/usr/bin/env node
/**
 * P3 client-feel check, in a real browser: swim state + animation, chat bubbles,
 * the lag lab, and seamless reconnect inside the server's 15 s grace window.
 *
 * The fixture character is pre-positioned in the dev island's mountain lake
 * (deep water) straight in Postgres — there is deliberately no API for writing
 * positions, so this dev-only smoke talks to the same local database the dev
 * server uses. Pass a DATABASE_URL env var to override the dev default.
 *
 * Usage: node tools/smoke/browser-p3.mjs [http://localhost:5173] [--screenshots DIR]
 * Requires: game server (:8081), client dev server, local Postgres.
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

/** Dev-1 mountain lake center (meta.json `lake`): ~7 m of water above ground. */
const LAKE = { x: -150, y: 17, z: -70 };

const ok = (message) => console.log(`✅ ${message}`);
class SmokeFailure extends Error {}
const fail = (message) => {
  throw new SmokeFailure(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const anim = (page) => page.evaluate(() => window.__dawned.animState());
const hudText = (page) => page.locator('.hud-stats').innerText();

const shoot = async (page, name) => {
  if (!SHOT_DIR) return;
  try {
    await mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, name), timeout: 30000 });
  } catch (error) {
    console.warn(`⚠️  screenshot ${name} skipped (${error.message.split('\n')[0]})`);
  }
};

const main = async () => {
  console.log(`Dawned P3 browser check → ${BASE_URL}\n`);

  // Fixture: account + character parked in the lake before the browser joins.
  const apiBase = new URL(BASE_URL).origin;
  const token = await ensureAccount(apiBase, 'zz_p3_lake', PASSWORD);
  const character = await ensureCharacter(apiBase, token, 'Lakediver', 'mage');
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query('UPDATE characters SET pos_x = $1, pos_y = $2, pos_z = $3 WHERE id = $4', [
    LAKE.x,
    LAKE.y,
    LAKE.z,
    character.id,
  ]);
  await db.end();
  ok(`fixture "${character.name}" parked in the lake at (${LAKE.x}, ${LAKE.z})`);

  const browser = await chromium.launch();
  try {
    await run(browser, token, character);
  } finally {
    await browser.close();
  }
  console.log('\n🌅 P3 browser check passed — swim, bubbles, lag lab, reconnect.\n');
};

const run = async (browser, token, character) => {
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

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  try {
    await page.click(`.char-card:has-text("${character.name}")`, { timeout: 60000 });
    await page.click('.btn--primary:has-text("ENTER WORLD")', { timeout: 60000 });
    await page.waitForSelector('.hud', { timeout: 90000 });
    await page.waitForFunction(
      () => document.querySelector('.hud-status')?.textContent?.includes('in world'),
      { timeout: 90000 },
    );
  } catch (error) {
    fail(
      `never reached the world (${error.message.split('\n')[0]})` +
        (errors.length ? `; page errors:\n  ${errors.slice(0, 5).join('\n  ')}` : ''),
    );
  }
  ok('joined the world inside the lake');

  // Record every HUD status change — fps-independent proof of the reconnect flow.
  await page.evaluate(() => {
    window.__statusLog = [];
    const el = document.querySelector('.hud-status');
    if (el) {
      new MutationObserver(() => window.__statusLog.push(el.textContent ?? '')).observe(el, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  });

  // --- Swimming: state + idle/forward clips ---------------------------------
  await page.waitForFunction(
    () => document.querySelector('.hud-stats')?.textContent?.includes('swimming'),
    { timeout: 30000 },
  );
  ok('HUD reports the swimming state (server + prediction agree we are in water)');
  // The rig may still be loading right after join — give the composed swap time.
  await page.waitForFunction(() => window.__dawned.animState().local.startsWith('Swim_'), {
    timeout: 30000,
  });
  const idle = await anim(page);
  if (idle.local !== 'Swim_Idle_Loop') fail(`expected Swim_Idle_Loop, got "${idle.local}"`);
  ok('idle in water plays Swim_Idle_Loop');
  await shoot(page, 'p3-swim-idle.png');

  await page.locator('canvas.game').click();
  await page.keyboard.down('w');
  await sleep(2500);
  const swimming = await anim(page);
  await page.keyboard.up('w');
  if (swimming.local !== 'Swim_Fwd_Loop') fail(`expected Swim_Fwd_Loop, got "${swimming.local}"`);
  ok('swimming forward plays Swim_Fwd_Loop');
  await shoot(page, 'p3-swim-fwd.png');

  // --- Chat bubble ----------------------------------------------------------
  await page.evaluate(() => window.__dawned.connection.sendChat('Ahoy from the lake! 🌊'));
  await page.waitForFunction(() => window.__dawned.animState().localBubble, { timeout: 10000 });
  ok('own chat line shows as a bubble overhead');
  await shoot(page, 'p3-chat-bubble.png');

  // --- Lag lab + netgraph ---------------------------------------------------
  const stats = await hudText(page);
  if (!stats.includes('kbps')) fail(`netgraph throughput line missing from HUD:\n${stats}`);
  if (!/snaps\s+\d+ · \d+ ms gap/.test(stats)) {
    fail(`snapshot-interval line missing from HUD:\n${stats}`);
  }
  ok('netgraph shows throughput and snapshot cadence');

  // A large injection (600 ms) so the signal clears the noise floor of software
  // rendering (main-thread stalls inflate every RTT sample here); the wait polls
  // until a pong that crossed the injected delay actually lands.
  const baseRtt = await page.evaluate(() => window.__dawned.connection.rttMs);
  await page.evaluate(() => window.__dawned.connection.setNetsim(600, 0));
  try {
    await page.waitForFunction((base) => window.__dawned.connection.rttMs >= base + 400, baseRtt, {
      timeout: 25000,
    });
  } catch {
    const rtt = await page.evaluate(() => window.__dawned.connection.rttMs);
    fail(`netsim(600) did not raise RTT (${baseRtt.toFixed(0)} → ${rtt.toFixed(0)} ms)`);
  }
  const laggedRtt = await page.evaluate(() => window.__dawned.connection.rttMs);
  if (!(await hudText(page)).includes('netsim')) fail('active netsim not surfaced in the HUD');
  await page.evaluate(() => window.__dawned.connection.setNetsim(0, 0));
  ok(`lag lab injects latency (RTT ${baseRtt.toFixed(0)} → ${laggedRtt.toFixed(0)} ms) and resets`);

  // --- Reconnect inside the grace window ------------------------------------
  const beforeId = await page.evaluate(() => window.__dawned.connection.selfId);
  const beforePos = await page.evaluate(() => {
    const p = window.__dawned.connection.predicted;
    return { x: p.x, z: p.z };
  });
  await page.evaluate(() => window.__dawned.connection['socket'].close());
  // Wait for the reconnect to START before waiting for it to finish — polling
  // for "in world" immediately would match the stale pre-close status text.
  await page.waitForFunction(() => window.__statusLog.some((s) => s.includes('reconnecting')), {
    timeout: 15000,
  });
  ok('socket loss surfaced as reconnecting (status + banner)');
  await page.waitForFunction(() => window.__dawned.connection.status === 'playing', {
    timeout: 20000,
  });
  const afterId = await page.evaluate(() => window.__dawned.connection.selfId);
  const afterPos = await page.evaluate(() => {
    const p = window.__dawned.connection.predicted;
    return { x: p.x, z: p.z };
  });
  if (afterId !== beforeId) fail(`reconnect changed entity id ${beforeId} → ${afterId}`);
  const drift = Math.hypot(afterPos.x - beforePos.x, afterPos.z - beforePos.z);
  if (drift > 0.5) fail(`reconnect moved the character ${drift.toFixed(2)} m`);
  const banner = await page.locator('.hud-banner').isHidden();
  if (!banner) fail('reconnect banner still visible after resuming');
  ok(`socket loss auto-reconnected onto entity #${afterId} in place (${drift.toFixed(2)} m drift)`);

  // --- Back ashore: /stuck + a grounded 8-way clip --------------------------
  await page.evaluate(() => window.__dawned.connection.sendChat('/stuck'));
  await page.waitForFunction(() => !window.__dawned.animState().local.startsWith('Swim_'), {
    timeout: 15000,
  });
  ok('/stuck recalled the character ashore');

  // --- Controls: D must strafe toward SCREEN RIGHT (−X at yaw 0) ------------
  // The whole-stack proof of the A/D mapping: real key, real intent, real sim.
  await page.evaluate(() => {
    window.__dawned.input.yaw = 0;
  });
  await page.keyboard.down('d');
  // Movement resumes only once the spawn chunks finish streaming — wait for
  // real velocity before measuring the direction.
  await page.waitForFunction(
    () => {
      const p = window.__dawned.connection.predicted;
      return Math.hypot(p.vx, p.vz) > 2;
    },
    { timeout: 30000 },
  );
  const beforeStrafe = await page.evaluate(() => ({ ...window.__dawned.connection.predicted }));
  await sleep(1200);
  await page.keyboard.up('d');
  await sleep(300);
  const afterStrafe = await page.evaluate(() => ({ ...window.__dawned.connection.predicted }));
  const dx = afterStrafe.x - beforeStrafe.x;
  if (dx > -1) fail(`D strafed the wrong way (Δx ${dx.toFixed(2)} — screen right at yaw 0 is −X)`);
  ok(`D strafes screen-right (Δx ${dx.toFixed(1)} m at yaw 0)`);

  // --- Forward run uses the sprint gait + sub-tick extrapolation ------------
  // Face INLAND (spawn yaw π) — running seaward would pile into the shoreline
  // block mid-test and zero the velocity the probes below depend on.
  await page.evaluate(() => {
    window.__dawned.input.yaw = Math.PI;
  });
  await page.keyboard.down('w');
  await page.waitForFunction(() => window.__dawned.animState().local === 'Sprint_Loop', {
    timeout: 15000,
  });
  ok('forward run plays the sprint-gait cycle (no more half-speed jog skating)');

  const extrapolation = await page.evaluate(() => {
    const c = window.__dawned.connection;
    const now = c.renderPosition(0);
    const ahead = c.renderPosition(25);
    return Math.hypot(ahead.x - now.x, ahead.z - now.z);
  });
  if (extrapolation < 0.05 || extrapolation > 0.25) {
    fail(`sub-tick extrapolation looks wrong (${(extrapolation * 100).toFixed(1)} cm over 25 ms)`);
  }
  ok(`local render extrapolates between ticks (${(extrapolation * 100).toFixed(1)} cm / 25 ms)`);

  // Grounded-state stability: the spawn meadow slopes — before the shared
  // ground snap, every downhill tick flipped airborne and the HUD/animations
  // flickered. Sample while the run continues inland.
  const groundedSamples = await page.evaluate(async () => {
    const results = [];
    for (let i = 0; i < 30; i++) {
      results.push(window.__dawned.connection.predicted.grounded);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return results;
  });
  await page.keyboard.up('w');
  const airborneCount = groundedSamples.filter((grounded) => !grounded).length;
  if (airborneCount > 0) {
    fail(`grounded state flickered ${airborneCount}/30 samples during a sloped run`);
  }
  ok('grounded state holds steady across a sloped run (no airborne flicker)');
  await sleep(400);

  // Hold the diagonal and wait for the jog to engage — right after the recall
  // the spawn chunks may still be streaming in, and movement (correctly) waits.
  await page.keyboard.down('s');
  await page.keyboard.down('d');
  let diagonal = { local: '' };
  try {
    await page.waitForFunction(() => window.__dawned.animState().local.startsWith('Jog_'), {
      timeout: 25000,
    });
    diagonal = await anim(page);
  } finally {
    await page.keyboard.up('s');
    await page.keyboard.up('d');
  }
  if (!diagonal.local.startsWith('Jog_Bwd_')) {
    fail(`backward-diagonal input plays "${diagonal.local}" (want a Jog_Bwd_* clip)`);
  }
  ok(`8-way locomotion picks diagonal clips (${diagonal.local})`);

  // --- Sprint lean: sustained turning at sprint speed banks into the turn.
  // Yaw is driven directly (public field) — pointer lock is unreliable headless.
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.evaluate(() => {
    window.__leanTimer = setInterval(() => {
      window.__dawned.input.yaw += 0.4; // ≈1.6 rad/s at this cadence
    }, 250);
  });
  let lean = { local: '' };
  try {
    await page.waitForFunction(() => window.__dawned.animState().local.startsWith('Jog_Fwd_Lean'), {
      timeout: 25000,
    });
    lean = await anim(page);
  } finally {
    await page.evaluate(() => clearInterval(window.__leanTimer));
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
  }
  if (!lean.local.startsWith('Jog_Fwd_Lean')) {
    fail(`sprint turn never leaned (stuck on "${lean.local}")`);
  }
  ok(`sprint turns bank into the lean clips (${lean.local})`);

  if (errors.length > 0) fail(`console errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
  ok('no console errors');
};

main().catch((error) => {
  console.error(
    `\n❌ ${error instanceof SmokeFailure ? error.message : `unexpected error: ${error.stack ?? error.message}`}\n`,
  );
  process.exitCode = 1;
});
