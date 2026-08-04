#!/usr/bin/env node
/**
 * P6 caster check in real browsers: the Mage and Cleric kits end to end
 * against the live server — cast bars and releases, the Arcane Barrage
 * channel, ground quick-casts with telegraphs, ally heals landing on a SECOND
 * client, Grace/Attunement passives, absorb shields, hard CC on players
 * (root/stun/DR/interrupt via the /ops/cc GM primitive), a four-class DPS
 * envelope pass and a 4-player mixed session under lag-lab jitter.
 *
 * Usage: node tools/smoke/browser-p6.mjs [http://localhost:5173] [--screenshots DIR]
 * Requires: game server (:8081, protocol v8 + published P6 kits), client dev
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
const GAME_API = process.env.GAME_API ?? 'http://127.0.0.1:8081';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';

/** Protocol v8 flag bits — keep in sync with opcodes.ts. */
const FLAG_ROOTED = 1 << 10;
const FLAG_STUNNED = 1 << 11;
const FLAG_UNTARGETABLE = 1 << 12;

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
const castState = (page) => page.evaluate(() => window.__dawned.castState());
const scoreboard = (page) => page.evaluate(() => window.__dawned.scoreboard());
const pressSlot = (page, slot) => page.evaluate((s) => window.__dawned.pressSlot(s), slot);
const attack = (page) => page.evaluate(() => window.__dawned.attack());
const setStance = (page, held) => page.evaluate((h) => window.__dawned.setStance(h), held);
const selfFlags = (page) => page.evaluate(() => window.__dawned.connection.selfFlags);
const selfEffects = (page) =>
  page.evaluate(() => [
    ...window.__dawned.connection.effectsFor(window.__dawned.connection.selfId),
  ]);
const selfPosition = (page) => page.evaluate(() => window.__dawned.connection.renderPosition());

/** Apply CC to a named online player through the ops API (localhost only). */
const opsCc = async (player, kind, durationMs) => {
  const response = await fetch(`${GAME_API}/ops/cc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-secret': OPS_SECRET },
    body: JSON.stringify({ player, kind, durationMs }),
  });
  if (!response.ok) fail(`/ops/cc ${kind} on ${player} failed: ${response.status}`);
};

/** Stage a deterministic heal target: set a player's HP fraction (marks
 * combat server-side so OOC regen does not instantly erase the wound). */
const opsHurt = async (player, fraction) => {
  const response = await fetch(`${GAME_API}/ops/hurt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-secret': OPS_SECRET },
    body: JSON.stringify({ player, fraction }),
  });
  if (!response.ok) fail(`/ops/hurt on ${player} failed: ${response.status}`);
};

const opsMetrics = async () => {
  const response = await fetch(`${GAME_API}/ops/metrics`, {
    headers: { 'x-ops-secret': OPS_SECRET },
  });
  if (!response.ok) fail(`/ops/metrics failed: ${response.status}`);
  return response.json();
};

/** Poll a page-side condition with a friendly failure. */
const waitFor = async (label, fn, timeoutMs = 8000, everyMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  fail(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
};

const enterWorld = async (page, characterName, errors) => {
  // Character select occasionally wedges on a starved box (a long browser
  // session, many short-lived contexts) — a reload heals it, so retry the
  // select step before declaring the world unreachable.
  // DOM-driven clicks throughout: with three sibling worlds burning the core,
  // a page's rAF frames arrive seconds apart and Playwright's click pipeline
  // (actionability, stability, even force-click hit-testing) starves with
  // them. Plain evaluate round-trips keep working, so the smoke clicks the
  // way it reads state.
  const domClick = (selector, text) =>
    page.evaluate(
      ([sel, needle]) => {
        const el = [...document.querySelectorAll(sel)].find(
          (candidate) => !needle || (candidate.textContent ?? '').includes(needle),
        );
        if (!el) return false;
        el.click();
        return true;
      },
      [selector, text ?? null],
    );
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await waitFor(
    `character card for ${characterName}`,
    async () => {
      if (await domClick('.char-card', characterName)) return true;
      const seen = await page
        .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160))
        .catch(() => '(page unreadable)');
      if (seen.includes('LOG IN') || seen.includes('Desktop only')) {
        fail(`char select for ${characterName} never appeared — page shows "${seen}"`);
      }
      return null;
    },
    90000,
    500,
  );
  await waitFor(
    `enter world as ${characterName}`,
    () => domClick('.btn--primary', 'ENTER WORLD'),
    30000,
    500,
  );
  try {
    await page.waitForSelector('.hud', { timeout: 120000 });
    await page.waitForFunction(
      () => document.querySelector('.hud-status')?.textContent?.includes('in world'),
      undefined,
      { timeout: 120000 },
    );
  } catch (error) {
    fail(
      `never reached the world as ${characterName} (${error.message.split('\n')[0]})` +
        (errors.length ? `; page errors:\n  ${errors.slice(0, 5).join('\n  ')}` : ''),
    );
  }
};

