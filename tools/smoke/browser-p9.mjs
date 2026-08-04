#!/usr/bin/env node
/**
 * P9-E browser smoke — the phase DoD in one run (ROADMAP.md P9):
 *
 *  1. BOSS: a level-12 warrior solos the Mushroom King. The run measures the
 *     kill against COMBAT.md §12's 60–120 s window and proves the fight is
 *     READABLE: the boss frame adopts him, at least three distinct mechanics
 *     fire (his stomp, his spore ring, and the crown slam that only unlocks
 *     with the phase), the phase threshold is crossed exactly once, and the
 *     frame releases when he dies.
 *  2. MIXED CAMP: the hexer circle puts a caster, a charger and a grunt on the
 *     player at once. The run proves all three archetypes actually ACT —
 *     an interruptible cast bar, a charge lane, and melee in your face — which
 *     is the "pick your fight" pressure P9 exists for.
 *
 * A NOTE ON WHAT THE TIME MEASURES. The bot cannot dodge, so it is kept alive
 * with `/ops/hurt fraction 1` while it fights. The number this run produces is
 * therefore "how long the boss survives a level-appropriate melee player who
 * never stops attacking" — which is exactly what the 60–120 s window is about.
 * Whether the fight FEELS good is the owner's playtest, not this script's.
 *
 * Needs: game server on :8081 (fresh dist), client dev server on :5173, the
 * migrated dev Postgres with the P9 bestiary published. Idempotent.
 *
 * Usage: node tools/smoke/browser-p9.mjs [--screenshots DIR]
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
const CHARACTER = 'Kingslayer';
/** The King is level 12 and COMBAT.md §12's window is "solo, AT level". */
const SMOKE_LEVEL = 12;

/** Published P9 anchors (seed migration 0013). */
const KING = { x: 0, z: 140 };
const HEXERS = { x: 26, z: 158 };
/** COMBAT.md §12: a zone boss soloed at level should take this long. */
const BOSS_WINDOW_S = { min: 60, max: 120 };
const FIGHT_BUDGET_MS = 5 * 60 * 1000;

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

const shoot = async (page, name) => {
  if (!SHOTS_DIR) return;
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, name) }).catch(() => {});
};

/**
 * Keep the fighter standing. A bot cannot read a telegraph, so left alone it
 * dies to the first crown slam and the fight never gets measured. The heal
 * only touches the PLAYER's HP — the boss's rotation, phases and mitigation
 * are untouched, which is the half of the fight this run is timing.
 */
const keepAlive = () => {
  const timer = setInterval(() => {
    ops('/ops/hurt', { player: CHARACTER, fraction: 1 }).catch(() => undefined);
  }, 1500);
  return () => clearInterval(timer);
};

const until = async (page, fn, { timeout = 30000, label = 'condition', arg = null } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() > deadline) {
      const seen = await page
        .evaluate(() => JSON.stringify(window.__dawned.enemies().slice(0, 6)))
        .catch(() => '<unavailable>');
      fail(`timed out waiting for ${label}\n   enemies: ${seen}`);
    }
    await sleep(300);
  }
};

/**
 * Arm the in-page fighter: face the nearest living enemy, close to melee, and
 * swing plus every hotbar slot the moment it is off cooldown and affordable.
 * It also RECORDS what the enemies do to it — every ability ordinal, every
 * telegraph shape, every cast bar and every phase event — because "3+ readable
 * mechanics" is a claim that needs evidence, not a vibe.
 */
