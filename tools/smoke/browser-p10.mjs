#!/usr/bin/env node
/**
 * P10-G — the Gathering Professions DoD run (PROFESSIONS.md, ROADMAP P10).
 *
 * Three claims, all made against a running server with real browser clients:
 *
 *  1. **Two players, one node.** §1.1's first-tap rule has to be a REFUSAL, not
 *     a race: the second player is told "someone else got there first" the
 *     moment they press, rather than channelling for three seconds and finding
 *     out at the end. Proven with two Chromium clients standing on one birch.
 *  2. **A profession taken 1 → 10 for real.** No `/ops/setprof`, no fabricated
 *     XP: the bot chops until the level says 10, the tier gate at 7 is proven
 *     shut before and open after, and the run REPORTS what it cost — gathers
 *     and wall-clock — because "level 30 ≈ a focused casual week" (§1.3) is a
 *     claim nobody has ever measured.
 *  3. **It survives a relog.** Profession levels and the codex are write-through
 *     server state, so the second login has to agree with the first.
 *
 * Respawns are 90–180 s by design (§1.1 step 4), which is right in play and
 * would make this run an afternoon, so the grind stands on one node and calls
 * `/ops/respawnnodes` between chops. That is exactly what the lever is for
 * (ARCHITECTURE.md §3) and it changes nothing about the loop being measured:
 * every gather is a real 3 s channel the server validated and paid out.
 *
 * The fishing bar is NOT measured here — see `tools/smoke/fishing-probe.mjs`.
 * The reel is stepped once per frame and this scene renders at ~4 fps headless,
 * which is not enough corrections a second to hold a marker in a catch zone; a
 * browser run could only ever report the container's frame budget.
 *
 * Usage: node tools/smoke/browser-p10.mjs [--screenshots DIR]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  BinaryReader,
  PROTOCOL_VERSION,
  ServerOp,
  decodeJsonEnvelope,
  decodeSnapshot,
  encodeGatherOp,
  encodeHello,
  encodeInputIntent,
  peekOpcode,
} from '@dawned/shared';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.env.SMOKE_API ?? 'http://127.0.0.1:8081';
const CLIENT_URL = process.env.SMOKE_CLIENT ?? 'http://localhost:5173';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
/** The profession the run takes to 10, and the level it has to reach. */
const PROFESSION = 'woodcutting';
const TARGET_LEVEL = 10;
/** The tier-2 gate from §1.3 — proven shut below it and open above. */
const T2_GATE = 7;

const shotIndex = process.argv.indexOf('--screenshots');
const SHOTS = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;

