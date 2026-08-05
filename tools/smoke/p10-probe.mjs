#!/usr/bin/env node
/**
 * P10-F look-at-it probe: walk to a real node, gather it, and read what the
 * screen says. Not the phase's DoD run (that is P10-G) — this is the pass that
 * exists because rendering bugs do not fail tests.
 *
 * Usage: node tools/smoke/p10-probe.mjs [--screenshots DIR]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.env.SMOKE_API ?? 'http://127.0.0.1:8081';
const CLIENT_URL = process.env.SMOKE_CLIENT ?? 'http://localhost:5173';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
const ACCOUNT = 'p10probe';
const CHARACTER = 'Woodsy';
const shotIndex = process.argv.indexOf('--screenshots');
const SHOTS = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;

const ok = (m) => console.log(`✅ ${m}`);
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
const shoot = async (page, name) => {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
};

const run = async () => {
  const token = await ensureAccount(BASE_URL, ACCOUNT, PASSWORD);
  await ensureCharacter(BASE_URL, token, CHARACTER, 'warrior');

  // Small viewport on purpose. The fishing minigame gives the player a 0.8 s
  // window to answer a bite, and a headless software renderer at 1440p blocks
  // the main thread for ~250 ms a frame — so the browser cannot see the bite,
  // let alone answer it, and the run would be measuring this container's
  // fill rate instead of the game. Everything asserted here is DOM and state,
  // never pixel positions, so the smaller frame costs the run nothing.
  const browser = await chromium.launch();
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
  await page.click(`.char-card:has-text("${CHARACTER}")`);
  await page.getByText('ENTER WORLD', { exact: true }).click();
  await page.waitForSelector('.hud', { timeout: 60000 });
  await page.waitForFunction(() => window.__dawned?.connection?.status === 'playing', null, {
    timeout: 60000,
  });
  ok('in world');

  // Find a birch from the server's own node list, then teleport next to it.
  const placements = await (await fetch(`${BASE_URL}/api/health`)).json();
  const bake = placements.mapVersion;
  const nodes = await (await fetch(`${CLIENT_URL}/assets/map/${bake}/placements.json`)).json();
  const birch = nodes.nodes.find((n) => n.nodeId === 'node_woodcutting_birch');
  if (!birch) fail('no birch placement in the live bake');
  // Bring back whatever an earlier run chopped: respawns are 90–180 s by
  // design, which is right in play and would make this run depend on how long
  // ago the last one was.
  await ops('/ops/respawnnodes', {});
  await ops('/ops/tp', { player: CHARACTER, x: birch.x + 1.6, z: birch.z });
  // Wait for the node layer to BUILD rather than sleeping a guess: it loads
  // every baked nature model before it can place anything, which takes longer
  // than world entry does. Reading the state early reports an empty world and
  // reads as "nodes are broken" — it cost one whole run to learn that.
  await page.waitForFunction(() => window.__dawned.gatheringState().nodes.total > 0, null, {
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__dawned.gatheringState().inReach !== null, null, {
    timeout: 30000,
  });

  const state = await page.evaluate(() => window.__dawned.gatheringState());
  // Professions PERSIST, so this fixture arrives with whatever earlier runs
  // earned it. Measure the delta: an absolute `xp > 0` fails the moment a run
  // happens to finish on a level-up, when xp resets to 0 — which is exactly
  // how this assertion first went red.
  const before = new Map(state.professions.map((p) => [p.profession, p]));
  const advanced = (now, key) => {
    const was = before.get(key);
    const is = now.find((p) => p.profession === key);
    if (!is || !was) return false;
    return is.level > was.level || is.xp > was.xp;
  };
  console.log('   nodes:', JSON.stringify(state.nodes));
  console.log('   inReach:', JSON.stringify(state.inReach));
  console.log('   prompt:', state.prompt);
  if (state.nodes.total === 0) fail('the client built no nodes at all');
  if (state.nodes.seated === 0) fail('no node ever seated on real ground');
  if (!state.inReach) fail('standing next to a birch and nothing is in reach');
  if (!state.prompt?.startsWith('F — Chop')) fail(`prompt reads "${state.prompt}"`);
  ok(`${state.nodes.seated}/${state.nodes.total} nodes seated; prompt: ${state.prompt}`);
  await shoot(page, 'p10-prompt.png');

  // Gather it.
  await page.evaluate((id) => {
    window.__dawned.sendGatherOp({ kind: 'start', placementId: id });
  }, state.inReach.placementId);
  // WAIT for the channel rather than sleeping a guess and reading once. The op
  // goes up, the server opens the hold and the state comes back down on the
  // next snapshot — one round trip plus a tick, which a fixed 400 ms sleep
  // loses to on a cold machine. That miss reported "the hold never opened"
  // while the server was demonstrably completing the whole gather.
  //
  // Read the BAR in the same predicate, not afterwards: a screenshot taken
  // after the wait resolves can easily land past the 3 s channel on a 4 fps
  // headless frame budget, and "the bar is not in the picture" would then be
  // reporting the race rather than the UI. The DOM read cannot race.
  const channel = await page
    .waitForFunction(
      () => {
        const state = window.__dawned.gatheringState();
        const bar = document.querySelector('[data-gather]');
        const fill = document.querySelector('[data-gather-fill]');
        const name = document.querySelector('[data-gather-name]');
        if (!state.channel || !bar || bar.hidden) return null;
        return {
          nodeId: state.channel.nodeId,
          barVisible: bar.getBoundingClientRect().width > 0,
          fillWidth: fill?.style.width ?? '',
          label: name?.textContent ?? '',
        };
      },
      null,
      { timeout: 10000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (!channel) {
    // A refusal shows in the HUD's refusal line — read it rather than
    // reporting "never opened", which describes the symptom and not the cause.
    const refusal = await page
      .locator('.hud-refusal, [data-refusal]')
      .first()
      .textContent()
      .catch(() => null);
    await shoot(page, 'p10-no-hold.png');
    fail(`the hold never opened (refusal on screen: ${refusal ?? 'none'})`);
  }
  if (!channel.barVisible) fail('the hold opened but the gather bar has no width on screen');
  if (!channel.label.toLowerCase().includes('birch')) {
    fail(`the gather bar reads "${channel.label}" — it should name what is being gathered`);
  }
  ok(`hold opened on ${channel.nodeId}; bar reads "${channel.label}" at ${channel.fillWidth}`);
  await shoot(page, 'p10-holding.png');

  // Watch the ID THIS run chopped, not a count: the depleted set is an
  // exception list that survives between runs, so "at least one node is
  // depleted" can be true without this run having felled anything.
  const chopped = state.inReach.placementId;
  await page
    .waitForFunction(
      (id) => window.__dawned.gatheringState().nodes.depletedIds.includes(id),
      chopped,
      {
        timeout: 20000,
      },
    )
    .catch(() => {});
  // The bag + xp land with the same message that depletes the node, but the
  // codex row is a separate sync — give it a tick before reading.
  await sleep(500);
  const after = await page.evaluate(() => window.__dawned.gatheringState());
  console.log('   after:', JSON.stringify({ nodes: after.nodes, prof: after.professions }));
  if (!after.nodes.depletedIds.includes(chopped)) fail(`${chopped} never showed as depleted`);
  const wood = after.professions.find((p) => p.profession === 'woodcutting');
  if (!advanced(after.professions, 'woodcutting')) {
    fail(`woodcutting did not advance: ${JSON.stringify(after.professions)}`);
  }
  ok(
    `chopped: ${after.nodes.depleted} depleted, woodcutting ${wood.level} (${wood.xp} xp), codex ${wood.codex}`,
  );
  await shoot(page, 'p10-chopped.png');

  const bag = await page.evaluate(() => window.__dawned.inventoryState().cells);
  console.log('   bag:', JSON.stringify(bag));
  if (bag.length === 0) fail('nothing arrived in the pack');
  ok(`the log is in the pack: ${bag.map(([, s]) => `${s.qty}× ${s.itemId}`).join(', ')}`);

  // --- fishing (§5) --------------------------------------------------------
  // The one surface where both sides track a fast-moving thing at once, so it
  // is the one that has to be watched rather than asserted about. Walk the
  // whole state machine — cast, bite, hook, reel — and read the bar's DOM at
  // the moment it is live.
  const shoal = nodes.nodes.find((n) => n.nodeId.startsWith('node_fishing_'));
  if (!shoal) fail('no fishing shoal in the live bake');
  await ops('/ops/tp', { player: CHARACTER, x: shoal.x + 1.4, z: shoal.z });
  await page.waitForFunction(
    (id) => window.__dawned.gatheringState().inReach?.placementId === id,
    shoal.id,
    { timeout: 30000 },
  );
  // Let the world finish streaming before starting a reaction test. A teleport
  // reveals a new region, and building chunk geometry blocks the main thread
  // for up to a second at a time — long enough to swallow the whole 0.8 s hook
  // window, which is a measurement of this container's chunk builder rather
  // than of the minigame.
  await page
    .waitForFunction(() => window.__dawned.terrainStats().pending === 0, null, { timeout: 60000 })
    .catch(() => {});
  await sleep(1500);
  // Arm `/ops/hook` BEFORE casting: the server answers the bite on the tick it
  // opens. Everything after that — the window check, the reel physics, the
  // catch, the xp — is the real path; only the 0.8 s reflex is stood in for,
  // the same way `/ops/hurt` stands in for a P9 bot that cannot dodge.
  await ops('/ops/hook', { player: CHARACTER, bites: 10 });

  // Install the angler IN THE PAGE, because the reel is an aiming game and
  // something has to aim. The autopilot reads the same two things the player
  // reads — where the marker is, where the catch zone is — straight off the
  // DOM, so it is playing the drawn bar rather than a private copy of it. It
  // also re-casts on a miss, which is what the design says a miss is for: the
  // spot is not depleted by a fish that got away.
  await page.evaluate((id) => {
    const w = window;
    w.__fish = { phases: [], drift: 0, casts: 0, reeled: false, maxGapMs: 0 };
    let lastTickAt = performance.now();
    const origin = w.__dawned.connection.renderPosition();
    let lastCastAt = 0;
    w.__fishTimer = window.setInterval(() => {
      const tickAt = performance.now();
      w.__fish.maxGapMs = Math.max(w.__fish.maxGapMs, Math.round(tickAt - lastTickAt));
      lastTickAt = tickAt;
      const here = w.__dawned.connection.renderPosition();
      w.__fish.drift = Math.max(
        w.__fish.drift,
        Math.hypot(here.x - origin.x, here.y - origin.y, here.z - origin.z),
      );
      const state = w.__dawned.gatheringState().fishing;
      const phase = state?.phase ?? 'none';
      if (w.__fish.phases[w.__fish.phases.length - 1] !== phase) w.__fish.phases.push(phase);
      if (phase === 'reeling') {
        w.__fish.reeled = true;
        // Track a VELOCITY, not a position. Holding accelerates at 6/s² and
        // letting go at −3/s², so one 250 ms frame takes the marker from rest
        // to the 1.5/s cap: a bang-bang "hold if below the fish" controller
        // oscillates end to end at this frame rate. Aiming at a target speed
        // makes the controller pick its own duty cycle (hovering is 1 frame
        // held in 3), which is what a hand does without thinking about it.
        // Reads the same reel and fish the HUD draws from — no private sim.
        const reel = w.__dawned.connection.reelState;
        const fish = w.__dawned.connection.fishPositionNow;
        if (fish === null) return;
        const want = Math.max(-1.5, Math.min(1.5, (fish - reel.marker) * 3));
        w.__dawned.setReel(reel.velocity < want);
        return;
      }
      // The bite is answered by `/ops/hook`, armed before the cast. This page
      // cannot do it: the main thread stalls for ~1 s at a time building chunk
      // geometry, which is longer than the whole 0.8 s window, so a press from
      // here would be measuring the container's frame budget rather than the
      // minigame. Measured margins on this box: -672 to +203 ms.
      if (phase === 'bite') return;
      // Re-cast on ANY ended attempt, reeled or not: losing the fish at the bar
      // is the common outcome for an autopilot that can only correct once a
      // frame, and gating on "have I ever reeled" latched after the first loss
      // and then waited out the timeout doing nothing.
      if (phase !== 'none' || w.__fish.casts >= 10) return;
      const now = performance.now();
      if (now - lastCastAt < 900) return;
      lastCastAt = now;
      w.__fish.casts++;
      w.__dawned.sendGatherOp({ kind: 'start', placementId: id });
    }, 30);
  }, shoal.id);

  const waiting = await page
    .waitForFunction(
      () => {
        const state = window.__dawned.gatheringState().fishing;
        const line = document.querySelector('[data-fish-line]');
        const el = document.querySelector('[data-fish]');
        if (!state || el?.hidden !== false) return null;
        return { phase: state.phase, line: line?.textContent ?? '' };
      },
      null,
      { timeout: 15000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (!waiting) fail('the line never went out — no fishing UI after casting');
  ok(`cast: phase "${waiting.phase}", line reads "${waiting.line}"`);
  await shoot(page, 'p10-fish-cast.png');

  // The bite comes 2–6 s after each cast; the in-page angler answers it and
  // re-casts on a miss, so this waits for a REEL rather than for one bite.
  const hooked = await page
    .waitForFunction(() => window.__fish.reeled, null, { timeout: 90000 })
    .then(() => true)
    .catch(() => false);
  if (!hooked) {
    // Report the drift with it: the server breaks a hold when the player moves
    // more than the break range, and a shoal sits in water, so "did the cast
    // die because the fisher floated away?" is the first question.
    const seen = await page.evaluate(() => window.__fish);
    const why = await page
      .locator('.hud-refusal')
      .first()
      .textContent()
      .catch(() => null);
    fail(
      `${seen.casts} casts and never reeled — phases ${JSON.stringify(seen.phases)}, worst timer gap ${seen.maxGapMs} ms, drifted ${seen.drift.toFixed(2)} m, screen says "${why ?? 'nothing'}"`,
    );
  }
  await shoot(page, 'p10-fish-bite.png');

  const reeling = await page
    .waitForFunction(
      () => {
        const state = window.__dawned.gatheringState().fishing;
        const bar = document.querySelector('[data-fish-bar]');
        const zone = document.querySelector('[data-fish-zone]');
        const marker = document.querySelector('[data-fish-marker]');
        if (state?.phase !== 'reeling' || bar?.hidden !== false) return null;
        const box = bar.getBoundingClientRect();
        return {
          barWidth: box.width,
          zoneLeft: zone?.style.left ?? '',
          zoneWidth: zone?.style.width ?? '',
          markerLeft: marker?.style.left ?? '',
          markerHalf: state.markerHalf,
        };
      },
      null,
      { timeout: 15000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (!reeling) {
    const seen = await page.evaluate(() => window.__fish.phases);
    fail(`hooked the bite but the reel bar never appeared — phases ${JSON.stringify(seen)}`);
  }
  if (reeling.barWidth <= 0) fail('the reel bar is in the DOM with no width on screen');
  if (!reeling.zoneWidth || reeling.zoneWidth === '0%') {
    fail('the catch zone has no width — there is nothing to aim at');
  }
  console.log('   reel bar:', JSON.stringify(reeling));
  await shoot(page, 'p10-fish-reel.png');

  // The marker has to actually MOVE, or the minigame is a picture of a
  // minigame. Two reads a beat apart, through the shipped simulation.
  const markerA = await page.evaluate(
    () => document.querySelector('[data-fish-marker]')?.style.left ?? '',
  );
  await sleep(600);
  const markerB = await page.evaluate(
    () => document.querySelector('[data-fish-marker]')?.style.left ?? '',
  );
  if (markerA === markerB) fail(`the reel marker never moved (stuck at ${markerA})`);
  ok(`reeling: zone ${reeling.zoneWidth} wide, marker ${markerA} → ${markerB}`);

  // Landing one is measured by `tools/smoke/fishing-probe.mjs`, not here.
  // The reel is an aiming game and the client only steps the bar once a frame;
  // this container renders it at ~4 fps, which gives an autopilot four
  // corrections a second against a fish that moves continuously. It reads as
  // "the bar cannot be won" when what it means is "nobody could play at four
  // frames a second". The headless probe plays the SAME server at the tick
  // rate and lands fish, which is the claim worth making. What a browser can
  // prove is that the UI exists and is live, and that is what is asserted
  // above.
  const settled = await page.evaluate(() => window.__fish);
  await page.evaluate(() => {
    window.clearInterval(window.__fishTimer);
    window.__dawned.setReel(false);
  });
  console.log(`   ${settled.casts} cast(s), phases:`, JSON.stringify(settled.phases));
  console.log(`   worst main-thread stall: ${settled.maxGapMs} ms (the hook window is 800 ms)`);
  ok('the fishing minigame runs on screen: line → bite → reel bar with a live marker');
  await shoot(page, 'p10-fish-done.png');

  // The J panel.
  await page.evaluate(() => {
    window.__dawned.setPanel('professions');
  });
  await page.waitForSelector('[data-panel="professions"]', { timeout: 10000 });
  const rows = await page.$$eval('.prof-row', (els) =>
    els.map((el) => el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80)),
  );
  console.log('   J panel:', JSON.stringify(rows, null, 1));
  if (rows.length !== 4) fail(`the J panel should show four professions, saw ${rows.length}`);
  await shoot(page, 'p10-panel.png');
  ok('the J panel lists all four professions with their codex');

  if (errors.length) fail(`console errors: ${errors.slice(0, 5).join(' | ')}`);
  ok('no console errors');
  await browser.close();
  console.log('\n🌿 p10 probe passed\n');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
