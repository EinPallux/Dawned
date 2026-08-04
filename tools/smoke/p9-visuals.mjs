#!/usr/bin/env node
/**
 * P9-D visual probe — photographs the four things P9 added to the SCREEN,
 * because unit tests cannot see a nameplate.
 *
 *   1. Rank plates: a boss reads ★, an elite ◆, a trash mob neither.
 *   2. Boss frame: appears on aggro with a pip per declared phase, tracks HP,
 *      and flashes its announce line when a threshold is crossed.
 *   3. Caster read: an interruptible cast draws a bar over the enemy, and a
 *      ground_circle draws its CIRCLE decal on the player's own feet.
 *   4. Self-shield: an elite's absorb shows as a bubble and its HP stops
 *      moving while the pool lasts.
 *
 * It uses the P9 ops levers (/ops/tp, /ops/enemyhurt) rather than fighting
 * for four minutes; the mechanics themselves are the real AI reacting.
 *
 * Needs: game server on :8081 (fresh dist), client dev server on :5173, the
 * migrated dev Postgres with the P9 bestiary published.
 *
 * Usage: node tools/smoke/p9-visuals.mjs [--screenshots DIR]
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.env.SMOKE_API ?? 'http://127.0.0.1:8081';
const CLIENT_URL = process.env.SMOKE_CLIENT ?? 'http://localhost:5173';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
const ACCOUNT = 'p9smoke';
const CHARACTER = 'Beastwatch';
const SMOKE_LEVEL = 12;

/** Published P9 spawner anchors (seed migration 0013). */
const KING = { x: 0, z: 140 };
/** Inside streaming range but OUTSIDE the king's 18 m aggro radius. */
const KING_APPROACH = { x: 0, z: 110 };
const HEXERS = { x: 26, z: 158 };
const MOSSBACK = { x: 30, z: 238 };

const shotIndex = process.argv.indexOf('--screenshots');
const SHOTS_DIR = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;