const aimAtNearestDummy = (page) =>
  page.evaluate(() => {
    const DEAD = 1 << 7;
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

/** Position of the nearest living dummy (ground-cast target point). */
const nearestDummyPos = (page) =>
  page.evaluate(() => {
    const DEAD = 1 << 7;
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
        best = { x: r.render.x, z: r.render.z };
      }
    }
    return best;
  });

/** Aim the reticle at a named PLAYER (ally plates + heals). */
const aimAtPlayer = (page, name) =>
  page.evaluate((who) => {
    const c = window.__dawned.connection;
    const p = c.renderPosition();
    for (const r of c.remotes.values()) {
      if (r.name === who) {
        window.__dawned.input.yaw = Math.atan2(r.render.x - p.x, r.render.z - p.z);
        return Math.hypot(r.render.x - p.x, r.render.z - p.z);
      }
    }
    return null;
  }, name);

/** Back off the dummy line so the 8 m no-face-spawn rule lets it repop. */
const standOffSpawners = async (page) => {
  await page.keyboard.down('KeyS');
  await sleep(450);
  await page.keyboard.up('KeyS');
};

const acquireDummy = async (page) => {
  // A previous phase's rotation can wipe the whole line, and a fighter
  // loitering within 8 m of a spawner BLOCKS its respawn (no face-spawns) —
  // when nothing is alive, step off and let the line come back (~15 s).
  await waitFor(
    'a living training dummy',
    async () => {
      const dist = await aimAtNearestDummy(page);
      if (dist < 1e8) return true;
      await standOffSpawners(page);
      return null;
    },
    90000,
    400,
  );
  await waitFor(
    'soft-target (dummy)',
    async () => {
      await aimAtNearestDummy(page);
      return (await combatState(page)).target;
    },
    30000,
    200,
  );
};

