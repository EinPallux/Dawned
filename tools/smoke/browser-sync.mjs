#!/usr/bin/env node
/**
 * Browser-level check: two real Chromium pages log in, pick their characters and
 * join the world; one walks, and each must see the other move. The P0 Definition
 * of Done carried through the P1 authenticated front door — re-run after every
 * netcode or menu change.
 *
 * Accounts/characters are provisioned over REST; the session token is injected
 * before load, so the pages exercise the real bootstrap → character select →
 * enter-world path (register/create UI has its own coverage in P1's manual DoD).
 *
 * Usage: node tools/smoke/browser-sync.mjs [http://localhost:5173] [--screenshots DIR]
 * Requires the game server and the client dev server (or a built client) to be running.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5173';
const shotIndex = process.argv.indexOf('--screenshots');
const SHOT_DIR = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;
const PASSWORD = 'smoke-pass-123456';

const ok = (message) => console.log(`✅ ${message}`);
class SmokeFailure extends Error {}
const fail = (message) => {
  throw new SmokeFailure(message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Time allowed for remote views to converge after movement stops. */
const SETTLE_MS = 3000;
/** Walk long enough that interpolation lag is noise, not signal (≥25 m at sprint). */
const WALK_MS = 4000;

/** Read the HUD's live position readout. */
const readPosition = async (page) => {
  const text = await page.locator('.hud-stats').innerText();
  const match = /pos\s+(-?\d+\.\d+), (-?\d+\.\d+), (-?\d+\.\d+)/.exec(text);
  if (!match) fail(`could not parse position from HUD:\n${text}`);
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
};

const readStat = async (page, label) => {
  const text = await page.locator('.hud-stats').innerText();
  const match = new RegExp(`${label}\\s+(\\d+)`).exec(text);
  return match ? Number(match[1]) : 0;
};

const joinWorld = async (browser, accountName, characterName) => {
  const apiBase = new URL(BASE_URL).origin;
  const token = await ensureAccount(apiBase, accountName, PASSWORD);
  const character = await ensureCharacter(apiBase, token, characterName, 'warrior');

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // Session token in place before the app boots → bootstrap resumes straight to
  // character select, the same path a returning player takes.
  await page.addInitScript((sessionToken) => {
    localStorage.setItem('dawned.token', sessionToken);
  }, token);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  // Generous timeouts: under software WebGL (CI containers) two concurrent
  // clients render at a few fps and terrain meshes build one per frame, so a
  // busy main thread can stall even the click dispatch.
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
      `${accountName} never reached the world (${error.message.split('\n')[0]})` +
        (errors.length ? `; page errors:\n  ${errors.slice(0, 5).join('\n  ')}` : ''),
    );
  }
  return { page, context, errors, name: character.name };
};

const main = async () => {
  console.log(`Dawned browser check → ${BASE_URL}\n`);
  const browser = await chromium.launch();
  try {
    await run(browser);
  } finally {
    // Always close: leaving Chromium open keeps the event loop alive and turns a
    // clean assertion failure into an opaque hang.
    await browser.close();
  }
  console.log('\n🌅 Browser check passed — two authenticated browsers, one world.\n');
};