const ok = (m) => console.log(`✅ ${m}`);
const note = (m) => console.log(`   ${m}`);
const fail = (m) => {
  console.error(`\n❌ ${m}\n`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ops = async (route, body) => {
  const r = await fetch(`${BASE_URL}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-secret': OPS_SECRET },
    body: JSON.stringify(body),
  });
  if (!r.ok) fail(`${route}: ${r.status} ${await r.text()}`);
  return r.json();
};
const shoot = async (client, name) => {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await client.page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
};

/** Bring a browser client into the world, standing where it is told. */
const enterWorld = async (browser, account, character) => {
  const token = await ensureAccount(BASE_URL, account, PASSWORD);
  await ensureCharacter(BASE_URL, token, character, 'warrior');
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript((t) => {
    localStorage.setItem('dawned.token', t);
  }, token);
  await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.char-card', { timeout: 60000 });
  await page.click(`.char-card:has-text("${character}")`);
  await page.getByText('ENTER WORLD', { exact: true }).click();
  await page.waitForSelector('.hud', { timeout: 60000 });
  await page.waitForFunction(() => window.__dawned?.connection?.status === 'playing', null, {
    timeout: 60000,
  });
  return { page, errors, character };
};

/**
 * A protocol-only client, for the parts of the run a browser makes slower
 * rather than truer.
 *
 * The grind is thousands of seconds of channelling and nothing else; driven
 * through two Chromium tabs on one core it measured **32 s per gather**, almost
 * all of it renderer and evaluate round-trips, which would put 1 → 10 at four
 * hours. Headless it is the 3 s hold and nothing else. Every gather is still a
 * real `GatherOp` the server validates, claims, times and pays out — the only
 * thing dropped is the drawing of it, which the browser legs above and below
 * cover.
 */
class GatherClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.welcome = null;
    this.snapshot = null;
    this.professions = null;
    this.gather = null;
    this.lastRefusal = null;
    this.seq = 0;
    this.socket.on('message', (data) => {
      const bytes = new Uint8Array(data);
      const opcode = peekOpcode(bytes);
      const reader = new BinaryReader(bytes);
      reader.u8();
      if (opcode === ServerOp.Welcome) this.welcome = decodeJsonEnvelope(reader);
      else if (opcode === ServerOp.Snapshot) this.snapshot = decodeSnapshot(reader);
      else if (opcode === ServerOp.ProfessionSync) this.professions = decodeJsonEnvelope(reader);
      else if (opcode === ServerOp.GatherState) {
        const message = decodeJsonEnvelope(reader);
        this.gather = message;
        if (message.phase === 'refused' || message.phase === 'cancelled') {
          this.lastRefusal = message.reason ?? null;
        }
      }
    });
  }

  async connect(token, characterId) {
    await this.opened;
    this.socket.send(encodeHello({ protocolVersion: PROTOCOL_VERSION, token, characterId }));
    const deadline = Date.now() + 10000;
    while (!this.snapshot && Date.now() < deadline) await sleep(20);
    if (!this.snapshot) fail('the headless gatherer never received a snapshot');
    while (!this.professions && Date.now() < deadline) await sleep(20);
    if (!this.professions) fail('the headless gatherer never received a profession sync');
  }

  /** Keep the input stream alive; the server drops a silent client. */
  tick() {
    this.seq = (this.seq + 1) & 0xffff;
    this.socket.send(encodeInputIntent({ seq: this.seq, moveX: 0, moveZ: 0, yaw: 0, buttons: 0 }));
  }

  level(profession) {
    return this.professions?.professions.find((p) => p.profession === profession) ?? null;
  }

  /**
   * One real hold, start to payout.
   *
   * Waits for its OWN `start` before it will believe any ending. The server
   * treats a start-while-holding as a switch and cancels the old channel
   * first, so a bare `cancelled` can be the tail of the previous gather rather
   * than the fate of this one — reading it as this one's answer stopped a run
   * dead at gather 125 with "no reason given".
   *
   * Returns the `done` message, or `{ broken, reason }` for a hold that opened
   * and did not finish, or `{ refused, reason }` for one that never opened.
   */
  async chop(placementId) {
    this.gather = null;
    this.lastRefusal = null;
    this.socket.send(encodeGatherOp({ kind: 'start', placementId }));

    const openBy = Date.now() + 6000;
    let opened = false;
    while (!opened && Date.now() < openBy) {
      this.tick();
      const state = this.gather;
      if (state?.phase === 'start' && state.placementId === placementId) opened = true;
      else if (state?.phase === 'refused') return { refused: true, reason: state.reason ?? null };
      else if (state?.phase === 'done' && state.placementId === placementId) return state;
      await sleep(50);
    }
    if (!opened) return { refused: true, reason: 'never opened' };

    const doneBy = Date.now() + 12000;
    while (Date.now() < doneBy) {
      this.tick();
      const state = this.gather;
      if (state?.phase === 'done') return state;
      if (state?.phase === 'cancelled' || state?.phase === 'refused') {
        return { broken: true, reason: state.reason ?? null };
      }
      await sleep(50);
    }
    return { broken: true, reason: 'timed out' };
  }

  close() {
    this.socket.close();
  }
}

/**
 * Wait until this client's node layer is built and a node of `nodeId` is in
 * reach, and return WHICH placement that turned out to be.
 *
 * Never assert a particular placement: §1.4 puts nodes in clusters of 3–6, so
 * the tree nearest the coordinates picked off the bake is routinely a
 * different one of its neighbours. What matters is standing at a birch, not at
 * that birch.
 */
const standAt = async (client, nodeId) => {
  await page(client).waitForFunction(() => window.__dawned.gatheringState().nodes.total > 0, null, {
    timeout: 60000,
  });
  const handle = await page(client).waitForFunction(
    (id) => {
      const reach = window.__dawned.gatheringState().inReach;
      return reach && reach.nodeId === id && !reach.depleted ? reach.placementId : null;
    },
    nodeId,
    { timeout: 30000 },
  );
  return handle.jsonValue();
};

/** Both clients have to be looking at the SAME node for a claim test to mean anything. */
const standTogether = async (a, b, nodeId) => {
  const mine = await standAt(a, nodeId);
  await page(b).waitForFunction(
    (id) => window.__dawned.gatheringState().inReach?.placementId === id,
    mine,
    { timeout: 30000 },
  );
  return mine;
};
const page = (client) => client.page;

const professionOf = async (client, profession) =>
  page(client).evaluate(
    (p) => window.__dawned.gatheringState().professions.find((e) => e.profession === p) ?? null,
    profession,
  );

/** The placement of `nodeId` closest to a point — what the bot will be standing at. */
const nearestOf = (placements, nodeId, at) => {
  let best = null;
  let bestD = Infinity;
  for (const node of placements.nodes) {
    if (node.nodeId !== nodeId) continue;
    const d = (node.x - at.x) ** 2 + (node.z - at.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = node;
    }
  }
  if (!best) fail(`the live bake has no ${nodeId}`);
  return best.id;
};

/** Blank the refusal line so the next read cannot pick up an older answer. */
const clearRefusal = async (client) => {
  await page(client).evaluate(() => {
    const el = document.querySelector('.hud-refusal');
    if (el) el.textContent = '';
  });
};

const run = async () => {
  console.log(`Dawned P10 DoD run → ${CLIENT_URL}\n`);

  // The world's own node list decides where this runs — never a hardcoded spot.
  const health = await (await fetch(`${BASE_URL}/api/health`)).json();
  const placements = await (
    await fetch(`${CLIENT_URL}/assets/map/${health.mapVersion}/placements.json`)
  ).json();
  const birch = placements.nodes.find((n) => n.nodeId === 'node_woodcutting_birch');
  const oak = placements.nodes.find((n) => n.nodeId === 'node_woodcutting_wealdoak');
  if (!birch || !oak) fail('the live bake needs both a birch (T1) and a wealdoak (T2)');
  note(`map ${health.mapVersion}: ${placements.nodes.length} nodes`);
  await ops('/ops/respawnnodes', {});

  const browser = await chromium.launch();
  const gatherer = await enterWorld(browser, 'p10gather', 'Woodwright');
  const rival = await enterWorld(browser, 'p10rival', 'Poacher');
  ok('two players in the world');

  // Both professions start from wherever earlier runs left them; this run needs
  // a level-1 woodcutter, and /ops/setprof is the only honest way to REWIND
  // (it sets a level and zeroes xp — the grind itself is never shortened).
  await ops('/ops/setprof', { player: 'Woodwright', profession: PROFESSION, level: 1 });
  await sleep(400);

  // ---- 1. two players, one node ------------------------------------------
  await ops('/ops/tp', { player: 'Woodwright', x: birch.x + 1.2, z: birch.z });
  await ops('/ops/tp', { player: 'Poacher', x: birch.x + 1.2, z: birch.z + 0.8 });
  const contested = await standTogether(gatherer, rival, 'node_woodcutting_birch');
  note(`both players are at ${contested}`);

  // Fire BOTH presses back to back, with nothing in between. Waiting for the
  // first player's channel to appear on screen before pressing with the second
  // takes longer than the 3 s hold at this frame rate, so the second player
  // arrives after the tree is already down and is told "already harvested" —
  // true, but not the rule under test.
  //
  // Which of the two wins is the server's business (whichever op it drains
  // first), so the assertion is the RULE: exactly one channel opens, and the
  // other player is refused, told a person beat them, and never channels.
  await clearRefusal(gatherer);
  await clearRefusal(rival);
  await Promise.all([
    page(gatherer).evaluate((id) => {
      window.__dawned.sendGatherOp({ kind: 'start', placementId: id });
    }, contested),
    page(rival).evaluate((id) => {
      window.__dawned.sendGatherOp({ kind: 'start', placementId: id });
    }, contested),
  ]);

  const settled = await Promise.all(
    [gatherer, rival].map(async (client) => {
      const handle = await page(client)
        .waitForFunction(
          () => {
            const channel = window.__dawned.gatheringState().channel;
            const refusal = document.querySelector('.hud-refusal')?.textContent ?? '';
            if (channel) return { channel: true, refusal: '' };
            return refusal.length > 0 ? { channel: false, refusal } : null;
          },
          null,
          { timeout: 10000 },
        )
        .catch(() => null);
      return handle ? handle.jsonValue() : { channel: false, refusal: '' };
    }),
  );
  await shoot(rival, 'p10g-claimed.png');
  const winners = settled.filter((r) => r.channel);
  const losers = settled.filter((r) => !r.channel);
  if (winners.length !== 1) {
    fail(`${winners.length} players opened a channel on one node — the claim is not exclusive`);
  }
  const loser = losers[0];
  if (!loser.refusal) fail('the player who lost the race was refused silently');
  if (!/first/i.test(loser.refusal)) {
    fail(
      `the loser is told "${loser.refusal.trim()}" — §1.1 wants "someone got there first", ` +
        `not a message about the node being gone`,
    );
  }
  ok(`first-tap claim holds: one channel, and the other is told "${loser.refusal.trim()}"`);

  // ---- 2. the tier gate is shut at level 1 --------------------------------
  await ops('/ops/tp', { player: 'Woodwright', x: oak.x + 1.2, z: oak.z });
  const lockedOak = await standAt(gatherer, 'node_woodcutting_wealdoak');
  await clearRefusal(gatherer);
  await page(gatherer).evaluate((id) => {
    window.__dawned.sendGatherOp({ kind: 'start', placementId: id });
  }, lockedOak);
  const gateRefusal = await page(gatherer)
    .waitForFunction(
      () => {
        const text = document.querySelector('.hud-refusal')?.textContent ?? '';
        return /profession level/i.test(text) ? text : null;
      },
      null,
      { timeout: 8000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (!gateRefusal) fail('a level-1 woodcutter was not refused the T2 wealdoak');
  ok(`the T2 gate is shut at level 1: "${gateRefusal.trim()}"`);
  await shoot(gatherer, 'p10g-tier-locked.png');

  // ---- 3. 1 → 10, for real ------------------------------------------------
  // Shut the browser COMPLETELY first, not just its pages. Two Chromium tabs
  // rendering a streamed island on one core made the first attempt at this leg
  // cost 32 s a gather; parking them at about:blank did not help, because the
  // headless shell still sat at ~97 % of the core and starved the grind's own
  // process. The grind wants a socket, not a renderer — so the renderer goes
  // away entirely, and a fresh browser comes back for the panel afterwards.
  const birchAt = { x: birch.x + 1.2, z: birch.z };
  const oakAt = { x: oak.x + 1.2, z: oak.z };
  const browserErrors = [...gatherer.errors, ...rival.errors];
  await browser.close();

  const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/game';
  const token = await ensureAccount(BASE_URL, 'p10gather', PASSWORD);
  const character = await ensureCharacter(BASE_URL, token, 'Woodwright', 'warrior');
  // The browser session has to be gone before this one is allowed in — the
  // game is single-session-per-account, which is itself worth not fighting.
  await sleep(1500);
  const bot = new GatherClient(WS_URL);
  await bot.connect(token, character.id ?? character);

  await ops('/ops/tp', { player: 'Woodwright', ...birchAt });
  // The claim leg above felled this very tree — regrow it before counting.
  await ops('/ops/respawnnodes', {});
  await sleep(600);
  const startedAt = Date.now();
  let gathers = 0;
  let broken = 0;
  let onOak = false;
  let gateOpenedAt = null;
  let lastLevel = bot.level(PROFESSION)?.level ?? 1;
  let treeId = nearestOf(placements, 'node_woodcutting_birch', birchAt);

  while (gathers < 3000) {
    const state = bot.level(PROFESSION);
    if (!state) fail('no woodcutting row in the profession sync');
    if (state.level >= TARGET_LEVEL) break;

    // The moment the gate opens, move to the T2 tree — both because it is
    // faster (24 xp vs 12) and because "the gate opened" is a claim worth
    // proving with a gather rather than with a tooltip.
    if (!onOak && state.level >= T2_GATE) {
      await ops('/ops/tp', { player: 'Woodwright', ...oakAt });
      await sleep(600);
      treeId = nearestOf(placements, 'node_woodcutting_wealdoak', oakAt);
      onOak = true;
      gateOpenedAt = { gathers, level: state.level };
      note(`level ${state.level}: the T2 gate opened, moving to the wealdoak`);
    }
    if (state.level > lastLevel) {
      const at = ((Date.now() - startedAt) / 1000).toFixed(0);
      note(`level ${state.level} after ${gathers} gathers (${at} s)`);
      lastLevel = state.level;
    }

    const result = await bot.chop(treeId);
    if (result.refused) {
      fail(`gather ${gathers + 1} was refused before it opened (${result.reason ?? 'no reason'})`);
    }
    if (result.broken) {
      // A hold the server broke is a legal outcome, not a failed run — regrow
      // and go again. It is COUNTED, because a run where half the holds break
      // is telling you something even when it finishes.
      broken++;
      if (broken > 25) fail(`${broken} holds broke — the last said "${result.reason ?? 'nothing'}"`);
      await ops('/ops/respawnnodes', {});
      continue;
    }
    gathers++;
    // Regrow it and go again. Respawns are 90–180 s by design; this is the
    // lever that exists so a test does not have to wait three minutes a tree.
    await ops('/ops/respawnnodes', {});
  }

  const elapsedS = (Date.now() - startedAt) / 1000;
  const reached = bot.level(PROFESSION);
  if (!reached || reached.level < TARGET_LEVEL) {
    fail(`stopped at woodcutting ${reached?.level ?? '?'} after ${gathers} gathers`);
  }
  if (!gateOpenedAt) fail('never crossed the T2 gate — the run proved nothing about tiers');
  const oakChops = gathers - gateOpenedAt.gathers;
  if (oakChops < 1) fail('the gate opened but no wealdoak was ever chopped');
  bot.close();
  await sleep(1200);

  ok(
    `woodcutting 1 → ${reached.level} in ${gathers} real gathers, ${elapsedS.toFixed(0)} s ` +
      `(T2 gate at gather ${gateOpenedAt.gathers}; ${oakChops} wealdoaks after it)`,
  );
  note(
    `${(elapsedS / gathers).toFixed(1)} s per gather here because the respawn lever removes the ` +
      `wait; in play each tree is a 90–180 s regrow or a walk to the next one`,
  );
  if (broken > 0) note(`${broken} hold(s) broke and were retried`);

  // ---- 4. the panel says the same thing, after a full relog ---------------
  // This login is the persistence check AND the UI check in one: the browser
  // that comes back has never seen any of the grind, so everything it draws
  // came from the server's own record of it.
  const viewer = await chromium.launch();
  const returning = await enterWorld(viewer, 'p10gather', 'Woodwright');
  await page(returning).waitForFunction(
    () => window.__dawned.gatheringState().professions.length > 0,
    null,
    { timeout: 30000 },
  );
  const after = await professionOf(returning, PROFESSION);
  if (!after || after.level !== reached.level) {
    fail(`relog disagrees: ${JSON.stringify(after)} vs level ${reached.level} before the logout`);
  }
  ok(`relog holds: woodcutting ${after.level}, codex ${after.codex}`);

  // Let the codex's own data arrive before reading it. The panel lists what a
  // profession CAN produce, which comes from the published node definitions —
  // asserting before those land tests the loader, not the panel.
  await page(returning).waitForFunction(
    () => window.__dawned.professionCatalogue('woodcutting').length > 0,
    null,
    { timeout: 30000 },
  );
  await page(returning).evaluate(() => {
    window.__dawned.setPanel('professions');
  });
  await page(returning).waitForSelector('[data-panel="professions"]', { timeout: 10000 });
  const panelRow = await page(returning).$eval(
    '.prof-row[data-profession="woodcutting"]',
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
  note(`J panel: ${panelRow.slice(0, 90)}`);
  if (!panelRow.includes(String(reached.level))) {
    fail(`the J panel does not show level ${reached.level}: "${panelRow}"`);
  }
  const codexFound = await page(returning).$$eval(
    '.prof-row[data-profession="woodcutting"] .prof-codex-cell[data-found="true"]',
    (els) => els.length,
  );
  if (codexFound === 0) fail('the codex shows nothing discovered after a hundred chops');
  ok(`the J panel agrees: level ${reached.level}, ${codexFound} codex entries found`);
  await shoot(returning, 'p10g-panel.png');

  const errors = [...browserErrors, ...returning.errors];
  if (errors.length) fail(`console errors: ${errors.slice(0, 5).join(' | ')}`);
  ok('no console errors across all three sessions');

  await viewer.close();
  console.log('\n🪓 P10 DoD run passed\n');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