const openPage = async (browser, token, viewport = { width: 1280, height: 800 }) => {
  const context = await browser.newContext({ viewport });
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

const assertNoErrors = (errors, phase) => {
  const real = errors.filter((e) => !e.includes('favicon'));
  if (real.length > 0) fail(`${phase}: page errors\n  ${real.slice(0, 6).join('\n  ')}`);
};

/** Any dummy (dead or alive — chips outlive the corpse) wearing an effect
 * whose id starts with `prefix`. Crit rolls sometimes kill the aimed dummy
 * mid-assert, so chip checks must not depend on the current soft-target. */
const dummyWearsEffect = (page, prefix) =>
  page.evaluate((needle) => {
    const c = window.__dawned.connection;
    for (const r of c.remotes.values()) {
      if (r.enemyMeta?.typeId !== 'enemy_training_dummy') continue;
      if (c.effectsFor(r.id).some((e) => e.effectId.startsWith(needle))) return true;
    }
    return false;
  }, prefix);

/** Walk toward the nearest living dummy until within `maxDist` (PBAoEs). */
const closeOnDummy = async (page, maxDist) => {
  for (let i = 0; i < 25; i++) {
    const dist = await aimAtNearestDummy(page);
    if (dist <= maxDist) return true;
    if (dist >= 1e8) {
      await standOffSpawners(page);
      await sleep(400);
      continue;
    }
    await page.keyboard.down('KeyW');
    await sleep(180);
    await page.keyboard.up('KeyW');
  }
  return false;
};

// ---------------------------------------------------------------------------
// Mage: casts, channel, ground quick-cast, Blink, Attunement, CC + DR + interrupt
// ---------------------------------------------------------------------------

const runMage = async (browser, token) => {
  const { context, page, errors } = await openPage(browser, token);
  await enterWorld(page, 'Casterm', errors);
  await acquireDummy(page);
  const state = await abilityState(page);
  if (state.defsLoaded !== 8) fail(`mage hotbar has ${state.defsLoaded}/8 defs`);
  if (state.resource.type !== 'mana') fail(`mage resource is ${state.resource.type}`);
  ok(`mage in world — 8 defs, mana globe (${state.resource.value}/${state.resource.max})`);

  // 1. Fireball: bar fills, release flies, the dummy starts burning.
  await pressSlot(page, 1);
  const cast = await waitFor('Fireball cast bar', () => castState(page), 5000);
  if (cast.kind !== 'cast') fail(`expected cast bar, got ${JSON.stringify(cast)}`);
  await waitFor('Fireball release', async () => (await castState(page)) === null, 8000);
  await waitFor('burn DoT on a dummy', () => dummyWearsEffect(page, 'burn_fireball'), 5000, 150);
  const afterFireball = await scoreboard(page);
  if (afterFireball.damageDealt <= 0) fail('Fireball dealt no damage');
  ok(`Fireball: cast bar → release → burn chip (damage ${afterFireball.damageDealt})`);

  // 2. Ice Lance: instant bolt, chills the dummy.
  await waitFor('lance ready', async () => {
    const s = await abilityState(page);
    return s.hotbar[1].cooldownMs === 0 && s.hotbar[1].affordable ? s : null;
  });
  await aimAtNearestDummy(page);
  await pressSlot(page, 2);
  await waitFor('chill on a dummy', () => dummyWearsEffect(page, 'chill_lance'), 5000, 150);
  ok('Ice Lance: chill chip on the target');

  // 3. Frost Nova roots everything close (the dummy wears the root chip).
  await waitFor('nova ready', async () => {
    const s = await abilityState(page);
    return s.hotbar[2].cooldownMs === 0 && s.hotbar[2].affordable ? s : null;
  });
  // The nova is a 5 m PBAoE — make sure a LIVING dummy is inside it (the
  // earlier bolts sometimes crit the near one down).
  if (!(await closeOnDummy(page, 4))) fail('no living dummy to nova');
  await pressSlot(page, 3);
  await waitFor('root chip on a dummy', () => dummyWearsEffect(page, 'root_'), 5000, 150);
  ok('Frost Nova: root chip on the target');
  await shoot(page, 'p6-mage-nova.png');

  // 4. Blink: forward hop + the untargetable ghost buff.
  const beforeBlink = await selfPosition(page);
  await waitFor('blink ready', async () => {
    const s = await abilityState(page);
    return s.hotbar[3].cooldownMs === 0 ? s : null;
  });
  await pressSlot(page, 4);
  await waitFor(
    'blink ghost (buff or flag)',
    async () => {
      const effects = await selfEffects(page);
      if (effects.some((e) => e.effectId === 'buff_blink_ghost')) return true;
      return ((await selfFlags(page)) & FLAG_UNTARGETABLE) !== 0;
    },
    3500,
    50,
  );
  const afterBlink = await selfPosition(page);
  const hop = Math.hypot(afterBlink.x - beforeBlink.x, afterBlink.z - beforeBlink.z);
  if (hop < 5) fail(`Blink hopped only ${hop.toFixed(2)}m`);
  ok(`Blink: ${hop.toFixed(1)}m hop + ghost`);

  // 5. Arcane Barrage: 6-tick channel, homing bolts land on the dummy.
  await waitFor(
    'barrage ready',
    async () => {
      const s = await abilityState(page);
      return s.hotbar[6].cooldownMs === 0 && s.hotbar[6].affordable ? s : null;
    },
    15000,
  );
  await aimAtNearestDummy(page);
  const beforeBarrage = await scoreboard(page);
  await pressSlot(page, 7);
  const channel = await waitFor('channel bar', () => castState(page), 5000);
  if (channel.kind !== 'channel' || channel.ticks !== 6) {
    fail(`expected a 6-tick channel, got ${JSON.stringify(channel)}`);
  }
  await waitFor('channel end', async () => (await castState(page)) === null, 9000);
  await waitFor(
    'barrage bolts landing',
    async () => (await scoreboard(page)).damageDealt > beforeBarrage.damageDealt,
    4000,
  );
  ok('Arcane Barrage: 6-tick channel, bolts landed');

  // 6. Meteor: ground quick-cast at the dummy → telegraph → sky falls.
  await waitFor(
    'meteor ready',
    async () => {
      const s = await abilityState(page);
      return s.hotbar[7].cooldownMs === 0 && s.hotbar[7].affordable ? s : null;
    },
    30000,
  );
  const dummyPos = await waitFor(
    'a living dummy for the meteor point',
    async () => {
      const pos = await nearestDummyPos(page);
      if (pos) return pos;
      await standOffSpawners(page);
      return null;
    },
    60000,
    500,
  );
  const beforeMeteor = await scoreboard(page);
  const tgBefore = (await combatState(page)).telegraphs;
  await page.evaluate(
    ([x, z]) => window.__dawned.pressSlotGround(8, x, z),
    [dummyPos.x, dummyPos.z],
  );
  await waitFor(
    'meteor telegraph',
    async () => (await combatState(page)).telegraphs > tgBefore,
    3000,
  );
  await waitFor(
    'meteor impact damage',
    async () => (await scoreboard(page)).damageDealt > beforeMeteor.damageDealt,
    6000,
  );
  ok('Meteor: ground quick-cast telegraphed and hit');
  await shoot(page, 'p6-mage-meteor.png');

  // 7. Attunement: three landed basics cycle the pips 1 → 2 → 0.
  const seen = new Set([await page.evaluate(() => window.__dawned.attunement())]);
  for (let i = 0; i < 60 && seen.size < 3; i++) {
    const dist = await aimAtNearestDummy(page);
    if (dist >= 1e8) {
      await standOffSpawners(page); // wiped line — let it repop, then resume
      await sleep(300);
      continue;
    }
    await attack(page);
    await sleep(220);
    seen.add(await page.evaluate(() => window.__dawned.attunement()));
  }
  if (!(seen.has(0) && seen.has(1) && seen.has(2))) {
    fail(`attunement pips never cycled (saw ${[...seen].join(',')})`);
  }
  ok('Attunement: pip mirror cycled 0→1→2→0 on landed bolts');

  // 8. Root: feet pinned (server + prediction agree), broken by Blink's cleanse.
  await opsCc('Casterm', 'root', 2500);
  await waitFor('rooted flag', async () => ((await selfFlags(page)) & FLAG_ROOTED) !== 0, 3000, 50);
  const rootedAt = await selfPosition(page);
  await page.keyboard.down('KeyW');
  await sleep(600);
  await page.keyboard.up('KeyW');
  const heldStill = await selfPosition(page);
  const crept = Math.hypot(heldStill.x - rootedAt.x, heldStill.z - rootedAt.z);
  if (crept > 0.35) fail(`rooted player crept ${crept.toFixed(2)}m`);
  await shoot(page, 'p6-mage-rooted.png');
  await waitFor(
    'blink ready again',
    async () => {
      const s = await abilityState(page);
      return s.hotbar[3].cooldownMs === 0 ? s : null;
    },
    15000,
  );
  await pressSlot(page, 4);
  await waitFor(
    'root broken by Blink',
    async () => ((await selfFlags(page)) & FLAG_ROOTED) === 0,
    3000,
    50,
  );
  ok(`Root: pinned the feet (crept ${crept.toFixed(2)}m), Blink cleansed it`);

  // 9. DR: two identical roots back to back — the second runs at half
  // duration. Self-contained: wait out step 8's DR window first so this
  // probe owns its lane, and compare the two measured windows against each
  // other (absolute timings flex with load; the ratio does not).
  await sleep(11000);
  const measureRoot = async (label) => {
    await opsCc('Casterm', 'root', 2000);
    await waitFor(
      `${label} on`,
      async () => ((await selfFlags(page)) & FLAG_ROOTED) !== 0,
      3000,
      60,
    );
    const onAt = Date.now();
    await waitFor(
      `${label} off`,
      async () => ((await selfFlags(page)) & FLAG_ROOTED) === 0,
      4000,
      60,
    );
    return Date.now() - onAt;
  };
  const rootFull = await measureRoot('DR root #1');
  const rootHalved = await measureRoot('DR root #2');
  if (rootHalved > rootFull * 0.75) {
    fail(`DR did not halve: #1 ${rootFull}ms vs #2 ${rootHalved}ms`);
  }
  ok(`DR: root #2 ran ${rootHalved}ms vs #1 ${rootFull}ms (halved)`);

  // 10. Stun mid-cast: bar shatters, ribbon says STUNNED, attacks refused.
  await waitFor(
    'fireball ready again',
    async () => {
      const s = await abilityState(page);
      return s.hotbar[0].cooldownMs === 0 && s.hotbar[0].affordable ? s : null;
    },
    15000,
  );
  await pressSlot(page, 1);
  await waitFor('cast to interrupt', () => castState(page), 5000);
  await opsCc('Casterm', 'stun', 1500);
  await waitFor('cast interrupted', async () => (await castState(page)) === null, 4000, 40);
  await waitFor(
    'STUNNED ribbon',
    () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-cc]');
        return el && !el.hidden && el.textContent === 'STUNNED';
      }),
    3500,
    40,
  );
  if ((await attack(page)) !== false && (await attack(page)) !== null) {
    fail('basic attack accepted while stunned');
  }
  await shoot(page, 'p6-mage-stunned.png');
  await waitFor('stun over', async () => ((await selfFlags(page)) & FLAG_STUNNED) === 0, 3000);
  ok('Stun: interrupted the cast, ribbon shown, inputs dead, wore off');

  // 11. Focus stance: identical windows, held strafe covers ~60% the ground.
  const walk = async () => {
    // Long identical windows: at 0.8 s, correction smoothing + sub-tick
    // jitter put ±10% on the ratio and the gate flaked (measured 0.83 once).
    const from = await selfPosition(page);
    await page.keyboard.down('KeyW');
    await sleep(1500);
    await page.keyboard.up('KeyW');
    await sleep(400);
    const to = await selfPosition(page);
    return Math.hypot(to.x - from.x, to.z - from.z);
  };
  const freeDist = await walk();
  await setStance(page, true);
  await sleep(150);
  const focusDist = await walk();
  await setStance(page, false);
  if (freeDist < 1 || focusDist > freeDist * 0.82) {
    fail(`Focus slow missing (free ${freeDist.toFixed(2)}m vs held ${focusDist.toFixed(2)}m)`);
  }
  ok(`Focus stance: ${focusDist.toFixed(1)}m held vs ${freeDist.toFixed(1)}m free`);

  assertNoErrors(errors, 'mage');
  await context.close();
};