const run = async (browser) => {
  const walker = await joinWorld(browser, 'zz_browser_walker', 'Browserwalker');
  const watcher = await joinWorld(browser, 'zz_browser_watcher', 'Browserwatcher');
  ok('two browser clients logged in, picked characters and reached the world');

  // Both must list each other in the roster panel.
  await sleep(600);
  const walkerRoster = await walker.page.locator('.hud-roster').innerText();
  const watcherRoster = await watcher.page.locator('.hud-roster').innerText();
  if (!walkerRoster.includes(watcher.name)) fail(`walker roster missing watcher: ${walkerRoster}`);
  if (!watcherRoster.includes(walker.name)) fail(`watcher roster missing walker: ${watcherRoster}`);
  ok('each client lists the other in its roster');

  const startPos = await readPosition(walker.page);
  // What the watcher renders the walker at, before any movement.
  const watcherViewBefore = await watcher.page.evaluate(() => window.__dawned.remoteSnapshot());
  if (!watcherViewBefore[walker.name]) {
    fail(`watcher does not render the walker at all: ${JSON.stringify(watcherViewBefore)}`);
  }

  // Walk the first client forward with sprint held.
  await walker.page.locator('canvas.game').click(); // focus the canvas
  await walker.page.keyboard.down('Shift');
  await walker.page.keyboard.down('w');
  await sleep(WALK_MS);
  await walker.page.keyboard.up('w');
  await walker.page.keyboard.up('Shift');
  // Let the world settle: while the walker is moving, every remote view is
  // legitimately behind (network + the deliberate interpolation delay). Comparing
  // positions is only meaningful once movement has stopped and views converge.
  await sleep(SETTLE_MS);

  const endPos = await readPosition(walker.page);
  const travelled = Math.hypot(endPos.x - startPos.x, endPos.z - startPos.z);
  if (travelled < 4) {
    fail(
      `walker did not move in the browser (${travelled.toFixed(2)} m) — input or prediction broken`,
    );
  }
  ok(`walker moved ${travelled.toFixed(2)} m under keyboard control`);

  // Snapshots must be flowing on both, and hard snaps must be rare/zero.
  const snapshots = await readStat(walker.page, 'snaps');
  if (snapshots < 20) fail(`walker only received ${snapshots} snapshots`);
  const hardSnaps = await readStat(walker.page, 'hard');
  ok(`${snapshots} snapshots received, ${hardSnaps} hard corrections (want 0)`);
  if (hardSnaps > 2)
    fail(`too many hard position snaps (${hardSnaps}) — prediction disagrees with the server`);

  // The watcher must have seen the walker move, in its own interpolated view.
  // (Pixel-diffing the canvas is useless here: without preserveDrawingBuffer,
  // toDataURL on a WebGL canvas returns a blank image and would pass vacuously.)
  const watcherViewAfter = await watcher.page.evaluate(() => window.__dawned.remoteSnapshot());
  const seenBefore = watcherViewBefore[walker.name];
  const seenAfter = watcherViewAfter[walker.name];
  if (!seenAfter) fail('watcher lost track of the walker mid-test');
  const seenTravel = Math.hypot(seenAfter.x - seenBefore.x, seenAfter.z - seenBefore.z);
  ok(
    `watcher observed the walker travel ${seenTravel.toFixed(2)} m (walker: ${travelled.toFixed(2)} m)`,
  );
  if (seenTravel < 4) {
    fail(
      `watcher did not see the walker move (${seenTravel.toFixed(2)} m) — replication is broken`,
    );
  }
  // Distances must match closely; a systematic mismatch means replication is
  // dropping or duplicating motion rather than merely lagging it.
  const travelRatio = seenTravel / travelled;
  if (travelRatio < 0.8 || travelRatio > 1.2) {
    fail(
      `travel mismatch: watcher saw ${seenTravel.toFixed(2)} m vs the walker's ${travelled.toFixed(2)} m`,
    );
  }

  // Once settled, the two views must converge on the same spot.
  const viewGap = Math.hypot(seenAfter.x - endPos.x, seenAfter.z - endPos.z);
  ok(`views converged to within ${viewGap.toFixed(2)} m after settling`);
  if (viewGap > 1.0)
    fail(`views disagree by ${viewGap.toFixed(2)} m at rest — interpolation or replication is off`);

  if (SHOT_DIR) {
    // Screenshots are a nicety, not an assertion: capturing a WebGL page under
    // software rendering can stall for a long time, so never let it fail the run.
    try {
      await mkdir(SHOT_DIR, { recursive: true });
      await walker.page.screenshot({ path: path.join(SHOT_DIR, 'walker.png'), timeout: 30000 });
      await watcher.page.screenshot({ path: path.join(SHOT_DIR, 'watcher.png'), timeout: 30000 });
      ok(`screenshots written to ${SHOT_DIR}`);
    } catch (error) {
      console.warn(`⚠️  screenshots skipped (${error.message.split('\n')[0]})`);
    }
  }

  const allErrors = [...walker.errors, ...watcher.errors];
  if (allErrors.length > 0) {
    fail(`console errors in the browser:\n  ${allErrors.slice(0, 5).join('\n  ')}`);
  }
  ok('no console errors in either client');

  // Walk back so the persisted position stays near spawn for the next run.
  await walker.page.keyboard.down('Shift');
  await walker.page.keyboard.down('s');
  await sleep(WALK_MS);
  await walker.page.keyboard.up('s');
  await walker.page.keyboard.up('Shift');
};

main().catch(async (error) => {
  console.error(
    `\n❌ ${error instanceof SmokeFailure ? error.message : `unexpected error: ${error.stack ?? error.message}`}\n`,
  );
  process.exitCode = 1;
});