const armFighter = (page, focusName) =>
  page.evaluate((wanted) => {
    const d = window.__dawned;
    const key = (type, code) =>
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    let walking = false;
    const walk = (on) => {
      if (on === walking) return;
      walking = on;
      key(on ? 'keydown' : 'keyup', 'KeyW');
    };
    const log = {
      stop: false,
      abilities: {},
      telegraphShapes: {},
      casts: 0,
      damageTaken: 0,
      mode: 'start',
    };
    window.__p9bot = log;

    // Enemy actions are observed through the same debug surface the P9-D probe
    // uses, sampled on the bot's own tick: a cast bar UP is a cast seen, a
    // decal on screen is a telegraph seen.
    const timer = setInterval(() => {
      if (log.stop) {
        walk(false);
        clearInterval(timer);
        return;
      }
      const combat = d.combatState();
      if (combat.dead) {
        log.mode = 'dead';
        walk(false);
        d.connection.requestRespawn();
        return;
      }
      log.telegraphs = Math.max(log.telegraphs ?? 0, combat.telegraphs);
      const self = d.connection.renderPosition();
      const living = d
        .enemies()
        .filter((e) => !e.dead && e.hpFraction > 0)
        .map((e) => ({ ...e, dist: Math.hypot(e.x - self.x, e.z - self.z) }));
      for (const enemy of living) if (enemy.casting) log.casts++;

      const focus =
        living.filter((e) => e.name === wanted).sort((a, b) => a.dist - b.dist)[0] ??
        living.sort((a, b) => a.dist - b.dist)[0];
      if (!focus) {
        log.mode = 'no-target';
        walk(false);
        return;
      }
      log.focusHp = focus.hpFraction;
      d.input.yaw = Math.atan2(focus.x - self.x, focus.z - self.z);
      // Attack while closing, exactly as a player does — a bot that stops
      // swinging every time the boss steps is not a fair proxy for one, and the
      // §12 window is written about a competent player's damage.
      const inReach = focus.dist <= 2.6;
      log.mode = inReach ? 'fight' : 'close';
      walk(!inReach);
      d.attack();
      // Everything that is ready, every poll: a player does not sit on a
      // cooldown waiting for the next tick of a script.
      for (const slot of d.abilityState().hotbar) {
        if (slot.cooldownMs === 0 && slot.affordable) d.pressSlot(slot.slot);
      }
    }, 120);
  }, focusName);

const stopFighter = (page) =>
  page.evaluate(() => {
    if (window.__p9bot) window.__p9bot.stop = true;
  });