// ---------------------------------------------------------------------------
// Cleric + patient (two clients): Mend on an ally, Grace, Aegis, Sanctuary, Purify
// ---------------------------------------------------------------------------

const runClericDuo = async (browser, clericToken, patientToken) => {
  const cleric = await openPage(browser, clericToken);
  const patient = await openPage(browser, patientToken);
  await enterWorld(patient.page, 'Casterw', patient.errors);
  await enterWorld(cleric.page, 'Casterc', cleric.errors);
  await acquireDummy(cleric.page);
  const state = await abilityState(cleric.page);
  if (state.defsLoaded !== 8) fail(`cleric hotbar has ${state.defsLoaded}/8 defs`);
  // Stage the wound via ops (OOC regen at 8%/s erases any pre-damaged
  // fixture during the slow multi-client entry — verified the hard way).
  await opsHurt('Casterw', 0.3);
  const patientStart = await waitFor(
    'patient staged hurt',
    async () => {
      const c = await combatState(patient.page);
      return c.hp <= c.maxHp * 0.35 ? c : null;
    },
    3000,
  );
  ok(`cleric + patient in world (patient staged at ${patientStart.hp}/${patientStart.maxHp} hp)`);

  // 1. The ally plate: aiming at the hurt warrior shows a green frame.
  await waitFor(
    'ally plate',
    async () => {
      await aimAtPlayer(cleric.page, 'Casterw');
      return cleric.page.evaluate(() => {
        const el = document.querySelector('[data-target]');
        return el && !el.hidden && el.dataset.friendly === 'true';
      });
    },
    8000,
    150,
  );
  ok('ally plate: green frame on the would-be heal target');
  await shoot(cleric.page, 'p6-cleric-allyplate.png');

  // 2. Mend: 1.5s cast lands the heal on the OTHER client. A first press can
  // draw a server reject (fresh-session divergence) — the client re-bases
  // from the AbilityState correction by design, so retry like a player would.
  let mendKind = null;
  let healedNow = 0;
  for (let attempt = 1; attempt <= 3 && healedNow <= 0; attempt++) {
    const before = (await scoreboard(cleric.page)).healingDone;
    await aimAtPlayer(cleric.page, 'Casterw');
    await pressSlot(cleric.page, 2);
    const bar = await waitFor('Mend cast bar', () => castState(cleric.page), 5000).catch(
      () => null,
    );
    if (bar) mendKind = bar.kind;
    const outcome = await waitFor(
      'Mend heal resolve',
      async () => ((await scoreboard(cleric.page)).healingDone > before ? 'healed' : null),
      12000,
      200,
    ).catch(() => null);
    if (outcome === 'healed') {
      healedNow = (await scoreboard(cleric.page)).healingDone - before;
      break;
    }
    console.warn(`⚠️  Mend attempt ${attempt} landed no heal — retrying`);
    await waitFor(
      'mend ready for retry',
      async () => {
        const s = await abilityState(cleric.page);
        return s.hotbar[1].cooldownMs === 0 && s.hotbar[1].affordable ? s : null;
      },
      10000,
    );
  }
  if (healedNow <= 0) fail('Mend never landed a heal in 3 attempts');
  if (mendKind !== 'cast') fail(`Mend bar never showed as a cast (saw ${mendKind})`);
  await waitFor(
    'patient healed',
    async () => (await combatState(patient.page)).hp > patientStart.hp,
    5000,
  );
  ok(`Mend: healed the ally across clients (+${healedNow} logged on the healer)`);

  // 3. Grace: two Smite hits bank stacks; the next Mend bar starts shorter.
  await acquireDummy(cleric.page);
  const graceStart = Date.now();
  for (let hits = 0; hits < 30 && Date.now() - graceStart < 60000; hits++) {
    const effects = await selfEffects(cleric.page);
    const grace = effects.find((e) => e.effectId === 'grace');
    if (grace && grace.stacks >= 2) break;
    await waitFor(
      'smite ready',
      async () => {
        const s = await abilityState(cleric.page);
        return s.hotbar[0].cooldownMs === 0 && s.hotbar[0].affordable ? s : null;
      },
      10000,
    );
    const dist = await aimAtNearestDummy(cleric.page);
    if (dist >= 1e8) {
      await standOffSpawners(cleric.page); // wiped line — wait for a target
      await sleep(400);
      continue;
    }
    await pressSlot(cleric.page, 1);
    await sleep(700);
  }
  const graceStacks = (await selfEffects(cleric.page)).find((e) => e.effectId === 'grace')?.stacks;
  if (!graceStacks) fail('Grace never stacked from Smite hits');
  await waitFor(
    'mend ready',
    async () => {
      const s = await abilityState(cleric.page);
      return s.hotbar[1].cooldownMs === 0 && s.hotbar[1].affordable ? s : null;
    },
    10000,
  );
  await aimAtPlayer(cleric.page, 'Casterw');
  await pressSlot(cleric.page, 2);
  const gracedBar = await waitFor('graced Mend bar', () => castState(cleric.page), 5000);
  const expectedMax = 1500 - 100 * graceStacks + 130;
  if (gracedBar.remainingMs > expectedMax) {
    fail(`Grace did not shorten the bar (${gracedBar.remainingMs}ms with ${graceStacks} stacks)`);
  }
  await waitFor('graced Mend released', async () => (await castState(cleric.page)) === null, 9000);
  await waitFor(
    'grace consumed',
    async () => !(await selfEffects(cleric.page)).some((e) => e.effectId === 'grace'),
    5000,
  );
  ok(`Grace: ${graceStacks} stacks cut the Mend bar to ${Math.round(gracedBar.remainingMs)}ms`);

  // 4. Aegis: the ally wears an absorb chip with the pool number + shimmer.
  await waitFor(
    'aegis ready',
    async () => {
      const s = await abilityState(cleric.page);
      return s.hotbar[6].cooldownMs === 0 && s.hotbar[6].affordable ? s : null;
    },
    15000,
  );
  await aimAtPlayer(cleric.page, 'Casterw');
  await pressSlot(cleric.page, 7);
  const shieldEntry = await waitFor(
    'shield on the patient',
    async () =>
      (await selfEffects(patient.page)).find(
        (e) => e.effectId.startsWith('shield_') && (e.shieldRemaining ?? 0) > 0,
      ),
    4000,
  );
  ok(`Aegis: absorb pool ${shieldEntry.shieldRemaining} synced onto the ally's chip`);
  await shoot(patient.page, 'p6-patient-shielded.png');

  // 5. Sanctuary: a gold zone whose ticks keep healing over time.
  await waitFor(
    'sanctuary ready',
    async () => {
      const s = await abilityState(cleric.page);
      return s.hotbar[4].cooldownMs === 0 && s.hotbar[4].affordable ? s : null;
    },
    15000,
  );
  await opsHurt('Casterw', 0.5); // fresh wound so the zone ticks are visible
  const clericPos = await selfPosition(cleric.page);
  const hpBeforeZone = await waitFor(
    'patient re-staged',
    async () => {
      const c = await combatState(patient.page);
      return c.hp <= c.maxHp * 0.55 ? c.hp : null;
    },
    3000,
  );
  await cleric.page.evaluate(
    ([x, z]) => window.__dawned.pressSlotGround(5, x, z),
    [clericPos.x, clericPos.z],
  );
  // The patient walks to the cleric so both stand in the zone.
  await patient.page.evaluate((who) => {
    const c = window.__dawned.connection;
    const p = c.renderPosition();
    for (const r of c.remotes.values()) {
      if (r.name === who) {
        window.__dawned.input.yaw = Math.atan2(r.render.x - p.x, r.render.z - p.z);
      }
    }
  }, 'Casterc');
  await patient.page.keyboard.down('KeyW');
  await sleep(900);
  await patient.page.keyboard.up('KeyW');
  await waitFor(
    'sanctuary ticks healing the patient',
    async () => (await combatState(patient.page)).hp > hpBeforeZone + 1,
    9000,
    250,
  );
  ok('Sanctuary: ground zone ticked heals onto the ally inside');

  // 6. Purify: cleanses the ops-root off the ally (root timers included).
  await opsCc('Casterw', 'root', 4000);
  await waitFor(
    'patient rooted',
    async () => ((await selfFlags(patient.page)) & FLAG_ROOTED) !== 0,
    3500,
    50,
  );
  await waitFor(
    'purify ready',
    async () => {
      const s = await abilityState(cleric.page);
      return s.hotbar[5].cooldownMs === 0 && s.hotbar[5].affordable ? s : null;
    },
    10000,
  );
  await aimAtPlayer(cleric.page, 'Casterw');
  await pressSlot(cleric.page, 6);
  await waitFor(
    'root purged from the ally',
    async () => ((await selfFlags(patient.page)) & FLAG_ROOTED) === 0,
    6000,
    50,
  );
  ok('Purify: broke the root on the ally');

  assertNoErrors(cleric.errors, 'cleric');
  assertNoErrors(patient.errors, 'patient');
  await cleric.context.close();
  await patient.context.close();
};