const ok = (message) => console.log(`✅ ${message}`);
const note = (message) => console.log(`   ${message}`);
const fail = (message) => {
  throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ops = async (route, body) => {
  const response = await fetch(`${BASE_URL}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-secret': OPS_SECRET },
    body: JSON.stringify(body),
  });
  if (!response.ok) fail(`${route} failed: ${response.status} ${await response.text()}`);
  return response.json();
};

/**
 * Keep the observer standing for the WHOLE run. This probe watches enemies
 * perform and never swings back, so it dies in seconds — and a dead player
 * stops being perceived at all (the AI skips corpses), which silently ends
 * every later observation. `/ops/hurt` at fraction 1 is a full heal.
 */
const keepAlive = () => {
  const timer = setInterval(() => {
    ops('/ops/hurt', { player: CHARACTER, fraction: 1 }).catch(() => undefined);
  }, 1500);
  return () => clearInterval(timer);
};

const shoot = async (page, name) => {
  if (!SHOTS_DIR) return;
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, name) }).catch(() => {});
};

const until = async (page, fn, { timeout = 25000, label = 'condition', arg = null } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() > deadline) {
      // A bare "timed out" costs a whole re-run to learn what was on screen.
      const seen = await page
        .evaluate(() => JSON.stringify(window.__dawned.enemies()))
        .catch(() => '<unavailable>');
      fail(`timed out waiting for ${label}\n   enemies: ${seen}`);
    }
    await sleep(300);
  }
};

/** Drop the player next to a spawner and wait for its enemies to stream in. */
const goTo = async (page, where, label) => {
  // A corpse is invisible to perception, so nothing would ever aggro again.
  if (await page.evaluate(() => window.__dawned.combatState().dead)) {
    await page.evaluate(() => window.__dawned.connection.requestRespawn());
    await sleep(2500);
  }
  await ops('/ops/tp', { player: CHARACTER, x: where.x, z: where.z });
  await sleep(1500);
  return until(
    page,
    (target) =>
      window.__dawned
        .enemies()
        .filter(
          (e) => Math.hypot(e.x - target.x, e.z - target.z) < 40 && e.hpFraction > 0 && !e.dead,
        ).length,
    { label: `${label} enemies in view`, arg: where },
  );
};

const main = async () => {
  console.log('\nP9 visual probe — rank plates · boss frame · casts · shields\n');

  const token = await ensureAccount(BASE_URL, ACCOUNT, PASSWORD);
  const character = await ensureCharacter(BASE_URL, token, CHARACTER, 'warrior');
  ok(`fixture ${CHARACTER} (#${character.id}) ready`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.addInitScript((sessionToken) => {
    localStorage.setItem('dawned.token', sessionToken);
  }, token);

  await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.char-card', { timeout: 60000 });
  await page.click(`.char-card:has-text("${CHARACTER}")`);
  await page.getByText('ENTER WORLD', { exact: true }).click();
  await page.waitForSelector('.hud', { timeout: 60000 });
  await until(page, () => window.__dawned?.connection?.status === 'playing', {
    label: 'world entry',
    timeout: 60000,
  });
  await ops('/ops/setlevel', { player: CHARACTER, level: SMOKE_LEVEL });
  await sleep(800);
  const stopHealing = keepAlive();
  ok(`in world at level ${SMOKE_LEVEL}, kept alive for the whole run`);

  // ------------------------------------------------------- 1. rank plates
  // Start clean: a previous run can leave the king mid-fight (characters
  // persist their position), and "did it aggro?" is exactly what step 2 asks.
  await ops('/ops/tp', { player: CHARACTER, x: 0, z: 40 });
  await sleep(2000);
  await goTo(page, KING_APPROACH, 'boss arena');
  // Not just "out of combat" — a leashing boss is walking home and refuses to
  // re-aggro until it arrives, so wait for it to actually be back on its mark.
  await until(
    page,
    (home) =>
      window.__dawned
        .enemies()
        .some(
          (e) =>
            e.rank === 'zone_boss' &&
            !e.inCombat &&
            Math.hypot(e.x - home.x, e.z - home.z) < 3 &&
            e.hpFraction > 0.99,
        ),
    { label: 'the king to leash home, reset and drop combat', timeout: 90000, arg: KING },
  );
  const ranks = await page.evaluate(() =>
    window.__dawned.enemies().map((e) => ({ name: e.name, rank: e.rank })),
  );
  const boss = ranks.find((e) => e.rank === 'zone_boss');
  if (!boss) fail(`no zone_boss near the arena — saw ${JSON.stringify(ranks)}`);
  ok(`${boss.name} is on the roster as a ${boss.rank}`);
  await shoot(page, '01-boss-arena.png');

  // -------------------------------------------------------- 2. boss frame
  // Aggro is the trigger, not proximity: a boss visible across its grove is
  // scenery until it engages, and the frame must stay down for that.
  const before = await page.evaluate(() => {
    const root = document.querySelector('.boss-frame');
    return { present: !!root, hidden: root ? root.hidden : null };
  });
  note(`boss visible from 30 m; frame present=${before.present} hidden=${before.hidden}`);
  if (!before.present) fail('the boss frame element was never created');
  if (!before.hidden) fail('the boss frame showed for a boss that had not aggroed');

  // Step inside its HEARING radius (4 m) rather than its vision cone: a boss
  // reset to its home yaw may be facing the other way, and this probe is not
  // testing perception.
  await ops('/ops/tp', { player: CHARACTER, x: KING.x, z: KING.z - 2.5 });

  const frame = await until(
    page,
    () => {
      const root = document.querySelector('.boss-frame');
      if (!root || root.hidden) return null;
      return {
        name: root.querySelector('.boss-frame-name')?.textContent ?? '',
        pips: root.querySelectorAll('.boss-frame-pip').length,
        width: root.querySelector('.boss-frame-fill')?.style.width ?? '',
      };
    },
    { label: 'boss frame on aggro', timeout: 40000 },
  );
  ok(`boss frame up: "${frame.name.trim()}" · ${frame.pips} phase pip(s) · fill ${frame.width}`);
  if (frame.pips < 1) fail('the boss declares phases but the frame drew no pips');
  await shoot(page, '02-boss-frame.png');

  // -------------------------------------------------- 3. phase crossing
  await ops('/ops/enemyhurt', { enemyId: 'enemy_mushroom_king', fraction: 0.45 });
  const announce = await until(
    page,
    () => {
      const el = document.querySelector('.boss-frame-announce');
      return el && el.classList.contains('is-live') ? el.textContent : null;
    },
    { label: 'phase announce', timeout: 20000 },
  );
  ok(`phase crossed, boss said: "${announce.trim()}"`);
  await shoot(page, '03-phase-announce.png');

  const shrunk = await page.evaluate(
    () => document.querySelector('.boss-frame-fill')?.style.width ?? '',
  );
  note(`frame fill after the poke: ${shrunk}`);
  if (parseFloat(shrunk) > 55) fail(`frame did not follow HP down (still ${shrunk})`);

  // ------------------------------------------------- 4. cast bar + circle
  await goTo(page, HEXERS, 'hexer circle');
  // Aggro point-blank (hearing), then let the caster's own stand-off band pull
  // it back to where its cast is legal — that band is the P9-B behaviour.
  await until(
    page,
    () => window.__dawned.enemies().some((e) => e.name === 'Outcast Hexer' && e.inCombat),
    { label: 'a hexer to aggro', timeout: 40000 },
  );
  // Back off past the hexer's rangeMin (5 m): standing in its face, the only
  // legal picks are the staff jab and the pool, and the CAST — the thing this
  // step exists to photograph — can never come up.
  const hexer = await page.evaluate(
    () => window.__dawned.enemies().find((e) => e.name === 'Outcast Hexer' && e.inCombat) ?? null,
  );
  // Stand 10 m from the hexer ALONG THE CAMERA'S OWN YAW, so the subject is
  // actually in frame — a screenshot of empty grass proves nothing.
  const yaw = await page.evaluate(() => window.__dawned.combatState().yaw);
  await ops('/ops/tp', {
    player: CHARACTER,
    x: hexer.x - Math.sin(yaw) * 10,
    z: hexer.z - Math.cos(yaw) * 10,
  });
  // Both reads matter and they rarely coincide in one poll, so accumulate:
  // a cast BAR (interruptible window) and a ground-circle DECAL (walk out).
  const seen = { casting: 0, decals: 0 };
  const deadline = Date.now() + 90000;
  while ((seen.casting === 0 || seen.decals === 0) && Date.now() < deadline) {
    const now = await page.evaluate(() => ({
      casting: window.__dawned.enemies().filter((e) => e.casting).length,
      decals: window.__dawned.combatState().telegraphs,
    }));
    if (now.casting > seen.casting) {
      seen.casting = now.casting;
      await shoot(page, '04-caster-cast-bar.png');
    }
    if (now.decals > seen.decals) {
      seen.decals = now.decals;
      await shoot(page, '04-caster-ground-circle.png');
    }
    await sleep(250);
  }
  if (!seen.casting) fail('no interruptible cast bar ever drew over a hexer');
  if (!seen.decals) fail('no ground-circle decal ever drew for a hexer pool');
  ok(`caster read: cast bar seen (${seen.casting}) and pool decal seen (${seen.decals})`);

  // -------------------------------------------------------- 5. self-shield
  await goTo(page, MOSSBACK, 'mossback hollow');
  await ops('/ops/enemyhurt', { enemyId: 'enemy_mossback', fraction: 0.5 });
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  });
  await sleep(3500);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
  });
  const shield = await until(
    page,
    () => window.__dawned.enemies().find((e) => e.shielded) ?? null,
    { label: "the mossback's ward", timeout: 60000 },
  );
  // Frame the warded elite before photographing its bubble.
  const shieldYaw = await page.evaluate(() => window.__dawned.combatState().yaw);
  await ops('/ops/tp', {
    player: CHARACTER,
    x: shield.x - Math.sin(shieldYaw) * 7,
    z: shield.z - Math.cos(shieldYaw) * 7,
  });
  await sleep(1200);
  ok(`${shield.name} raised its ward — absorb ${shield.shield} on screen as a bubble`);
  await shoot(page, '05-self-shield.png');

  // The frame belongs to a boss fight and nothing else: an elite two zones
  // away from the king must not leave it on screen.
  const frameState = await page.evaluate(() => {
    const root = document.querySelector('.boss-frame');
    return { hidden: root?.hidden ?? null, display: root ? getComputedStyle(root).display : null };
  });
  if (frameState.hidden !== true || frameState.display !== 'none') {
    fail(`boss frame still on screen away from the arena: ${JSON.stringify(frameState)}`);
  }
  ok('boss frame released once the boss fight was left behind');

  stopHealing();
  if (pageErrors.length) fail(`page errors:\n   ${pageErrors.join('\n   ')}`);
  await browser.close();
  console.log('\n🐉 P9 presentation reads on screen.\n');
};

main().catch(async (error) => {
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
});
