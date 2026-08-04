#!/usr/bin/env node
/**
 * P8 browser smoke — the phase DoD in one run (docs ROADMAP.md P8):
 *
 *  1. KILL → LOOT: a bot warrior fights the live shore camp until a real
 *     loot bag drops from a real kill (the published tables, the tag rule,
 *     the 60 s bag), walks into reach and takes it with the real `F` key.
 *  2. PACK → PAPER-DOLL: the `I` panel renders the taken items, a
 *     right-click equips a weapon, and the ROSTER (what every other player
 *     reads) starts carrying its model — visible gear, server-published.
 *  3. VENDOR: walk to a market post, `F` opens the panel the server priced,
 *     sell a junk stack for gold, buy it back for the same gold.
 *  4. Persistence: a relog finds the pack, the paper-doll and the purse.
 *
 * Needs: game server on :8081 (fresh dist), client dev server on :5173, the
 * migrated dev Postgres with the P8 catalogue published. Idempotent.
 *
 * Usage: node tools/smoke/browser-p8.mjs [--screenshots DIR]
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.env.SMOKE_API ?? 'http://127.0.0.1:8081';
const CLIENT_URL = process.env.SMOKE_CLIENT ?? 'http://localhost:5173';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
const ACCOUNT = 'p8smoke';
const CHARACTER = 'Bagsley';
/** High enough to wear the T1/T2 catalogue and survive the shore camp. */
const SMOKE_LEVEL = 12;
/** The shore glub camp — closest reliable kill to spawn (P4 spawners). */
const CAMP = { x: 0, z: 330 };
/** Weaponsmith market post (P8-C anchors), a few metres from spawn. */
const POST = { x: 6, z: 394 };
const KILL_BUDGET_MS = 6 * 60 * 1000;

const shotIndex = process.argv.indexOf('--screenshots');
const SHOTS_DIR = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;

const ok = (message) => console.log(`✅ ${message}`);
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
 * Poll a page predicate with a deadline; returns the first truthy value.
 * A timeout prints the live item state — a smoke that only says "timed out"
 * costs a whole re-run to learn what the pack actually held.
 */
const until = async (page, fn, { timeout = 30000, label = 'condition', arg = null } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() > deadline) {
      const state = await page
        .evaluate(() => JSON.stringify(window.__dawned.inventoryState()))
        .catch(() => '<unavailable>');
      fail(`timed out waiting for ${label}\n   state: ${state}`);
    }
    await sleep(400);
  }
};

/** Set once the browser is up so a failure can photograph what it saw. */
let livePage = null;