// ---------------------------------------------------------------------------
// DPS envelopes: each class rotates solo on the dummy line for a fixed window
// ---------------------------------------------------------------------------

const ROTATION_SKIP = new Set(['dash', 'blink_behind', 'teleport']);

const rotateFor = async (page, seconds) => {
  const slotKinds = await page.evaluate(() =>
    [...window.__dawned.connection.slotDefs].map(([slot, def]) => ({
      slot,
      kind: def.targeting.kind,
    })),
  );
  const usable = slotKinds.filter((s) => !ROTATION_SKIP.has(s.kind));
  const start = Date.now();
  const from = await scoreboard(page);
  while (Date.now() - start < seconds * 1000) {
    const dist = await aimAtNearestDummy(page);
    // The line's dummies die under sustained pressure — close on the next
    // one instead of whiffing; with the whole line dead, step OFF the
    // spawners (8 m no-face-spawn rule) so it can repop mid-window.
    if (dist >= 1e8) {
      await standOffSpawners(page);
      await sleep(300);
      continue;
    }
    if (dist > 2.4) {
      await page.keyboard.down('KeyW');
      await sleep(170);
      await page.keyboard.up('KeyW');
    }
    await attack(page);
    const state = await abilityState(page);
    for (const { slot, kind } of usable) {
      const view = state.hotbar[slot - 1];
      if (view.cooldownMs > 0 || !view.affordable) continue;
      if (kind === 'ground_aoe') {
        const dummy = await nearestDummyPos(page);
        if (dummy) {
          await page.evaluate(
            ([s, x, z]) => window.__dawned.pressSlotGround(s, x, z),
            [slot, dummy.x, dummy.z],
          );
        }
      } else {
        await pressSlot(page, slot);
      }
      break; // one slot per loop — the GCD gates the rest anyway
    }
    await sleep(160);
  }
  // Let in-flight bolts and DoT ticks land before reading the total.
  await sleep(2500);
  const to = await scoreboard(page);
  return (to.damageDealt - from.damageDealt) / (seconds + 2.5);
};

