#!/usr/bin/env node
/**
 * P7 browser smoke — the phase DoD in one run (docs ROADMAP.md P7):
 *
 *  1. GRIND 1→10 LEGITIMATELY: a bot warrior fights the live test camps
 *     (shore glubs → mushnubs), pulled by real kills through the real
 *     pipeline — tag rule, level falloff, curve, cascading level-ups.
 *     The panel's GM-event lever accelerates it (world_settings.xpRate,
 *     published row + hot reload — the same "Dawn Festival" flow the
 *     owner would use); no /setlevel, no XP is granted directly.
 *  2. Trees allocate/respec correctly against the PUBLISHED nodes: tier
 *     gates hold and open exactly at the shared thresholds while points
 *     accrue; both respec flavors refund fully and charge gold.
 *  3. The progression UI is live: XP bar fills, micro-menu badges track
 *     banked points, level-up toasts fire, the K panel draws all 24 class
 *     nodes and answers clicks.
 *
 * Needs: game server on :8081 (fresh dist), client dev server on :5173,
 * the migrated dev Postgres. Idempotent — safe to re-run.
 *
 * Usage: node tools/smoke/browser-p7.mjs
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.env.SMOKE_API ?? 'http://127.0.0.1:8081';
const CLIENT_URL = process.env.SMOKE_CLIENT ?? 'http://localhost:5173';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://dawned:dawned@127.0.0.1:5432/dawned';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
/** Screenshots land here only when `--screenshots DIR` is given (p6 rule). */
const shotIndex = process.argv.indexOf('--screenshots');
const SHOTS_DIR = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;
/**
 * The run stacks BOTH real content levers to keep the grind inside a smoke
 * budget, exactly as documented in PROGRESSION.md §1.1: the xpRate world
 * modifier (festival cap 8×) times per-enemy xpMult (panel field, cap 10×).
 * Both are published-row edits + hot reload — the owner's tuning path.
 */
const GRIND_XP_RATE = 8;
const GRIND_ENEMY_XP_MULT = 10;
const CAMP_ENEMY_IDS = ['enemy_shore_glub', 'enemy_young_mushnub', 'enemy_spore_lobber'];
/** Hard budget for the 1→10 grind leg — the pace is respawn-bound (11
 * killable camp enemies per 90–120 s cycle), measured ≈ 12 min end to end. */
const GRIND_BUDGET_MS = 14 * 60 * 1000;

/** Throws so the bottom catch can restore xpRate before exiting. */
const fail = (message) => {
  throw new Error(message);
};
const ok = (message) => console.log(`✅ ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Best-effort teardown installed once the DB is connected. */
let cleanup = async () => {};

const ops = async (route, body) => {
  const response = await fetch(`${BASE_URL}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-secret': OPS_SECRET },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) fail(`${route} → ${response.status}: ${await response.text()}`);
  return response.json();
};

/** Publish an xpRate world-setting row + hot reload (the GM-event flow). */
const setXpRate = async (db, rate) => {
  if (rate === 1) {
    await db.query(`DELETE FROM content_world_settings WHERE key = 'xpRate'`);
  } else {
    await db.query(
      `INSERT INTO content_world_settings (key, status, value) VALUES ('xpRate', 'published', $1::jsonb)
       ON CONFLICT (key, status) DO UPDATE SET value = $1::jsonb`,
      [JSON.stringify(rate)],
    );
  }
  await ops('/ops/reload-content');
};

/** Retune the camp enemies' per-row xpMult (the P7-B "xpMult honored" lever). */
const setCampXpMult = async (db, mult) => {
  await db.query(
    `UPDATE content_enemies SET def = jsonb_set(def, '{xpMult}', $1::jsonb)
     WHERE status = 'published' AND id = ANY($2)`,
    [JSON.stringify(mult), CAMP_ENEMY_IDS],
  );
  await ops('/ops/reload-content');
};

const shot = async (page, name) => {
  if (!SHOTS_DIR) return;
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, name), timeout: 30000 });
};