const main = async () => {
  console.log('\nP8 smoke — kill → loot → equip → trade\n');

  const token = await ensureAccount(BASE_URL, ACCOUNT, PASSWORD);
  const character = await ensureCharacter(BASE_URL, token, CHARACTER, 'warrior');
  ok(`fixture ${CHARACTER} (#${character.id}) ready`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  const page = await context.newPage();
  livePage = page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.addInitScript((sessionToken) => {
    localStorage.setItem('dawned.token', sessionToken);
  }, token);

  const enterWorld = async () => {
    await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.char-card', { timeout: 60000 });
    await page.click(`.char-card:has-text("${CHARACTER}")`);
    await page.getByText('ENTER WORLD', { exact: true }).click();
    await page.waitForSelector('.hud', { timeout: 60000 });
    await until(page, () => window.__dawned?.connection?.status === 'playing', {
      label: 'world entry',
      timeout: 60000,
    });
    await until(page, () => window.__dawned.inventoryState().defsLoaded > 0, {
      label: 'item catalogue',
    });
  };

  await enterWorld();
  ok('in world with the item catalogue loaded');

  await ops('/ops/setlevel', { player: CHARACTER, level: SMOKE_LEVEL });
  await sleep(600);

  // --------------------------------------------------------------- 1. loot
  // Start from an empty pack: runs accumulate, and a pack at 48/48 refuses
  // loot — the smoke would then be testing its own leftovers.
  await page.evaluate(() => {
    for (const [cell, stack] of window.__dawned.inventoryState().cells) {
      window.__dawned.sendItemOp({ kind: 'drop', from: cell, qty: stack.qty });
    }
  });
  await sleep(1200);
  const before = await page.evaluate(() => window.__dawned.inventoryState());
  const itemCount = (state) => state.cells.reduce((sum, [, stack]) => sum + stack.qty, 0);
  const armBot = () =>
    page.evaluate((camp) => {
      const d = window.__dawned;
      const now = () => performance.now();
      const state = {
        walking: false,
        unstickUntil: 0,
        unstickSign: 1,
        lastPos: null,
        lastAt: now(),
      };
      const key = (type, code) =>
        window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
      const walk = (on) => {
        if (on === state.walking) return;
        state.walking = on;
        key(on ? 'keydown' : 'keyup', 'KeyW');
      };
      window.__p8bot = { stop: false, mode: 'start', kills: 0 };
      const timer = setInterval(() => {
        if (window.__p8bot.stop) {
          walk(false);
          clearInterval(timer);
          return;
        }
        const combat = d.combatState();
        if (combat.dead) {
          walk(false);
          window.__p8bot.mode = 'dead';
          d.connection.requestRespawn();
          return;
        }
        const self = d.connection.renderPosition();
        // Stuck-on-geometry escape (same rule as the P7 bot).
        if (state.lastPos && now() - state.lastAt > 4000) {
          const moved = Math.hypot(self.x - state.lastPos.x, self.z - state.lastPos.z);
          if (state.walking && moved < 1.2 && now() > state.unstickUntil) {
            state.unstickUntil = now() + 1600;
            state.unstickSign = -state.unstickSign;
          }
          state.lastPos = { x: self.x, z: self.z };
          state.lastAt = now();
        } else if (!state.lastPos) {
          state.lastPos = { x: self.x, z: self.z };
          state.lastAt = now();
        }
        if (d.connection.predicted.swimming) {
          window.__p8bot.mode = 'swim-recovery';
          d.input.yaw = Math.atan2(0 - self.x, 360 - self.z);
          walk(true);
          return;
        }
        // A bag we can see wins over everything: stand on it and stop.
        const bag = d.inventoryState().bags[0];
        if (bag) {
          window.__p8bot.mode = 'to-bag';
          if (bag.distance > 2.2) {
            const bags = d.connection.lootBags;
            const target = bags[0];
            d.input.yaw = Math.atan2(target.x - self.x, target.z - self.z);
            walk(true);
          } else {
            walk(false);
          }
          return;
        }
        const target = d
          .enemies()
          .filter((enemy) => !enemy.dead)
          .map((enemy) => ({ ...enemy, dist: Math.hypot(enemy.x - self.x, enemy.z - self.z) }))
          .sort((a, b) => a.dist - b.dist)[0];
        if (!target || target.dist > 25) {
          window.__p8bot.mode = 'march';
          const dist = Math.hypot(camp.x - self.x, camp.z - self.z);
          if (dist < 5) walk(false);
          else {
            d.input.yaw = Math.atan2(camp.x - self.x, camp.z - self.z);
            if (now() < state.unstickUntil) d.input.yaw += 1.2 * state.unstickSign;
            walk(true);
          }
          return;
        }
        window.__p8bot.mode = 'fight';
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
    }, CAMP);

  const stopBot = () =>
    page.evaluate(() => {
      if (window.__p8bot) window.__p8bot.stop = true;
    });

  /**
   * Keep fighting and taking bags until a table pays out an actual ITEM —
   * gold-only bags are legal (the shore table rolls `nothing` 43% of the time),
   * so a one-bag smoke would pass without ever proving the item path.
   */
  const lootDeadline = Date.now() + KILL_BUDGET_MS;
  let looted = before;
  let bags = 0;
  while (itemCount(looted) === itemCount(before)) {
    const left = lootDeadline - Date.now();
    if (left <= 0) {
      fail(
        `no bag carried an item in ${KILL_BUDGET_MS / 1000}s (${bags} taken, ${looted.gold} gold)`,
      );
    }
    await armBot();
    if (bags === 0) ok('bot armed — marching on the shore camp');
    const bag = await until(
      page,
      () => {
        const state = window.__dawned.inventoryState();
        const near = state.bags[0];
        return near && near.distance <= 4 ? near : null;
      },
      { timeout: left, label: 'a loot bag dropped by a real kill' },
    );
    await stopBot();
    await sleep(400);
    ok(
      `loot bag ${bag.id} within reach (${bag.distance.toFixed(1)} m, ${bag.items} item(s), ${bag.gold} gold)`,
    );
    if (bags === 0) await shoot(page, 'p8-01-bag.png');

    // Shift+F takes the whole bag through the REAL key handler.
    const baseline = looted;
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', shiftKey: true }));
    });
    looted = await until(
      page,
      (was) => {
        const state = window.__dawned.inventoryState();
        const items = state.cells.reduce((sum, [, stack]) => sum + stack.qty, 0);
        return state.gold > was.gold || items > was.items ? state : null;
      },
      {
        label: 'the bag to reach the pack',
        arg: { gold: baseline.gold, items: itemCount(baseline) },
      },
    );
    bags++;
  }
  ok(
    `looted ${bags} bag(s): ${itemCount(looted)} item(s) (${looted.cells
      .map(
        ([, stack]) =>
          `${stack.itemId.replace('item_', '')}${stack.qty > 1 ? `×${stack.qty}` : ''}`,
      )
      .join(', ')}), ${looted.gold} gold (was ${itemCount(before)} items / ${before.gold} gold)`,
  );

  // ------------------------------------------------------- 2. pack + equip
  await page.keyboard.press('KeyI');
  await page.waitForSelector('.inv-grid', { timeout: 10000 });
  const cellCount = await page.locator('.inv-grid .inv-cell').count();
  if (cellCount !== 48) fail(`the pack drew ${cellCount} cells, expected 48`);
  await shoot(page, 'p8-02-pack.png');
  ok('the pack panel drew all 48 cells');

  // Grant a class weapon and equip it from the UI, then read the ROSTER.
  await ops('/ops/grant', { player: CHARACTER, itemId: 'item_weapon_axe_tidesplitter', qty: 1 });
  await sleep(700);
  // (Boxed: cell 0 is a perfectly good cell, and a bare 0 reads as "not yet".)
  const axe = await until(
    page,
    () => {
      const entry = window.__dawned
        .inventoryState()
        .cells.find(([, stack]) => stack.itemId === 'item_weapon_axe_tidesplitter');
      return entry ? { cell: entry[0] } : null;
    },
    { label: 'the granted axe' },
  );
  await page.locator('.inv-grid .inv-cell').nth(axe.cell).click({ button: 'right' });
  const equipped = await until(
    page,
    () => {
      const state = window.__dawned.inventoryState();
      return state.equipment.mainhand?.itemId === 'item_weapon_axe_tidesplitter' &&
        state.mainhandModel
        ? state
        : null;
    },
    { label: 'the axe on the paper-doll and the roster' },
  );
  ok(`equipped: mainhand ${equipped.equipment.mainhand.itemId} → roster ${equipped.mainhandModel}`);
  await shoot(page, 'p8-03-equipped.png');

  // React synthesises mouseenter from a bubbling mouseover, so that is the
  // event a hover has to arrive as.
  const tooltip = await page.evaluate(async () => {
    const cell = document.querySelector('.inv-grid .inv-cell');
    cell?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return document.querySelector('.inv-tip-name')?.textContent ?? null;
  });
  if (!tooltip) fail('hovering a filled cell drew no tooltip');
  ok(`tooltip renders (${tooltip})`);
  await page.keyboard.press('Escape');

  // --------------------------------------------------- 2b. character sheet
  // Worn gear lives on `C`, not in the pack: the slot has to show the axe and
  // the rig beside it has to actually render (a 0-height canvas draws nothing
  // and looks exactly like "no character" — that regression shipped once).
  await page.keyboard.press('KeyC');
  await page.waitForSelector('.cs-doll', { timeout: 10000 });
  const sheet = await until(
    page,
    () => {
      const canvas = document.querySelector('.cs-stage canvas');
      const slot = document.querySelector('.cs-slot[data-rarity]:not([data-rarity="none"])');
      const filled = [...document.querySelectorAll('.cs-slot[data-filled="true"]')].length;
      return canvas && canvas.height > 0 && slot
        ? { height: canvas.height, filled, title: document.querySelector('.pv-title')?.textContent }
        : null;
    },
    { label: 'the character sheet to draw its rig and gear' },
  );
  if (sheet.filled < 1) fail('the sheet shows no worn gear');
  ok(`character sheet: ${sheet.filled} slot(s) worn, rig canvas ${sheet.height}px`);
  await shoot(page, 'p8-03b-sheet.png');
  await page.keyboard.press('Escape');

  // ------------------------------------------------------------- 3. vendor
  // Walk INTO the post, not to its edge: the server judges the lease on its
  // own copy of the position, which trails the predicted one while running.
  await page.evaluate((post) => {
    const d = window.__dawned;
    const key = (type, code) =>
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    window.__p8walk = setInterval(() => {
      const self = d.connection.renderPosition();
      const dist = Math.hypot(post.x - self.x, post.z - self.z);
      if (dist < 1.2) {
        key('keyup', 'KeyW');
        clearInterval(window.__p8walk);
        return;
      }
      d.input.yaw = Math.atan2(post.x - self.x, post.z - self.z);
      key('keydown', 'KeyW');
    }, 200);
  }, POST);
  await until(
    page,
    (post) => {
      const self = window.__dawned.connection.renderPosition();
      return Math.hypot(post.x - self.x, post.z - self.z) < 1.4 ? true : null;
    },
    { timeout: 120000, label: 'the walk to the market post', arg: POST },
  );
  await page.evaluate(() => {
    clearInterval(window.__p8walk);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  });
  await sleep(800);

  // Posts are props the player walks to: all five stand on real ground, not
  // buried at height 0 while the terrain chunk was still streaming.
  const seated = await until(
    page,
    () => {
      const count = window.__dawned.inventoryState().postsSeated;
      return count > 0 ? { count } : null;
    },
    { label: 'the market posts to stand up' },
  );
  if (seated.count !== 5) fail(`${seated.count} of 5 market posts stood up`);
  ok(`all ${seated.count} market posts stand on the ground`);

  const prompt = await page.evaluate(
    () => document.querySelector('.hud-interact')?.textContent ?? null,
  );
  if (!prompt || !prompt.includes('Trade')) fail(`no trade prompt at the post (saw: ${prompt})`);
  ok(`the post offers its prompt: "${prompt}"`);

  // Press `F` until the server answers with a panel. A headless client runs at
  // a handful of frames a second, so it drifts off the post between polls —
  // nudge back in and knock again rather than declaring the vendor broken.
  const tradeDeadline = Date.now() + 90000;
  let vendorId = null;
  for (;;) {
    const state = await page.evaluate(() => {
      const value = window.__dawned.inventoryState();
      return { vendor: value.vendor, reach: value.vendorInReach, notices: value.notices };
    });
    if (state.vendor) {
      vendorId = state.vendor;
      break;
    }
    if (Date.now() > tradeDeadline) {
      fail(`the post never opened (reach: ${state.reach}, notices: ${state.notices.join(' | ')})`);
    }
    if (state.reach) {
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' }));
      });
      await sleep(700);
    } else {
      // Drifted off the anchor — walk back onto it for a moment.
      await page.evaluate((post) => {
        const d = window.__dawned;
        const self = d.connection.renderPosition();
        d.input.yaw = Math.atan2(post.x - self.x, post.z - self.z);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      }, POST);
      await sleep(500);
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      });
      await sleep(500);
    }
  }
  await page.waitForSelector('.vd-rows', { timeout: 15000 });
  ok(`vendor panel open: ${vendorId}`);
  await shoot(page, 'p8-04-vendor.png');

  // Sell something and watch the purse move, then buy it back for the same.
  await ops('/ops/grant', { player: CHARACTER, itemId: 'item_junk_cracked_shell', qty: 3 });
  await sleep(700);
  const goldBeforeSale = await page.evaluate(() => window.__dawned.inventoryState().gold);
  await page.click('.vd-tabs >> text=sell');
  await page.locator('.vd-row:has-text("Cracked Glub Shell") button').first().click();
  const afterSale = await until(
    page,
    (baseline) => {
      const gold = window.__dawned.inventoryState().gold;
      return gold > baseline ? gold : null;
    },
    { label: 'the sale to pay out', arg: goldBeforeSale },
  );
  ok(`sold junk: ${goldBeforeSale} → ${afterSale} gold`);

  await page.click('.vd-tabs >> text=buyback');
  await page.locator('.vd-row button').first().click();
  const afterBuyback = await until(
    page,
    (baseline) => {
      const gold = window.__dawned.inventoryState().gold;
      return gold < baseline ? gold : null;
    },
    { label: 'the buyback to charge', arg: afterSale },
  );
  ok(`bought back: ${afterSale} → ${afterBuyback} gold`);
  await shoot(page, 'p8-05-traded.png');

  // -------------------------------------------------------- 4. persistence
  const finalState = await page.evaluate(() => window.__dawned.inventoryState());
  await page.evaluate(() => {
    window.__dawned.connection.disconnect();
  });
  await sleep(1500);
  await enterWorld();
  const relogged = await until(page, () => {
    const state = window.__dawned.inventoryState();
    return state.cells.length > 0 ? state : null;
  });
  if (relogged.equipment.mainhand?.itemId !== finalState.equipment.mainhand?.itemId) {
    fail('the paper-doll did not survive the relog');
  }
  if (relogged.gold !== finalState.gold) {
    fail(`purse drifted across the relog: ${finalState.gold} → ${relogged.gold}`);
  }
  ok(`relog: ${relogged.cells.length} cells, ${relogged.gold} gold, paper-doll intact`);
  await shoot(page, 'p8-06-relog.png');

  const fatal = pageErrors.filter((error) => !/favicon|ResizeObserver/i.test(error));
  if (fatal.length > 0) fail(`page errors during the run:\n  ${fatal.slice(0, 4).join('\n  ')}`);

  await browser.close();
  console.log('\n🎒 P8 smoke passed — a real kill paid out, the pack works, the vendor trades.\n');
};

main().catch(async (error) => {
  console.error(`\n❌ ${error.message}`);
  if (livePage) {
    // What the bot was doing when it gave up — a re-run costs minutes.
    const bot = await livePage
      .evaluate(() => {
        const self = window.__dawned?.connection?.renderPosition?.() ?? null;
        const enemies = window.__dawned?.enemies?.() ?? [];
        return JSON.stringify({
          bot: window.__p8bot ?? null,
          pos: self && { x: Math.round(self.x), z: Math.round(self.z) },
          dead: window.__dawned?.combatState?.().dead ?? null,
          enemiesInSight: enemies.filter((enemy) => !enemy.dead).length,
        });
      })
      .catch(() => '<unavailable>');
    console.error(`   bot: ${bot}`);
    await shoot(livePage, 'p8-99-failure.png');
  }
  console.error('');
  process.exit(1);
});