/** Re-park OFFLINE characters (earlier phases stranded them off the line —
 * a stale position turns a measurement window into bolts eating terrain). */
const parkOnLine = async (rows) => {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  for (const { id, x, z } of rows) {
    await db.query('UPDATE characters SET pos_x=$2, pos_y=4.6, pos_z=$3, hp=NULL WHERE id=$1', [
      id,
      x,
      z,
    ]);
  }
  await db.end();
};

const runEnvelopes = async (browser, tokens, ids) => {
  const WINDOW_S = 25;
  const results = {};
  for (const [classId, { token, name }] of Object.entries(tokens)) {
    // Park just OUTSIDE the 8 m spawn-clear ring — standing on a spawner
    // blocks its respawn, and each class needs a line to fight.
    await parkOnLine([{ id: ids[classId], x: 0.5, z: 391 }]);
    const { context, page, errors } = await openPage(browser, token);
    await enterWorld(page, name, errors);
    await acquireDummy(page);
    results[classId] = await rotateFor(page, WINDOW_S);
    assertNoErrors(errors, `envelope ${classId}`);
    await context.close();
  }
  const line = Object.entries(results)
    .map(([c, dps]) => `${c} ${dps.toFixed(1)}`)
    .join(' · ');
  console.log(`   sustained DPS @L25 (${WINDOW_S}s scripted rotations): ${line}`);
  // What a scripted bot can honestly gate: every class sustains real damage
  // through its full kit (a zeroed class = broken pipeline, the exact bug
  // family this phase caught twice). The CLASSES.md §5 ORDERING is a
  // played-well property — the bot plays mage near-optimally and rogue
  // poorly, so ordering asserts here would measure bot skill, not balance.
  // The owner's parity playtest + panel tuning own the percentages.
  for (const [classId, dps] of Object.entries(results)) {
    if (dps < 12 || dps > 400) {
      fail(`${classId} DPS ${dps.toFixed(1)} outside the sanity band [12, 400]`);
    }
  }
  ok(
    `DPS envelopes: mage ${results.mage.toFixed(0)} / rogue ${results.rogue.toFixed(0)} / cleric ${results.cleric.toFixed(0)} / warrior ${results.warrior.toFixed(0)} — all four kits sustain damage`,
  );
};