const main = async () => {
  console.log('\nP9 smoke — solo the Mushroom King, then survive a mixed camp\n');

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

  // Level-appropriate gear: the §12 window is written for a competent player at
  // level, not a naked one. The weapon is published T2 content.
  await ops('/ops/grant', { player: CHARACTER, itemId: 'item_weapon_sword_dawnsteel', qty: 1 });
  await sleep(1200);
  const equipped = await page.evaluate(() => {
    const state = window.__dawned.inventoryState();
    const cell = state.cells.find(([, stack]) => stack.itemId === 'item_weapon_sword_dawnsteel');
    if (!cell) return null;
    window.__dawned.sendItemOp({ kind: 'equip', from: cell[0] });
    return cell[0];
  });
  await sleep(1200);
  const mainhand = await page.evaluate(
    () => window.__dawned.inventoryState().equipment.mainhand?.itemId ?? null,
  );
  note(`weapon granted in cell ${equipped}, main hand: ${mainhand ?? 'none'}`);

  // A level-12 character with 44 unspent attribute points and 11 unspent skill
  // points is NOT what §12's window is written about — it is a level-1 build in
  // a level-12 body. Spend everything the way a warrior would (strength for
  // attack power, then whatever tree nodes are legal) before timing anything.
  const build = await page.evaluate(async () => {
    const d = window.__dawned;
    const sheet = () => d.progressionState().sheet;
    const stats = sheet()?.unspentStatPoints ?? 0;
    if (stats > 0) d.allocateStats({ str: stats, agi: 0, int: 0, vit: 0, end: 0 });
    await new Promise((r) => setTimeout(r, 1200));
    // Skill nodes: buy anything the server accepts, cheapest-first by tier, and
    // keep going until a whole pass buys nothing (gates open as tiers fill).
    const defs = [...d.connection.skillNodeDefs.values()].filter(
      (node) => node.classId === d.connection.classId,
    );
    let bought = 0;
    for (let pass = 0; pass < 8; pass++) {
      let any = false;
      for (const node of defs.sort((a, b) => a.tier - b.tier)) {
        const result = d.allocateSkill(node.id);
        if (result?.ok) {
          bought++;
          any = true;
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      if (!any) break;
    }
    await new Promise((r) => setTimeout(r, 1000));
    const after = sheet();
    return {
      str: stats,
      nodes: bought,
      unspentStats: after?.unspentStatPoints ?? -1,
      unspentSkills: after?.unspentSkillPoints ?? -1,
    };
  });
  note(
    `build: +${build.str} STR, ${build.nodes} skill node rank(s) — ` +
      `${build.unspentStats} stat / ${build.unspentSkills} skill points left over`,
  );
  ok(`in world at level ${SMOKE_LEVEL}, fully specced`);

  const stopHealing = keepAlive();

  // ------------------------------------------------------------- 1. the boss
  // Reset first: a previous run can leave the King mid-fight or wounded, and
  // "how long does he take to kill" is only meaningful from full HP.
  await ops('/ops/tp', { player: CHARACTER, x: 0, z: 40 });
  await sleep(2000);
  await ops('/ops/tp', { player: CHARACTER, x: KING.x, z: KING.z - 30 });
  await sleep(2500);
  // The King respawns on a TEN MINUTE ticket, so a re-run inside that window
  // finds an empty arena. Stand a fixture one up rather than idling: a wave
  // King is the same published def and files no respawn ticket of its own.
  const alive = await page.evaluate(() =>
    window.__dawned.enemies().some((e) => e.rank === 'zone_boss' && !e.dead),
  );
  if (!alive) {
    await ops('/ops/spawnwave', {
      enemyId: 'enemy_mushroom_king',
      count: 1,
      x: KING.x,
      z: KING.z,
      radius: 0,
    });
    note('no King up (10 min respawn ticket) — stood a fixture one on his mark');
    await sleep(2500);
  }
  // Top him back to full: a wounded survivor from an aborted run would make the
  // measured kill time meaningless.
  await ops('/ops/enemyhurt', { enemyId: 'enemy_mushroom_king', fraction: 1 });
  await until(
    page,
    (home) =>
      window.__dawned
        .enemies()
        .some(
          (e) =>
            e.rank === 'zone_boss' &&
            !e.inCombat &&
            e.hpFraction > 0.99 &&
            Math.hypot(e.x - home.x, e.z - home.z) < 6,
        ),
    { label: 'the King at full health on his mark', timeout: 90000, arg: KING },
  );
  ok('Mushroom King ready — full health, out of combat, on his mark');

  await ops('/ops/tp', { player: CHARACTER, x: KING.x, z: KING.z - 2.5 });
  await armFighter(page, 'Mushroom King');
  const startedAt = Date.now();

  await until(page, () => document.querySelector('.boss-frame')?.hidden === false, {
    label: 'the boss frame to adopt the King',
    timeout: 40000,
  });
  ok('boss frame adopted the King on engagement');
  await shoot(page, '01-boss-engaged.png');

  // Watch the whole fight: HP down, phase crossed once, mechanics counted.
  const seen = { phases: 0, announces: new Set(), telegraphs: 0, abilities: new Set() };
  let killedAt = 0;
  const deadline = startedAt + FIGHT_BUDGET_MS;
  let announceLive = false;
  while (Date.now() < deadline) {
    const now = await page.evaluate(() => {
      const boss = window.__dawned.enemies().find((e) => e.rank === 'zone_boss');
      const el = document.querySelector('.boss-frame-announce');
      return {
        hp: boss ? boss.hpFraction : null,
        dead: boss ? boss.dead : true,
        gone: !boss,
        announce: el && el.classList.contains('is-live') ? el.textContent : null,
        telegraphs: window.__dawned.combatState().telegraphs,
        casting: window.__dawned.enemies().some((e) => e.casting),
        frameHidden: document.querySelector('.boss-frame')?.hidden,
      };
    });
    if (now.announce && !announceLive) {
      seen.phases++;
      seen.announces.add(now.announce.trim());
      announceLive = true;
      await shoot(page, '02-phase.png');
    }
    if (!now.announce) announceLive = false;
    if (now.telegraphs > 0) seen.telegraphs++;
    if (now.dead || now.gone || now.hp === 0) {
      killedAt = Date.now();
      break;
    }
    await sleep(250);
  }
  const bot = await page.evaluate(() => window.__p9bot ?? null);
  await stopFighter(page);

  if (!killedAt) {
    fail(
      `the King was still alive after ${(FIGHT_BUDGET_MS / 1000).toFixed(0)}s ` +
        `(at ${((bot?.focusHp ?? 1) * 100).toFixed(0)}% HP, bot mode "${bot?.mode}")`,
    );
  }
  const seconds = (killedAt - startedAt) / 1000;
  // The measured DPS is the number that explains the time — it is also the
  // number the panel's TTK simulator has to be fed to predict this fight.
  const bossHp = await fetch(`${BASE_URL}/api/content/enemies`)
    .then((r) => r.json())
    .then(
      (rows) =>
        (Array.isArray(rows) ? rows : (rows.enemies ?? [])).find(
          (row) => (row.id ?? row.def?.id) === 'enemy_mushroom_king',
        )?.statOverrides?.maxHp ?? null,
    )
    .catch(() => null);
  ok(
    `Mushroom King killed in ${seconds.toFixed(1)}s` +
      (bossHp ? ` (${bossHp} HP ⇒ ${(bossHp / seconds).toFixed(0)} effective dps)` : ''),
  );
  note(
    `mechanics: ${seen.telegraphs} telegraph samples · ${bot?.casts ?? 0} cast samples · ` +
      `${seen.phases} phase crossing(s) — ${[...seen.announces].join(' / ') || 'none'}`,
  );
  await shoot(page, '03-boss-down.png');

  if (seen.phases !== 1) {
    fail(`expected exactly 1 phase crossing (the King declares one), saw ${seen.phases}`);
  }
  if (seen.telegraphs === 0) fail('the King never drew a telegraph — no readable mechanic');
  if (seconds < BOSS_WINDOW_S.min || seconds > BOSS_WINDOW_S.max) {
    fail(
      `kill took ${seconds.toFixed(1)}s, outside COMBAT.md §12's ` +
        `${BOSS_WINDOW_S.min}–${BOSS_WINDOW_S.max}s zone-boss window`,
    );
  }
  ok(`inside the §12 ${BOSS_WINDOW_S.min}–${BOSS_WINDOW_S.max}s window`);

  await sleep(2500);
  const released = await page.evaluate(() => document.querySelector('.boss-frame')?.hidden);
  if (released !== true) fail('the boss frame stayed up after the King died');
  ok('boss frame released on death');

  // -------------------------------------------------------- 2. mixed camp
  await ops('/ops/tp', { player: CHARACTER, x: HEXERS.x, z: HEXERS.z });
  await sleep(2000);
  await armFighter(page, 'Outcast Hexer');
  const pressure = { cast: false, charge: false, melee: false };
  const camDeadline = Date.now() + 120000;
  while (Date.now() < camDeadline && !(pressure.cast && pressure.charge && pressure.melee)) {
    const now = await page.evaluate(() => {
      const d = window.__dawned;
      const self = d.connection.renderPosition();
      const live = d.enemies().filter((e) => !e.dead && e.inCombat);
      return {
        casting: live.some((e) => e.casting),
        telegraphs: d.combatState().telegraphs,
        // A stalker is P9's charger; in melee range and engaged is the grunt
        // half of the pressure.
        charger: live.some(
          (e) => e.name === 'Weald Stalker' && Math.hypot(e.x - self.x, e.z - self.z) < 16,
        ),
        melee: live.some((e) => Math.hypot(e.x - self.x, e.z - self.z) < 3),
        names: [...new Set(live.map((e) => e.name))],
      };
    });
    if (now.casting) pressure.cast = true;
    if (now.charger && now.telegraphs > 0) pressure.charge = true;
    if (now.melee) pressure.melee = true;
    if (!pressure.names) pressure.names = now.names;
    await sleep(250);
  }
  await stopFighter(page);
  note(`camp held: ${(pressure.names ?? []).join(', ')}`);
  if (!pressure.cast) fail('no interruptible cast in the hexer circle — the caster never acted');
  if (!pressure.melee) fail('nothing reached melee range — no grunt pressure');
  if (!pressure.charge) {
    note(
      '⚠️  no charger telegraph observed in the window (stalkers may have been out of the pull)',
    );
  }
  ok(
    `mixed camp put ${pressure.cast ? 'a cast' : '—'}, ` +
      `${pressure.charge ? 'a charge' : 'no charge'} and melee on the player at once`,
  );
  await shoot(page, '04-mixed-camp.png');

  stopHealing();
  if (pageErrors.length) fail(`page errors:\n   ${pageErrors.join('\n   ')}`);
  await browser.close();
  console.log('\n🍄 P9 smoke passed — the boss fight lands in its window and reads.\n');
};

main().catch((error) => {
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
});