const main = async () => {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  cleanup = async () => {
    await setCampXpMult(db, 1).catch(() => undefined);
    await setXpRate(db, 1).catch(() => undefined);
    await db.end().catch(() => undefined);
  };

  const token = await ensureAccount(BASE_URL, 'p7smoke', PASSWORD);
  const character = await ensureCharacter(BASE_URL, token, 'Grindar', 'warrior');
  // Fixture staging: park on known-good ground near spawn (the bot walks to
  // the camps itself), fund the respec leg, clear HP carryover. Level/points
  // reset happens in-world via ops (setLevel down refunds — a tested path).
  await db.query(
    `UPDATE characters SET pos_x = 0.5, pos_y = 4.6, pos_z = 382.6, hp = NULL, gold = 5000 WHERE id = $1`,
    [character.id],
  );

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
  await page.click('.char-card');
  await page.getByText('ENTER WORLD', { exact: true }).click();
  await page.waitForSelector('.hud', { timeout: 60000 });
  await page.waitForFunction(
    () =>
      window.__dawned?.connection?.status === 'playing' &&
      window.__dawned.progressionState().sheet !== null &&
      window.__dawned.progressionState().nodeDefsLoaded > 0,
    undefined,
    { timeout: 60000 },
  );
  ok('in world with the sheet synced and 96 node defs loaded');

  // Reset to level 1 (re-runs) — the refund path is itself under test.
  await ops('/ops/setlevel', { player: 'Grindar', level: 1 });
  await page.waitForFunction(
    () => window.__dawned.progressionState().sheet.level === 1,
    undefined,
    { timeout: 10000 },
  );
  const fresh = await page.evaluate(() => window.__dawned.progressionState().sheet);
  if (fresh.unspentStatPoints !== 0 || fresh.unspentSkillPoints !== 0) {
    fail(`level-1 reset left banked points: ${JSON.stringify(fresh)}`);
  }
  if (Object.keys(fresh.nodes).length !== 0) fail('level-1 reset left node ranks');
  ok('setlevel 1: full refund, clean slate');

  await setXpRate(db, GRIND_XP_RATE);
  await setCampXpMult(db, GRIND_ENEMY_XP_MULT);
  ok(
    `xpRate ${GRIND_XP_RATE} + camp xpMult ${GRIND_ENEMY_XP_MULT} published + hot-reloaded (the tuning levers)`,
  );

  // ------------------------------------------------------------------ grind
  // In-page bot: walk between the two south camps, fight what's up, retreat
  // under 35% HP, respawn if it dies. Runs on its own interval inside the
  // page; Node polls the sheet and drives allocations at milestones.
  await page.evaluate(() => {
    const d = window.__dawned;
    // Waypoint loop from spawn: hug the west edge to the small camps first;
    // the 5-glub main camp comes last, when the bot has levels behind it.
    const camps = [
      { x: -16, z: 355 }, // waypoint past the dummies, west of the main camp
      { x: -14, z: 312 }, // shore glub west (2)
      { x: -12, z: 242 }, // mushnub path (2)
      { x: 0, z: 270 }, // mushnub meadow (2)
      { x: 0, z: 330 }, // shore glub camp (5)
    ];
    /** Dry land near spawn — the swim-recovery anchor. */
    const LAND = { x: 0, z: 360 };
    const now = () => performance.now();
    const state = {
      camp: 0,
      fleeing: false,
      walking: false,
      // Straight-line pathing needs escape hatches: arc around obstacles when
      // position stops changing, wade out when swimming, and skip a camp when
      // nothing lands for too long (a fight wedged on geometry, an enemy on
      // an unreachable ledge). Without these one bad line stalls the grind.
      unstickUntil: 0,
      unstickSign: 1,
      lastXp: 0,
      lastLevelSeen: 1,
      lastProgressAt: now(),
      lastStuckAt: 0,
      stuckEscalations: 0,
      lastMoveCheckAt: now(),
      lastMovePos: null,
    };
    const key = (type, code) =>
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    const walk = (on) => {
      if (on === state.walking) return;
      state.walking = on;
      key(on ? 'keydown' : 'keyup', 'KeyW');
    };
    window.__p7bot = { deaths: 0, stucks: 0, stop: false, mode: 'start', x: 0, z: 0 };
    const timer = setInterval(() => {
      if (window.__p7bot.stop) {
        walk(false);
        clearInterval(timer);
        return;
      }
      const combat = d.combatState();
      if (combat.dead) {
        walk(false);
        window.__p7bot.deaths += 1;
        window.__p7bot.mode = 'dead';
        d.connection.requestRespawn();
        state.camp = 0; // shrine respawn — restart the loop from the top
        return;
      }
      const self = d.connection.renderPosition();
      window.__p7bot.x = Math.round(self.x);
      window.__p7bot.z = Math.round(self.z);
      const steerTo = (x, z) => {
        d.input.yaw = Math.atan2(x - self.x, z - self.z);
        walk(true);
      };

      // Swimming refuses every attack — wade straight back onto land first.
      if (d.connection.predicted.swimming) {
        window.__p7bot.mode = 'swim-recovery';
        steerTo(LAND.x, LAND.z);
        return;
      }

      // Stuck-on-geometry escape: while walking with no ground covered, arc
      // sideways for a beat instead of grinding into the obstacle forever.
      if (state.lastMovePos && now() - state.lastMoveCheckAt > 4000) {
        const moved = Math.hypot(self.x - state.lastMovePos.x, self.z - state.lastMovePos.z);
        if (state.walking && moved < 1.2 && now() > state.unstickUntil) {
          state.unstickUntil = now() + 1600;
          state.unstickSign = -state.unstickSign;
        }
        state.lastMovePos = { x: self.x, z: self.z };
        state.lastMoveCheckAt = now();
      } else if (!state.lastMovePos) {
        state.lastMovePos = { x: self.x, z: self.z };
        state.lastMoveCheckAt = now();
      }

      const hpFraction = combat.maxHp > 0 ? combat.hp / combat.maxHp : 1;
      if (state.fleeing && hpFraction > 0.75) state.fleeing = false;
      if (!state.fleeing && hpFraction < 0.35) state.fleeing = true;

      // Dummies pay no XP and never die for long — the grind ignores them.
      const enemies = d
        .enemies()
        .filter((e) => !e.dead && !e.name.toLowerCase().includes('dummy'))
        .map((e) => ({ ...e, dist: Math.hypot(e.x - self.x, e.z - self.z) }))
        .sort((a, b) => a.dist - b.dist);
      const target = enemies[0];

      // Wedged detection measures PROGRESS, not effort: swinging at a target
      // you cannot reach keeps a swing timer fresh forever, which is exactly how
      // a run once stood in one spot for twelve minutes "fighting". XP is the
      // only honest signal that the grind is still a grind.
      const xpNow = d.progressionState().sheet?.xp ?? 0;
      const levelNow = d.progressionState().level;
      if (xpNow !== state.lastXp || levelNow !== state.lastLevelSeen) {
        state.lastXp = xpNow;
        state.lastLevelSeen = levelNow;
        state.lastProgressAt = now();
        state.stuckEscalations = 0;
      }
      if (now() - state.lastProgressAt > 45000) {
        state.lastProgressAt = now();
        state.stuckEscalations++;
        // First try the next camp; if THAT earns nothing either, the character
        // is wedged in the world, so use the game's own remedy (P3 `/stuck`
        // teleports to spawn on a cooldown — what a player would do).
        if (state.stuckEscalations >= 2 && now() - state.lastStuckAt > 65000) {
          state.lastStuckAt = now();
          window.__p7bot.mode = 'stuck-command';
          window.__p7bot.stucks++;
          walk(false);
          d.say('/stuck');
          return;
        }
        state.camp = (state.camp + 1) % camps.length;
        window.__p7bot.mode = 'skip-camp';
        const skip = camps[state.camp];
        steerTo(skip.x, skip.z);
        return;
      }

      if (state.fleeing) {
        window.__p7bot.mode = 'flee';
        // Straight away from the nearest threat until topped up (leash+OOC).
        if (target) {
          d.input.yaw = Math.atan2(self.x - target.x, self.z - target.z);
          if (now() < state.unstickUntil) d.input.yaw += 1.2 * state.unstickSign;
          walk(true);
        } else {
          walk(false);
        }
        return;
      }

      if (!target || target.dist > 25) {
        window.__p7bot.mode = `walk-camp-${state.camp}`;
        // Nothing engaged here — march the camp loop.
        const camp = camps[state.camp];
        const dist = Math.hypot(camp.x - self.x, camp.z - self.z);
        if (dist < 6) {
          state.camp = (state.camp + 1) % camps.length;
          walk(false);
        } else {
          steerTo(camp.x, camp.z);
          if (now() < state.unstickUntil) d.input.yaw += 1.2 * state.unstickSign;
        }
        return;
      }

      window.__p7bot.mode = 'fight';
      d.input.yaw = Math.atan2(target.x - self.x, target.z - self.z);
      if (target.dist > 2.1) {
        if (now() < state.unstickUntil) d.input.yaw += 1.2 * state.unstickSign;
        walk(true);
      } else {
        walk(false);
        d.attack();
        const slot1 = d.abilityState().hotbar.find((s) => s.slot === 1);
        if (slot1 && slot1.cooldownMs === 0 && slot1.affordable) d.pressSlot(1);
      }
    }, 220);
  });
  ok('grind bot armed — fighting the camps');

  // Node-side: watch the climb, allocate at milestones, latch UI evidence.
  const startedAt = Date.now();
  let lastLevel = 1;
  let lastXp = 0;
  let lastStatusAt = Date.now();
  let sawXpTick = false;
  let sawLevelToast = false;
  let sawXpBarFill = false;
  let allocatedTier2 = false;
  let gateHeldEarly = false;
  // The Bulwark climb in Q21's tier layout: Toughened/Plated are tier 1
  // (order 1–2), Stalwart Block is tier 2 (order 3 — 3 in-branch points +
  // level 5). Higher tiers stay out of reach at L10 by design.
  const branch = [
    'node_warrior_bulwark_toughened',
    'node_warrior_bulwark_plated',
    'node_warrior_bulwark_stalwart_block',
  ];

  while (Date.now() - startedAt < GRIND_BUDGET_MS) {
    await sleep(2000);
    const snap = await page.evaluate(() => ({
      sheet: window.__dawned.progressionState().sheet,
      status: window.__dawned.connection.status,
      bot: window.__p7bot,
      toasts: [...document.querySelectorAll('.hud-toast')].map((t) => t.textContent ?? ''),
      xpFill: document.querySelector('.hud-xpbar-fill')?.style.width ?? '0%',
      badges: [
        document.querySelector('[data-badge-c]')?.textContent ?? '',
        document.querySelector('[data-badge-k]')?.textContent ?? '',
      ],
    }));
    const sheet = snap.sheet;
    if (!sheet) {
      // No sheet means no ProgressSync yet — i.e. the socket dropped and the
      // client is re-entering. Say so and keep grinding; a genuine failure to
      // come back shows up as the budget running out, not as a TypeError.
      console.log(`   … no progress sheet (reconnecting?), status ${snap.status ?? '?'}`);
      continue;
    }
    if (sheet.xp !== lastXp || sheet.level !== lastLevel) sawXpTick = true;
    if (parseFloat(snap.xpFill) > 0) sawXpBarFill = true;
    if (snap.toasts.some((t) => t.includes('point banked'))) sawLevelToast = true;
    if (sheet.level > lastLevel) {
      console.log(
        `   level ${lastLevel} → ${sheet.level} (xp ${sheet.xp}/${sheet.xpToNext}, ` +
          `bank ${sheet.unspentStatPoints}/${sheet.unspentSkillPoints}, deaths ${snap.bot.deaths})`,
      );
      lastLevel = sheet.level;
    } else if (Date.now() - lastStatusAt > 30000) {
      // Heartbeat between level-ups — a stalled bot must be diagnosable.
      console.log(
        `   … level ${sheet.level}, xp ${sheet.xp}/${sheet.xpToNext}, bot ${snap.bot.mode} @ (${snap.bot.x}, ${snap.bot.z})`,
      );
      lastStatusAt = Date.now();
    }
    lastXp = sheet.xp;

    // Milestone allocations — the SHARED gates must refuse early, open late.
    if (sheet.level >= 2 && !gateHeldEarly) {
      // Tier 2 needs 3 in-branch points — with 0 spent this must refuse.
      const verdict = await page.evaluate((id) => window.__dawned.allocateSkill(id), branch[2]);
      if (verdict.ok) fail('tier-2 node allocated with 0 in-branch points');
      gateHeldEarly = true;
      ok('tier-2 gate holds at 0 in-branch points');
    }
    if (sheet.unspentSkillPoints > 0) {
      // Spend down the bulwark line in order; tier 2 opens at 3 points + L5.
      for (const nodeId of branch) {
        const verdict = await page.evaluate((id) => window.__dawned.allocateSkill(id), nodeId);
        if (verdict.ok && nodeId === branch[2]) allocatedTier2 = true;
        if (verdict.ok) break;
      }
    }
    if (sheet.unspentStatPoints >= 3) {
      await page.evaluate(() =>
        window.__dawned.allocateStats({ str: 2, agi: 0, int: 0, vit: 1, end: 0 }),
      );
    }

    if (sheet.level >= 10) break;
  }

  const final = await page.evaluate(() => ({
    sheet: window.__dawned.progressionState().sheet,
    bot: window.__p7bot,
  }));
  await page.evaluate(() => {
    window.__p7bot.stop = true;
  });
  if (final.sheet.level < 10) {
    fail(
      `grind stalled at level ${final.sheet.level} after ${Math.round(
        (Date.now() - startedAt) / 1000,
      )} s (deaths ${final.bot.deaths}, ${final.bot.stucks} /stuck, bot ${final.bot.mode} @ (${final.bot.x}, ${final.bot.z})) — DoD wants 1→10`,
    );
  }
  ok(
    `ground 1→10 legitimately in ${Math.round((Date.now() - startedAt) / 1000)} s ` +
      `(deaths ${final.bot.deaths}, ${final.bot.stucks} /stuck, xpRate ${GRIND_XP_RATE})`,
  );
  if (!sawXpTick) fail('sheet xp never moved — XpGained pipeline dead');
  if (!sawXpBarFill) fail('XP bar never filled');
  if (!sawLevelToast) fail('no banked-points toast observed on any level-up');
  ok('XP bar filled, toasts fired, badges live during the climb');
  await shot(page, 'p7-grind-l10.png');

  // ------------------------------------------------------- trees + gates
  if (!allocatedTier2) {
    // The loop invests 6 tier-1 points before Stalwart Block — with 9 skill
    // points banked by L10 it must have opened. Try once more explicitly.
    const verdict = await page.evaluate((id) => window.__dawned.allocateSkill(id), branch[2]);
    if (!verdict.ok) fail(`tier-2 Stalwart Block still refused at L10: ${verdict.reason}`);
  }
  ok('tier gates opened exactly with in-branch investment (Stalwart Block allocated)');

  // Tier 4 stays behind its LEVEL gate at L10 (needs L15) no matter the points.
  const tier4 = await page.evaluate(() =>
    window.__dawned.allocateSkill('node_warrior_bulwark_second_wind'),
  );
  if (tier4.ok) fail('tier-4 node allocated at level 10 (level gate must hold)');
  ok(`tier-4 level gate holds at L10 (${tier4.reason})`);

  // Capstone stays locked at L10 regardless of points (needs L25 + 8 pts).
  const capstone = await page.evaluate(() =>
    window.__dawned.allocateSkill('node_warrior_bulwark_immovable'),
  );
  if (capstone.ok) fail('capstone allocated at level 10');
  ok(`capstone refused at L10 (${capstone.reason})`);

  // K panel draws the full class tree and answers a click.
  await page.evaluate(() => window.__dawned.setPanel('skills'));
  await page.waitForSelector('.pv-tree', { timeout: 5000 });
  const nodeCount = await page.locator('.pv-node').count();
  if (nodeCount !== 24) fail(`K panel draws ${nodeCount} nodes, expected 24`);
  await shot(page, 'p7-skills-panel.png');
  await page.evaluate(() => window.__dawned.setPanel(null));
  ok('K panel renders all 24 class nodes');

  // ------------------------------------------------------------- respecs
  const beforeRespec = await page.evaluate(() => window.__dawned.progressionState().sheet);
  const spentSkill = Object.values(beforeRespec.nodes).reduce((sum, rank) => sum + rank, 0);
  if (spentSkill < 4) fail(`expected ≥4 skill ranks spent before respec, have ${spentSkill}`);
  await page.evaluate(() => window.__dawned.respec('skills'));
  await page.waitForFunction(
    () => Object.keys(window.__dawned.progressionState().sheet.nodes).length === 0,
    undefined,
    { timeout: 10000 },
  );
  const afterSkills = await page.evaluate(() => window.__dawned.progressionState().sheet);
  if (afterSkills.unspentSkillPoints !== beforeRespec.unspentSkillPoints + spentSkill) {
    fail(
      `skills respec refund wrong: ${beforeRespec.unspentSkillPoints}+${spentSkill} → ${afterSkills.unspentSkillPoints}`,
    );
  }
  if (afterSkills.gold !== beforeRespec.gold - 25 * afterSkills.level) {
    fail(`skills respec gold wrong: ${beforeRespec.gold} → ${afterSkills.gold}`);
  }
  ok(`skills respec: ${spentSkill} ranks refunded, ${25 * afterSkills.level} gold charged`);

  const spentStats =
    beforeRespec.allocated.str +
    beforeRespec.allocated.agi +
    beforeRespec.allocated.int +
    beforeRespec.allocated.vit +
    beforeRespec.allocated.end;
  if (spentStats < 3) fail(`expected ≥3 attribute points spent before respec, have ${spentStats}`);
  await page.evaluate(() => window.__dawned.respec('stats'));
  await page.waitForFunction(
    () => {
      const a = window.__dawned.progressionState().sheet.allocated;
      return a.str + a.agi + a.int + a.vit + a.end === 0;
    },
    undefined,
    { timeout: 10000 },
  );
  const afterStats = await page.evaluate(() => window.__dawned.progressionState().sheet);
  if (afterStats.unspentStatPoints !== afterSkills.unspentStatPoints + spentStats) {
    fail(`stats respec refund wrong: → ${afterStats.unspentStatPoints}`);
  }
  ok(`stats respec: ${spentStats} points refunded, ${50 * afterStats.level} gold charged`);

  // -------------------------------------------------------- persistence
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.char-card', { timeout: 30000 });
  await page.click('.char-card');
  await page.getByText('ENTER WORLD', { exact: true }).click();
  await page.waitForFunction(
    () =>
      window.__dawned?.connection?.status === 'playing' &&
      window.__dawned.progressionState().sheet !== null,
    undefined,
    { timeout: 60000 },
  );
  const persisted = await page.evaluate(() => window.__dawned.progressionState().sheet);
  if (persisted.level !== afterStats.level || persisted.gold !== afterStats.gold) {
    fail(`relog lost progression: ${JSON.stringify(persisted)}`);
  }
  ok(`relog persists level ${persisted.level}, gold ${persisted.gold}, banks intact`);

  await browser.close();
  const realErrors = pageErrors.filter((error) => !error.includes('favicon'));
  if (realErrors.length > 0) {
    fail(`page errors during the run:\n  ${realErrors.slice(0, 8).join('\n  ')}`);
  }

  await setCampXpMult(db, 1);
  await setXpRate(db, 1);
  await db.end();
  ok('xpRate + camp xpMult restored to 1.0 + hot-reloaded');

  console.log('\n🌅 browser-p7 passed — grind 1→10, gates, respecs, UI and persistence all live.');
  process.exit(0);
};

main().catch(async (error) => {
  console.error(`❌ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  await cleanup();
  process.exit(1);
});