// ---------------------------------------------------------------------------
// 4-player mixed session under lag-lab jitter + the tick budget gate
// ---------------------------------------------------------------------------

const runLagLab = async (browser, tokens, ids) => {
  // One fighter per stretch of the line, parked outside the spawn-clear ring
  // (the rotation walks them in; loitering on a spawner blocks its respawn).
  const spots = { warrior: -5.5, cleric: -1.5, rogue: 0.5, mage: 4.5 };
  await parkOnLine(Object.entries(spots).map(([classId, x]) => ({ id: ids[classId], x, z: 391 })));
  const clients = [];
  for (const { token, name } of Object.values(tokens)) {
    // Four live worlds on one core: lean viewports keep the frame loops fed
    // (the app gates out anything narrower than 900px as "desktop only").
    const client = await openPage(browser, token, { width: 960, height: 540 });
    await enterWorld(client.page, name, client.errors);
    await client.page.evaluate(() => window.__dawned.connection.setNetsim(100, 30));
    clients.push({ ...client, name });
  }
  ok('lag lab: 4 classes in world at +100ms ±30ms injected');

  await Promise.all(
    clients.map(async ({ page }) => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const dist = await aimAtNearestDummy(page);
        if (dist >= 1e8) {
          await standOffSpawners(page);
          await sleep(300);
          continue;
        }
        if (dist > 2.4) {
          await page.keyboard.down('KeyW');
          await sleep(160);
          await page.keyboard.up('KeyW');
        }
        await attack(page);
        const state = await abilityState(page);
        const readySlot = state.hotbar.find((h) => h.id && h.cooldownMs === 0 && h.affordable);
        if (readySlot) await pressSlot(page, readySlot.slot);
        await sleep(300);
      }
    }),
  );

  for (const { page, errors, name } of clients) {
    const inWorld = await page.evaluate(
      () => document.querySelector('.hud-status')?.textContent?.includes('in world') ?? false,
    );
    if (!inWorld) fail(`${name} fell out of the world during the lag run`);
    const snaps = await page.evaluate(() => window.__dawned.connection.stats.snaps);
    if (snaps > 40) fail(`${name} hard-snapped ${snaps} times under jitter`);
    assertNoErrors(errors, `lag-lab ${name}`);
  }
  const metrics = await opsMetrics();
  if (metrics.players !== 4) fail(`server sees ${metrics.players} players, expected 4`);
  if (metrics.tickP95Ms >= 15) fail(`tick p95 ${metrics.tickP95Ms}ms breaks the <15ms budget`);
  ok(
    `lag lab: everyone stayed in world; tick p95 ${metrics.tickP95Ms}ms (max ${metrics.tickMaxMs}ms) with 4 players fighting`,
  );
  for (const { context } of clients) await context.close();
};

