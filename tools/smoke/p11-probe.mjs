#!/usr/bin/env node
/**
 * P11-D look-at-it probe: walk up to Marla, read what the screen says, take a
 * quest, and open every surface the phase shipped.
 *
 * Not the phase's DoD run (that is P11-E) — this is the pass that exists
 * because rendering bugs do not fail tests. Every P-phase that skipped it
 * shipped something invisible: a panel with no stylesheet, a nameplate clipped
 * at 17 characters, a cast bar the gateway never sent. Everything asserted here
 * is DOM and state, never pixel positions.
 *
 * Usage: node tools/smoke/p11-probe.mjs [--screenshots DIR]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.env.SMOKE_API ?? 'http://127.0.0.1:8081';
const CLIENT_URL = process.env.SMOKE_CLIENT ?? 'http://localhost:5173';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
const ACCOUNT = 'p11probe';
const CHARACTER = 'Seeker';
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
const shoot = async (page, name) => {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
};

const run = async () => {
  const token = await ensureAccount(BASE_URL, ACCOUNT, PASSWORD);
  await ensureCharacter(BASE_URL, token, CHARACTER, 'warrior');

  // Small viewport for the same reason p10-probe uses one: a headless software
  // renderer at 1440p spends a quarter second a frame, and nothing here is
  // measured in pixels.
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
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

  // Where everything stands comes from the LIVE bake, not from a constant here:
  // the owner can move Marla in the map editor and republish, and a probe that
  // hard-coded her spot would fail for the wrong reason.
  const health = await (await fetch(`${BASE_URL}/api/health`)).json();
  const placements = await (
    await fetch(`${CLIENT_URL}/assets/map/${health.mapVersion}/placements.json`)
  ).json();
  // Torv rather than Marla for the accept flow: his "Glubs on the Tideline" is
  // the level-1 quest with no prerequisites, and Marla's gates at level 2. A
  // probe that talked to Marla at level 1 would get a BARK — correct behaviour,
  // and a confusing failure.
  const torv = (placements.npcs ?? []).find((n) => n.npcId === 'npc_torv');
  const marla = (placements.npcs ?? []).find((n) => n.npcId === 'npc_marla');
  if (!torv) fail('no npc_torv placement in the live bake');
  const board = (placements.interactables ?? []).find((i) => i.id === 'board_dawnhaven');
  const shrine = (placements.interactables ?? []).find((i) => i.kind === 'shrine');
  const vista = (placements.pois ?? []).find((p) => p.kind === 'vista');
  if (!marla) fail('no npc_marla placement in the live bake');
  if (!board) fail('no notice board in the live bake');
  note(
    `bake ${health.mapVersion}: ${placements.npcs?.length ?? 0} npcs, ` +
      `${placements.interactables?.length ?? 0} interactables, ${placements.pois?.length ?? 0} pois`,
  );

  /**
   * Teleport, then WAIT for the thing to be reachable rather than sleeping.
   *
   * A fixed sleep is the classic harness bug of this codebase: an object is
   * hidden until its terrain chunk streams, so a long hop across the island
   * needs however long the stream needs — and a run that slept 2.5 s and then
   * read the prompt failed at a shrine that was working perfectly.
   */
  const goTo = async (x, z, label, expect = null) => {
    await ops('/ops/tp', { player: CHARACTER, x, z });
    if (expect) {
      await page
        .waitForFunction(
          (pattern) => {
            const el = document.querySelector('[data-interact]');
            return el && !el.hidden && new RegExp(pattern).test(el.textContent ?? '');
          },
          expect,
          { timeout: 30000 },
        )
        .catch(() => {
          throw new Error(`nothing matching /${expect}/ came into reach at ${label}`);
        });
    } else {
      await sleep(2500);
    }
    note(`at ${label} (${x.toFixed(0)}, ${z.toFixed(0)})`);
  };

  // A run has to start from the same place every time. The fixture character
  // persists, so a second run would meet Torv holding his quest already and
  // get the IN-PROGRESS line — correct behaviour, wrong thing to measure.
  await ops('/ops/quest', { player: CHARACTER, quest: 'quest_shore_glub_tide', drop: true });
  await sleep(600);

  // --- 1. the villager is THERE, and the prompt says their name -------------
  await goTo(torv.x + 1.4, torv.z + 1.4, 'Torv', 'Talk to Torv');
  const prompt = await page.textContent('[data-interact]');
  ok(`interact prompt: "${prompt?.trim()}"`);
  await shoot(page, '01-npc-prompt.png');

  // --- 2. talking opens the conversation ------------------------------------
  await page.keyboard.press('KeyF');
  await page.waitForSelector('.dlg', { timeout: 20000 });
  // Wait for the typewriter rather than racing it — an empty line would pass a
  // "the panel exists" check while telling the player nothing.
  await page.waitForFunction(
    () => (document.querySelector('[data-dialogue-text]')?.textContent ?? '').length > 20,
    null,
    { timeout: 15000 },
  );
  const speaker = await page.textContent('.dlg-speaker');
  const line = (await page.textContent('[data-dialogue-text]'))?.trim() ?? '';
  const choices = await page.$$eval('.dlg-choice', (els) =>
    els.map((el) => ({ action: el.dataset.action, text: el.textContent?.trim() })),
  );
  if (choices.length === 0) fail('the conversation opened with no choices');
  ok(`dialogue: ${speaker} — "${line.slice(0, 60)}…" (${choices.length} choices)`);
  note(choices.map((c) => `${c.action}: ${c.text}`).join(' | '));
  await shoot(page, '02-dialogue.png');

  // --- 3. accepting puts it in the journal AND on the tracker ---------------
  const accept = choices.findIndex((c) => c.action === 'accept');
  if (accept === -1) {
    fail(`Torv offered nothing to accept (actions: ${choices.map((c) => c.action).join(',')})`);
  }
  await page.click(`.dlg-choice[data-choice="${accept}"]`);
  await page.waitForFunction(
    () => (window.__dawned?.connection?.questLog?.quests ?? []).length > 0,
    null,
    { timeout: 15000 },
  );
  const held = await page.evaluate(() =>
    (window.__dawned?.connection?.questLog?.quests ?? []).map((q) => ({
      id: q.questId,
      name: q.name,
      step: q.step,
      target: q.target,
    })),
  );
  ok(`accepted — the log holds ${held.length}: ${held.map((q) => q.name).join(', ')}`);

  await page.waitForSelector('.hud-track', { timeout: 15000 });
  const tracker = await page.$$eval('.hud-track', (els) =>
    els.map((el) => ({
      name: el.querySelector('.hud-track-name')?.textContent,
      steps: [...el.querySelectorAll('.hud-track-step')].map((s) => s.textContent?.trim()),
    })),
  );
  if (tracker.length === 0) fail('the quest is held but the tracker is empty');
  ok(`tracker shows: ${tracker[0].name} — ${tracker[0].steps.join(' / ')}`);
  await shoot(page, '03-tracker.png');

  // --- 4. the journal reads back the prose ---------------------------------
  await page.keyboard.press('KeyL');
  await page.waitForSelector('[data-panel="journal"]', { timeout: 15000 });
  const prose = (await page.textContent('.jr-prose'))?.trim() ?? '';
  if (prose.length < 20) fail(`journal prose is empty or stubby: "${prose}"`);
  const journalSteps = await page.$$eval('.jr-step', (els) =>
    els.map((el) => el.textContent?.trim()),
  );
  ok(`journal: "${prose.slice(0, 70)}…" · ${journalSteps.length} step line(s)`);
  await shoot(page, '04-journal.png');
  await page.keyboard.press('Escape');

  // --- 5. the world map draws, with fog ------------------------------------
  await page.keyboard.press('KeyM');
  await page.waitForSelector('[data-panel="map"]', { timeout: 15000 });
  // Measure PIXELS: a canvas that mounted and drew nothing is exactly the class
  // of bug this run exists for (the P9 boss frame that never appeared).
  const drawn = await page.evaluate(() => {
    const canvas = document.querySelector('[data-worldmap]');
    if (!canvas) return { ok: false, reason: 'no canvas' };
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return { ok: true, distinctColours: seen.size };
  });
  if (!drawn.ok || drawn.distinctColours < 3) {
    fail(`the world map canvas is blank (${JSON.stringify(drawn)})`);
  }
  const hops = await page.$$eval('.wm-hop', (els) =>
    els.map((el) => ({ text: el.textContent?.trim(), disabled: el.disabled })),
  );
  ok(`world map drew (${drawn.distinctColours} distinct colours) · ${hops.length} shrine hop(s)`);
  if (hops.length > 0)
    note(hops.map((h) => `${h.text}${h.disabled ? ' [locked]' : ''}`).join(' | '));
  await shoot(page, '05-worldmap.png');
  await page.keyboard.press('Escape');

  // --- 5b. a villager with nothing quest-shaped still speaks ----------------
  // Marla's only quest gates at level 2, so a fresh character gets her BARK.
  // That is the design (§3, "cheap life") and it is worth checking, because a
  // villager who answers `F` with silence reads as a broken key.
  if (marla) {
    await goTo(marla.x + 1.4, marla.z + 1.4, 'Marla', 'Talk to Marla');
    await page.keyboard.press('KeyF');
    await sleep(1500);
    const spoke = await page.evaluate(
      () =>
        document.querySelector('.dlg') !== null ||
        [...document.querySelectorAll('.hud-toast')].some((t) => (t.textContent ?? '').length > 4),
    );
    if (!spoke) fail('pressed F on Marla and nothing appeared — no dialogue and no bark');
    ok('Marla answered (a gated quest gives a bark, not silence)');
    await shoot(page, '05b-bark.png');
    await page.keyboard.press('Escape');
  }

  // --- 6. the notice board hands out work with nobody standing there --------
  await goTo(board.x + 1.2, board.z + 1.2, 'the Dawnhaven board', 'Notice Board');
  const boardPrompt = await page.textContent('[data-interact]').catch(() => null);
  if (!boardPrompt || !/F —/.test(boardPrompt)) {
    fail(`no prompt at the notice board (saw "${boardPrompt}")`);
  }
  ok(`board prompt: "${boardPrompt.trim()}"`);
  await page.keyboard.press('KeyF');
  await page.waitForSelector('.dlg', { timeout: 15000 }).catch(() => null);
  const posting = await page.evaluate(() => {
    const panel = document.querySelector('.dlg');
    if (!panel) return null;
    return {
      speaker: panel.querySelector('.dlg-speaker')?.textContent?.trim(),
      text: panel.querySelector('[data-dialogue-text]')?.textContent?.trim(),
      choices: [...panel.querySelectorAll('.dlg-choice')].map((el) => el.dataset.action),
    };
  });
  if (!posting) fail('the notice board opened nothing — a board that cannot hand out work is dead');
  if (!posting.speaker) fail('the board posting has no speaker line');
  if (!posting.choices.includes('accept')) {
    fail(`the posting offers no way to take it (${posting.choices.join(',')})`);
  }
  ok(`board posting: ${posting.speaker} — "${(posting.text ?? '').slice(0, 50)}…"`);
  await shoot(page, '06-board.png');
  await page.keyboard.press('Escape');

  // --- 7. discovery fires when you walk into a POI ring ---------------------
  // Pick one this character has NOT found. The fixture persists, so a probe
  // that always walked to the same vista would prove the banner exactly once
  // and then report "already discovered" forever — which is a pass that stops
  // measuring anything.
  const known = new Set(
    await page.evaluate(() => window.__dawned?.connection?.discoveryState?.pois ?? []),
  );
  const fresh = (placements.pois ?? []).find((p) => !known.has(p.id));
  const target = fresh ?? vista;
  if (fresh) note(`${known.size} POI(s) already known; walking to the unfound "${fresh.name}"`);
  if (target) {
    await goTo(target.x, target.z, `the ${target.kind} "${target.name}"`);
    const banner = await page
      .waitForSelector('[data-discovery]:not([hidden])', { timeout: 12000 })
      .catch(() => null);
    if (banner) {
      const kind = await page.textContent('[data-discovery-kind]');
      const name = await page.textContent('[data-discovery-name]');
      ok(`discovery banner: ${kind?.trim()} — ${name?.trim()}`);
      await shoot(page, '07-discovery.png');
    } else {
      // Already discovered on an earlier run is a legitimate outcome, and
      // saying so beats failing a run for succeeding twice.
      const found = await page.evaluate(
        () => window.__dawned?.connection?.discoveryState?.pois ?? [],
      );
      if (!found.includes(target.id)) fail(`walked into ${target.id} and nothing was discovered`);
      note(`${target.id} was already discovered on an earlier run (${found.length} known)`);
    }
  }

  // --- 8. the shrine says attune, then travel ------------------------------
  if (shrine) {
    await goTo(shrine.x + 1.2, shrine.z + 1.2, shrine.name, '(Attune|Travel)');
    const shrinePrompt = await page.textContent('[data-interact]').catch(() => null);
    if (!shrinePrompt || !/(Attune|Travel)/.test(shrinePrompt)) {
      fail(`the shrine prompt does not offer attune/travel (saw "${shrinePrompt}")`);
    }
    ok(`shrine prompt: "${shrinePrompt.trim()}"`);
    await page.keyboard.press('KeyF');
    await sleep(1500);
    const attuned = await page.evaluate(
      () => window.__dawned?.connection?.discoveryState?.shrines ?? [],
    );
    if (!attuned.includes(shrine.id)) {
      fail(
        `pressed F at ${shrine.id} and it is still not attuned (${attuned.join(',') || 'none'})`,
      );
    }
    ok(`attuned to ${shrine.id}`);
    await shoot(page, '08-shrine.png');
  }

  // --- 9. villagers are actually rendered ----------------------------------
  const objectStats = await page.evaluate(() => window.__dawned?.worldObjects?.() ?? null);
  if (objectStats) {
    note(
      `world objects: ${objectStats.npcs} npcs, ${objectStats.objects} interactables, ` +
        `${objectStats.pois} pois, ${objectStats.seated} seated on real ground`,
    );
    if (objectStats.seated === 0) fail('nothing is seated — every villager is under the island');
  }

  const fatal = errors.filter((e) => !/favicon|ResizeObserver/i.test(e));
  if (fatal.length > 0) fail(`console errors:\n${fatal.slice(0, 6).join('\n')}`);

  await browser.close();
  console.log('\n📜 P11 client surfaces are on screen.\n');
};

run().catch((error) => {
  fail(error.stack ?? String(error));
});