// ---------------------------------------------------------------------------

const main = async () => {
  console.log(`Dawned P6 browser check → ${BASE_URL}\n`);

  // One account per concurrently-online character (a second login on the same
  // account kicks the first session).
  const accounts = {
    mage: { account: 'zz p6 mage', name: 'Casterm', classId: 'mage' },
    cleric: { account: 'zz p6 cleric', name: 'Casterc', classId: 'cleric' },
    warrior: { account: 'zz p6 war', name: 'Casterw', classId: 'warrior' },
    rogue: { account: 'zz p6 rogue', name: 'Casterr', classId: 'rogue' },
  };
  const tokens = {};
  const ids = {};
  for (const [key, spec] of Object.entries(accounts)) {
    const token = await ensureAccount(BASE_URL, spec.account.replaceAll(' ', '_'), PASSWORD);
    const character = await ensureCharacter(BASE_URL, token, spec.name, spec.classId);
    tokens[key] = { token, name: spec.name };
    ids[key] = character.id;
  }
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  // Everyone parks on the training line at level 25 (full kits unlocked).
  await db.query(
    'UPDATE characters SET pos_x=0.5, pos_y=4.6, pos_z=382.6, hp=NULL, level=25 WHERE id = ANY($1)',
    [[ids.mage, ids.rogue]],
  );
  await db.query(
    'UPDATE characters SET pos_x=2.5, pos_y=4.6, pos_z=381.5, hp=NULL, level=25 WHERE id=$1',
    [ids.cleric],
  );
  // The patient parks a few meters south of the line — the heal target
  // (/ops/hurt stages the wound in-phase; a pre-damaged row would be full
  // again via OOC regen before the cleric even finishes logging in).
  await db.query(
    'UPDATE characters SET pos_x=1.5, pos_y=4.6, pos_z=376.5, hp=NULL, level=25 WHERE id=$1',
    [ids.warrior],
  );
  await db.end();
  ok('fixtures parked (casters on the line, a hurt warrior south of it)');

  const browser = await chromium.launch();
  try {
    // P6_PHASES=mage,cleric,envelopes,lag (comma list) runs a subset — for
    // iterating on one phase without the full ~8 minute pass.
    const only = process.env.P6_PHASES ? new Set(process.env.P6_PHASES.split(',')) : null;
    const want = (phase) => !only || only.has(phase);
    if (want('mage')) await runMage(browser, tokens.mage.token);
    if (want('cleric')) await runClericDuo(browser, tokens.cleric.token, tokens.warrior.token);
    if (want('envelopes')) await runEnvelopes(browser, tokens, ids);
    if (want('lag')) await runLagLab(browser, tokens, ids);
  } finally {
    await browser.close();
  }
  console.log(
    '\n🔮 P6 browser check passed — caster kits, CC, heals, envelopes, 4-player lag run.\n',
  );
};

main().catch((error) => {
  console.error(error instanceof SmokeFailure ? `\n❌ ${error.message}\n` : error);
  process.exit(1);
});
