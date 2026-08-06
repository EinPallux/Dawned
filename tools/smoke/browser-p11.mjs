#!/usr/bin/env node
/**
 * P11-E — the phase DoD, measured (ROADMAP.md P11).
 *
 * > A tester who has never read our docs finds, accepts, completes and turns in
 * > a chain using only in-game affordances; the discovery loop (banner/XP/map)
 * > fires correctly for every POI type; the found-object quest works.
 *
 * WHAT "ONLY IN-GAME AFFORDANCES" MEANS HERE. This run never reads the quest
 * content or the map bake to decide what to do next. Every destination comes
 * from something the CLIENT put on screen:
 *
 *   · the tracker's step line and the journal's prose,
 *   · the hint circle the world map draws (`questLog.quests[].hint`),
 *   · the clue text for an explore step — which is prose and no marker, by
 *     design (§1 rule 4), so the run reads the compass word out of it and
 *     SEARCHES that quadrant, exactly like a player would,
 *   · `worldObjectList()` — the villagers and props this client has spawned,
 *     i.e. what you can see standing there,
 *   · the `F` prompt, which names the verb the object offers.
 *
 * It moves with `/ops/tp` rather than by walking, for the P10-G reason: a
 * container Chromium runs at ~4 fps and crossing the island on foot turns a
 * ten-minute run into an hour nobody executes. The DECISION of where to go is
 * what this run is about; the walking is not.
 *
 * Three other levers. Two are setup — they undo state a previous run left, and
 * touch nothing the run then measures — and one keeps the bot upright:
 *   · `/ops/setlevel` + a built spec + T2 gear. The chain gates at level 6 and
 *     ends on the Mushroom King, and P9-E measured that an UNSPENT level 12
 *     fights at 38 % of a built one's damage. A naked bot would fail this run
 *     for a reason that has nothing to do with quests.
 *   · `/ops/forget`. Discovery is first-entry-only by design and a quest chest
 *     stays opened, so a fixture that has already run this can never show the
 *     banner or the crate again. It forgets; the finding is the untouched path.
 *   · `/ops/hurt fraction 1` while fighting, because the bot cannot dodge — the
 *     same argument the P9 boss run ships under.
 *
 * Needs: game server on :8081 (fresh dist), client dev server on :5173, the
 * migrated dev Postgres with the P11 pilot set published. Idempotent.
 *
 * Usage: node tools/smoke/browser-p11.mjs [--screenshots DIR]
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.env.SMOKE_API ?? 'http://127.0.0.1:8081';
const CLIENT_URL = process.env.SMOKE_CLIENT ?? 'http://localhost:5173';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
const ACCOUNT = 'p11smoke';
const CHARACTER = 'Wanderer';
/** The chain's last link gates at level 8 and ends on a level-12 boss. */
const SMOKE_LEVEL = 12;
/** Mossbloom is a tier-2 herb; PROFESSIONS §1 opens tier 2 at profession 7. */
const HERB_LEVEL = 8;

/** Where a player starts, and therefore where every compass word is read from. */
const HAVEN = { x: 0, z: 275 };

/** The four links, in the order the game gates them. */
const CHAIN = [
  'quest_weald_silence_1',
  'quest_weald_silence_2',
  'quest_weald_silence_3',
  'quest_weald_silence_4',
];

const shotIndex = process.argv.indexOf('--screenshots');
const SHOTS_DIR = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;

const ok = (message) => console.log(`✅ ${message}`);
const note = (message) => console.log(`   ${message}`);
const head = (message) =>
  console.log(`\n── ${message} ${'─'.repeat(Math.max(0, 60 - message.length))}`);
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

const until = async (page, fn, { timeout = 30000, label = 'condition', arg = null } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await sleep(250);
  }
};

// ---------------------------------------------------------------------------
// Reading the game, never the content files
// ---------------------------------------------------------------------------

/** The whole quest log as the client holds it. */
const questLog = (page) =>
  page.evaluate(() => ({
    quests: window.__dawned?.connection?.questLog?.quests ?? [],
    clues: window.__dawned?.connection?.questLog?.clues ?? [],
  }));

const questEntry = async (page, questId) =>
  (await questLog(page)).quests.find((q) => q.questId === questId) ?? null;

/**
 * A monotone XP reading. The sheet carries the level and the XP INTO it, not a
 * lifetime total, so an award that levels you up reads as a smaller `xp` — a
 * naive `after > before` would call a level-up "no XP awarded".
 */
const xpMark = (page) =>
  page.evaluate(() => {
    const sheet = window.__dawned.progressionState().sheet;
    return { level: sheet?.level ?? 0, xp: sheet?.xp ?? 0 };
  });

const xpMoved = (before, after) => after.level > before.level || after.xp > before.xp;

const xpDelta = (before, after) =>
  after.level > before.level
    ? `level ${before.level} → ${after.level}`
    : `${after.xp - before.xp} xp`;

/** Toast text currently on the HUD — where the reward line and the title land. */
const toasts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.hud-toast')].map((el) => (el.textContent ?? '').trim()),
  );

/** What the client has spawned and seated — i.e. what is visibly standing there. */
const onScreen = (page) => page.evaluate(() => window.__dawned?.worldObjectList?.() ?? []);

/**
 * Teleport, then WAIT for the world to agree rather than sleeping a fixed
 * amount. Objects stay hidden until their terrain chunk has streamed, so a long
 * hop needs however long the stream needs — a fixed 2.5 s failed at a shrine
 * that was working perfectly during P11-D.
 */
const goTo = async (page, x, z, label, { expectPrompt = null, settle = 1200 } = {}) => {
  await ops('/ops/tp', { player: CHARACTER, x, z });
  if (expectPrompt) {
    /**
     * One retry through a fresh `/ops/forget`, and only for a SPENT object.
     *
     * The setup reset reports how many records it cleared, and it is truthful
     * about the server — but the client has been observed still holding
     * "emptied" for a chest the server had already un-spent, so the reset is
     * not reliably OBSERVABLE by the time the run needs it. Re-issuing it while
     * standing at the object closes that window; the run says it did so, and
     * still fails if the second attempt also finds the thing spent.
     */
    const spentNow = async () =>
      (await page.evaluate(() => window.__dawned.interactProbe()).catch(() => null))?.object
        ?.spent === true;
    if (await spentNow()) {
      note(`${label} reads as spent — re-issuing the object reset and looking again`);
      await ops('/ops/forget', { player: CHARACTER, pois: false, objects: true });
      await sleep(1500);
    }
    await page
      .waitForFunction(
        (pattern) => {
          const el = document.querySelector('[data-interact]');
          return el && !el.hidden && new RegExp(pattern).test(el.textContent ?? '');
        },
        expectPrompt,
        { timeout: 30000 },
      )
      .catch(async () => {
        // Say what the client actually believed. "No prompt" has several
        // causes that look identical from outside — the thing has not seated
        // on its terrain yet, it is out of reach, or it is SPENT (a chest that
        // is emptied reads "<name> — emptied", with no `F`, which is a
        // perfectly good prompt and simply not the one being waited for).
        const believed = await page
          .evaluate(() => window.__dawned.interactProbe())
          .catch(() => null);
        fail(
          `nothing matching /${expectPrompt}/ came into reach at ${label} — the client says ` +
            `${believed?.prompt ? `"${believed.prompt}"` : 'nothing is in reach'}` +
            `${believed?.object ? ` (${believed.object.id}, ${believed.object.distance.toFixed(1)} m, spent=${believed.object.spent})` : ''}`,
        );
      });
  } else {
    await sleep(settle);
  }
};

/**
 * Press `F` on whatever is in reach and read the conversation.
 *
 * The panel and the typewriter are checked (the DOM has to be showing it), but
 * the TEXT this run reasons about comes from `connection.dialogueState` — the
 * line the server actually sent. The typewriter renders it a character at a
 * time and a headless container throttles rAF hard, so scraping the DOM caught
 * "A crate went▍" and lost the word "east" at the end of the sentence: the
 * search that followed then failed for a reason that was entirely the
 * harness's. Presentation is worth asserting; it is not worth parsing.
 */
const talk = async (page) => {
  await page.keyboard.press('KeyF');
  await page.waitForSelector('.dlg', { timeout: 20000 });
  await until(page, () => window.__dawned.connection.dialogueState?.open != null, {
    label: 'the server to open a conversation',
    timeout: 20000,
  });
  const spoken = await page.evaluate(() => {
    const open = window.__dawned.connection.dialogueState?.open;
    return {
      speaker: open?.speaker ?? '',
      text: open?.text ?? '',
      choices: (open?.choices ?? []).map((choice, index) => ({
        index,
        action: choice.action,
        text: choice.text ?? '',
      })),
    };
  });
  const onScreenText = await page.textContent('[data-dialogue-text]').catch(() => '');
  if ((onScreenText ?? '').trim().length === 0) {
    fail(`${spoken.speaker} is talking and the panel is showing nothing`);
  }
  return spoken;
};

const pick = async (page, choices, action, where) => {
  const choice = choices.find((c) => c.action === action);
  if (!choice) {
    fail(`${where}: no "${action}" on offer (saw ${choices.map((c) => c.action).join(', ')})`);
  }
  await page.click(`.dlg-choice[data-choice="${choice.index}"]`);
  await sleep(900);
  return choice;
};

const closeDialogue = async (page) => {
  await page.keyboard.press('Escape');
  await sleep(400);
};

// ---------------------------------------------------------------------------
// The explore step: prose, no marker, and a real search
// ---------------------------------------------------------------------------

/** Compass words the game may use, and which way each one pushes from Dawnhaven. */
const COMPASS = {
  north: { dx: 0, dz: -1 },
  south: { dx: 0, dz: 1 },
  east: { dx: 1, dz: 0 },
  west: { dx: -1, dz: 0 },
};

/**
 * Pull a direction out of everything the game has told us about this step.
 *
 * An explore step is deliberately given NO map marker (§1 rule 4) — the player
 * gets a clue, and if that is not enough they go and ask again. So this reads
 * the clue, the journal prose and the giver's in-progress line, exactly the
 * three places a stuck player would look, and fails loudly if none of them
 * names a direction. That failure would be a real content bug: an explore step
 * whose prose does not point anywhere is a quest you can only finish by
 * accident.
 */
const directionFrom = (texts) => {
  const blob = texts.join(' ').toLowerCase();
  const found = Object.keys(COMPASS).filter((word) => blob.includes(word));
  if (found.length === 0) return null;
  const sum = found.reduce(
    (acc, word) => ({ dx: acc.dx + COMPASS[word].dx, dz: acc.dz + COMPASS[word].dz }),
    { dx: 0, dz: 0 },
  );
  // NORMALISE. "north-west" sums to (-1, -1), whose length is √2 — and the
  // sweep below lays its lattice along this vector, so an un-normalised
  // diagonal silently stretches the grid by 41 % and can step clean over a
  // small explore ring. The guarantee has to hold for every compass word the
  // prose might use, not just the four cardinal ones.
  const length = Math.hypot(sum.dx, sum.dz);
  return length === 0 ? null : { dx: sum.dx / length, dz: sum.dz / length };
};

/**
 * Sweep the quadrant the prose named until the step credits.
 *
 * The grid step is smaller than the smallest explore radius the pilot set uses
 * (18 m), so a legal target cannot be stepped over. What this measures is
 * whether the clue POINTS AT THE RIGHT PLACE: a quest whose prose says "east"
 * about a site in the north-west exhausts the sweep and fails, which no unit
 * test can catch because both halves are valid strings.
 */
const searchFor = async (page, questId, step, direction, label) => {
  const REACH = 320;
  /**
   * A triangular lattice at 26 m covers every disc of radius 18 m (the smallest
   * explore ring the pilot set uses) — `s ≤ r·√3` — with a third fewer probes
   * than a square grid of the same guarantee.
   */
  const SPACING = 26;
  /** How many of the nearest probes the slow retry re-walks. */
  const SLOW_PROBES = 24;
  const ROW = SPACING * 0.866;
  /**
   * A probe has to STAND there long enough to be SAMPLED.
   *
   * The server asks "have you entered somewhere?" once per 20 ticks per player,
   * not every tick — walking into a place is deliberately not a twitch event
   * (world.ts step 5). Two things follow, and the first version of this sweep
   * got both wrong:
   *
   *  · 180 ms per probe is four probes per sample. It crossed the crate's ring
   *    and was gone again before the world ever looked: 399 points, all "no".
   *  · 1150 ms is not enough EITHER, and that one only shows up under load.
   *    Twenty ticks is 1000 ms of *server* time, and a tick that slips to 60 ms
   *    while Chromium streams terrain makes it 1200. The same probe found the
   *    crate on two runs and missed it on two more — a fast-machine flake, the
   *    one this codebase keeps meeting.
   */
  const DWELL_MS = 2400;

  const probes = [];
  for (let row = 0, along = 18; along <= REACH; along += ROW, row++) {
    const offset = row % 2 === 0 ? 0 : SPACING / 2;
    for (let across = -REACH / 2 + offset; across <= REACH / 2; across += SPACING) {
      // `along` runs down the named direction; `across` is perpendicular to it.
      probes.push({
        x: HAVEN.x + direction.dx * along - direction.dz * across,
        z: HAVEN.z + direction.dz * along + direction.dx * across,
      });
    }
  }
  // Nearest-first: a player searches outward from where they were told to go,
  // which also makes the probe count a real measure of how findable a place is
  // rather than an artefact of the loop order.
  probes.sort(
    (a, b) => Math.hypot(a.x - HAVEN.x, a.z - HAVEN.z) - Math.hypot(b.x - HAVEN.x, b.z - HAVEN.z),
  );

  for (const [index, probe] of probes.entries()) {
    await ops('/ops/tp', { player: CHARACTER, x: probe.x, z: probe.z });
    await sleep(DWELL_MS);
    const entry = await questEntry(page, questId);
    // "The quest is gone" and "the quest is here and not credited" are different
    // failures, and a sweep that treats the first as the second reports the
    // WRONG one 175 probes later — the P10-G "silence looks like failure" trap.
    if (!entry) {
      // Say WHICH of the three it is. A page that reloaded, a socket that
      // dropped and a server that really let go of the quest look identical
      // from "the log is empty", and only the last is the game's problem.
      const why = await page.evaluate(() => ({
        marker: window.__p11mark ?? null,
        status: window.__dawned?.connection?.status ?? 'gone',
        held: (window.__dawned?.connection?.questLog?.quests ?? []).map((q) => ({
          id: q.questId,
          status: q.status,
        })),
      }));
      fail(
        `${label}: ${questId} left the client's log at probe ${index + 1} — ` +
          `page ${why.marker === null ? 'RELOADED' : 'intact'}, connection "${why.status}", ` +
          `log now: ${why.held.map((q) => `${q.id}:${q.status}`).join(', ') || 'empty'}`,
      );
    }
    // Where does the CLIENT think it is? `/ops/tp` moves the first player whose
    // name matches, and a stale session left behind by a killed run answers to
    // the same name — so "ok" from the lever is not proof that the character
    // this page is driving went anywhere.
    if (index === 0 || (index > 0 && index % 25 === 0)) {
      const self = await page.evaluate(() => {
        const p = window.__dawned.connection.renderPosition();
        return { x: p.x, z: p.z };
      });
      const drift = Math.hypot(self.x - probe.x, self.z - probe.z);
      if (drift > 8) {
        fail(
          `${label}: teleported to (${probe.x.toFixed(0)}, ${probe.z.toFixed(0)}) and this page ` +
            `is at (${self.x.toFixed(0)}, ${self.z.toFixed(0)}), ${drift.toFixed(0)} m away — ` +
            `the lever is moving a different "${CHARACTER}"`,
        );
      }
      if (index > 0) {
        note(`${label}: ${index} probes, still looking (step ${entry.step}/${entry.steps.length})`);
      }
    }
    if (entry.step > step) {
      const metres = Math.hypot(probe.x - HAVEN.x, probe.z - HAVEN.z);
      note(
        `${label}: found on probe ${index + 1} of ${probes.length}, ` +
          `${metres.toFixed(0)} m from Dawnhaven at (${probe.x.toFixed(0)}, ${probe.z.toFixed(0)})`,
      );
      return { probes: index + 1, at: probe };
    }
  }
  // Before blaming the content, rule out the sampling. A slow pass over the
  // nearest probes costs a minute and is the difference between "this clue
  // points at the wrong place" and "we were unlucky with a 1 Hz check".
  note(`${label}: full sweep found nothing — re-walking the nearest ${SLOW_PROBES} slowly`);
  for (const probe of probes.slice(0, SLOW_PROBES)) {
    await ops('/ops/tp', { player: CHARACTER, x: probe.x, z: probe.z });
    await sleep(5000);
    const entry = await questEntry(page, questId);
    if (entry && entry.step > step) {
      fail(
        `${label}: the ring is at (${probe.x.toFixed(0)}, ${probe.z.toFixed(0)}) and only a ` +
          `5 s dwell caught it — the world is sampling slower than this run assumes, not a ` +
          `content problem`,
      );
    }
  }
  fail(
    `${label}: swept ${probes.length} points of the quadrant the game pointed at, then ` +
      `re-walked the nearest ${SLOW_PROBES} at 5 s each, and never crossed the explore ring — ` +
      `the clue does not point where the step is`,
  );
};

// ---------------------------------------------------------------------------
// Fighting, borrowed from the P9 DoD run
// ---------------------------------------------------------------------------

const keepAlive = () => {
  const timer = setInterval(() => {
    ops('/ops/hurt', { player: CHARACTER, fraction: 1 }).catch(() => undefined);
  }, 1500);
  return () => clearInterval(timer);
};

/**
 * Arm the in-page fighter, preferring whatever the TRACKER told us to kill.
 *
 * `wanted` is the step's own line — "Stalkers driven off", "The Mushroom King" —
 * and the bot picks the enemy whose nameplate shares a word with it. That is
 * exactly the read a player makes: the tracker says what, the nameplate says
 * which one. Without it the bot hits whatever is nearest, and the first run of
 * the chain's second link spent four minutes killing hexers in a mixed camp
 * while the third stalker stood off at range. 2/3, forever.
 */
const armFighter = (page, wantedName) =>
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
    const log = { stop: false, kills: 0 };
    window.__p11bot = log;
    const timer = setInterval(() => {
      if (log.stop) {
        walk(false);
        clearInterval(timer);
        return;
      }
      if (d.combatState().dead) {
        walk(false);
        d.connection.requestRespawn();
        return;
      }
      const self = d.connection.renderPosition();
      const living = d
        .enemies()
        .filter((e) => !e.dead && e.hpFraction > 0)
        .map((e) => ({ ...e, dist: Math.hypot(e.x - self.x, e.z - self.z) }));
      const asked = wanted.toLowerCase();
      const named = living.filter((e) =>
        e.name
          .toLowerCase()
          .split(/\W+/)
          .filter((word) => word.length > 3)
          .some((word) => asked.includes(word)),
      );
      const focus =
        named.sort((a, b) => a.dist - b.dist)[0] ?? living.sort((a, b) => a.dist - b.dist)[0];
      if (!focus) {
        walk(false);
        return;
      }
      d.input.yaw = Math.atan2(focus.x - self.x, focus.z - self.z);
      walk(focus.dist > 2.6);
      d.attack();
      for (const slot of d.abilityState().hotbar) {
        if (slot.cooldownMs === 0 && slot.affordable) d.pressSlot(slot.slot);
      }
    }, 120);
  }, wantedName);

const stopFighter = (page) =>
  page.evaluate(() => {
    if (window.__p11bot) window.__p11bot.stop = true;
  });

/**
 * Fight until the step's counter reaches its target, standing inside the hint
 * circle the MAP drew. Nothing here knows which spawner it is walking to.
 */
const fightStep = async (page, questId, hint, focusName, budgetMs) => {
  await goTo(page, hint.x, hint.z, `the ${focusName} hint circle`, { settle: 2500 });
  const stopHealing = keepAlive();
  await armFighter(page, focusName);
  const started = Date.now();
  try {
    for (;;) {
      const entry = await questEntry(page, questId);
      if (!entry) fail(`${questId} vanished from the log mid-fight`);
      if (entry.ready || entry.step > 0 || entry.counter >= entry.target) {
        if (entry.counter >= entry.target || entry.ready) {
          return { seconds: (Date.now() - started) / 1000, counter: entry.counter };
        }
      }
      if (Date.now() - started > budgetMs) {
        // Say WHY nothing happened. An empty circle and a circle full of the
        // wrong monsters are different problems, and a zone boss on a ten-minute
        // respawn ticket is a third — one that fixes itself if you wait.
        const around = await page.evaluate(() =>
          window.__dawned
            .enemies()
            .filter((enemy) => !enemy.dead)
            .map((enemy) => enemy.name),
        );
        const tally = [...new Set(around)].map(
          (name) => `${name} ×${around.filter((n) => n === name).length}`,
        );
        fail(
          `${questId}: ${((Date.now() - started) / 1000).toFixed(0)} s inside the hint circle and ` +
            `the step is ${entry.counter}/${entry.target}. Alive nearby: ` +
            `${
              tally.join(', ') ||
              'NOTHING — if this step names a zone boss, his 10-minute ' +
                'respawn ticket has probably not come round yet'
            }`,
        );
      }
      await sleep(1000);
    }
  } finally {
    await stopFighter(page);
    stopHealing();
  }
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const main = async () => {
  console.log(
    '\nP11 DoD — find, accept, complete and turn in a chain, with only what the game shows\n',
  );

  const token = await ensureAccount(BASE_URL, ACCOUNT, PASSWORD);
  const character = await ensureCharacter(BASE_URL, token, CHARACTER, 'warrior');
  ok(`fixture ${CHARACTER} (#${character.id}) ready`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.addInitScript((sessionToken) => {
    localStorage.setItem('dawned.token', sessionToken);
  }, token);

  const report = {};

  try {
    await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.char-card', { timeout: 60000 });
    await page.click(`.char-card:has-text("${CHARACTER}")`);
    await page.getByText('ENTER WORLD', { exact: true }).click();
    await page.waitForSelector('.hud', { timeout: 60000 });
    await until(page, () => window.__dawned?.connection?.status === 'playing', {
      label: 'world entry',
      timeout: 60000,
    });
    // A page reload wipes this. It is the only way to tell "the world took the
    // quest away" apart from "this tab started over and has not been told yet".
    await page.evaluate(() => {
      window.__p11mark = 'alive';
    });

    // ---------------------------------------------------------------- setup
    head('setup');
    /**
     * Prove the ops lever moves THIS page before anything depends on it.
     *
     * `/ops/tp` moves the first player whose name matches, and a session killed
     * mid-run lingers for the reconnect grace answering to the same name — so
     * a fresh run can spend four minutes teleporting a ghost around the island
     * while the character it is watching stands at the harbour. That failure
     * reads as "the clue does not point where the step is", which is a lie
     * about the content. One round trip up front turns it into one line.
     */
    {
      const here = await page.evaluate(() => {
        const p = window.__dawned.connection.renderPosition();
        return { x: p.x, z: p.z };
      });
      const mark = { x: here.x + 30, z: here.z + 30 };
      await ops('/ops/tp', { player: CHARACTER, ...mark });
      const online = (await (await fetch(`${BASE_URL}/api/health`)).json()).players;
      if (online !== 1) {
        note(
          `${online} players online — a killed run inside its reconnect grace answers to the ` +
            `same name, and every ops lever takes the FIRST match`,
        );
      }
      const moved = await until(
        page,
        (target) => {
          const p = window.__dawned.connection.renderPosition();
          return Math.hypot(p.x - target.x, p.z - target.z) < 8;
        },
        { arg: mark, label: 'this page to follow the teleport lever', timeout: 12000 },
      ).catch(() => false);
      if (!moved) {
        fail(
          `/ops/tp says ok but this page did not move — another session is still answering to ` +
            `"${CHARACTER}" (a killed run inside its reconnect grace). Wait for it to drop.`,
        );
      }
    }
    await ops('/ops/setlevel', { player: CHARACTER, level: SMOKE_LEVEL });
    await ops('/ops/setprof', { player: CHARACTER, profession: 'herbalism', level: HERB_LEVEL });
    await sleep(900);
    await ops('/ops/grant', { player: CHARACTER, itemId: 'item_weapon_sword_dawnsteel', qty: 1 });
    await sleep(1200);
    await page.evaluate(() => {
      const state = window.__dawned.inventoryState();
      if (state.equipment.mainhand) return;
      const cell = state.cells.find(([, s]) => s.itemId === 'item_weapon_sword_dawnsteel');
      if (cell) window.__dawned.sendItemOp({ kind: 'equip', from: cell[0] });
    });
    await sleep(1200);
    // P9-E: an unspent level 12 does 30 effective dps and a built one does 78.
    // Measuring a boss step against the first would fail this run for a reason
    // that has nothing to do with quests.
    const build = await page.evaluate(async () => {
      const d = window.__dawned;
      const stats = d.progressionState().sheet?.unspentStatPoints ?? 0;
      if (stats > 0) d.allocateStats({ str: stats, agi: 0, int: 0, vit: 0, end: 0 });
      await new Promise((r) => setTimeout(r, 1200));
      const defs = [...d.connection.skillNodeDefs.values()].filter(
        (node) => node.classId === d.connection.classId,
      );
      let bought = 0;
      for (let pass = 0; pass < 8; pass++) {
        let any = false;
        for (const node of defs.sort((a, b) => a.tier - b.tier)) {
          if (d.allocateSkill(node.id)?.ok) {
            bought++;
            any = true;
            await new Promise((r) => setTimeout(r, 110));
          }
        }
        if (!any) break;
      }
      const sheet = d.progressionState().sheet;
      return {
        stats,
        bought,
        // What the character HAS, not what this run spent: the fixture persists,
        // so a second run allocates nothing and "+0 STR" would read as a broken
        // build rather than an already-built one.
        allocated: Object.values(sheet?.allocated ?? {}).reduce((a, b) => a + b, 0),
        ranks: Object.values(sheet?.nodes ?? {}).reduce((a, b) => a + b, 0),
        unspent: (sheet?.unspentStatPoints ?? 0) + (sheet?.unspentSkillPoints ?? 0),
      };
    });
    // Every pilot quest dropped: the fixture persists, so a second run would
    // meet Torv holding his quest and get the IN-PROGRESS line — correct
    // behaviour, and the wrong thing to measure.
    const allQuests = (await (await fetch(`${BASE_URL}/api/content/quests`)).json()).quests;
    for (const def of allQuests) {
      await ops('/ops/quest', { player: CHARACTER, quest: def.id, drop: true });
    }
    // Chests and quest props are spent PER CHARACTER, so a second run would meet
    // a crate it emptied last time and an interact step that can never count.
    // (The content answer is a respawn — every interactable a quest step needs
    // has to come back — and this is the run's own reset on top of it.)
    const reset = await ops('/ops/forget', {
      player: CHARACTER,
      pois: true,
      objects: true,
    });
    await sleep(800);
    if (build.unspent > 0)
      fail(`${build.unspent} point(s) left unspent — this is not a built level 12`);
    ok(
      `level ${SMOKE_LEVEL} warrior: ${build.allocated} attribute point(s) and ${build.ranks} ` +
        `node rank(s) spent, nothing banked · herbalism ${HERB_LEVEL} · ` +
        `${allQuests.length} pilot quests, ${reset.objects} used object(s) and ` +
        `${reset.pois} discovery(s) reset`,
    );

    // The villagers and props are seeded from the bake and seated only once
    // their terrain has streamed. Reading the roster before that is how the
    // second run of this script "found no Torv" in a world he was standing in.
    await until(page, () => (window.__dawned.worldObjects().seated ?? 0) > 0, {
      label: 'the world objects to seat themselves on real ground',
      timeout: 60000,
    });

    // ------------------------------------------- 1. the found-object quest
    head('1 · the found-object quest');
    const crateQuest = 'quest_shore_lost_crate';
    // Torv is found the way a player finds him: a villager standing in Dawnhaven
    // with a glyph over his head. The run reads the roster the CLIENT drew.
    const villagers = await onScreen(page);
    const torv = villagers.find((row) => row.kind === 'npc' && row.name === 'Torv');
    if (!torv) fail(`no villager named Torv is on screen (saw ${villagers.length} objects)`);
    await goTo(page, torv.x + 1.4, torv.z + 1.4, 'Torv', { expectPrompt: 'Talk to Torv' });
    let conversation = await talk(page);
    ok(`${conversation.speaker}: "${conversation.text.slice(0, 62)}…"`);
    await pick(page, conversation.choices, 'accept', 'Torv offering the crate quest');
    await until(
      page,
      (id) => (window.__dawned.connection.questLog.quests ?? []).some((q) => q.questId === id),
      {
        arg: crateQuest,
        label: 'the crate quest in the log',
      },
    );
    await closeDialogue(page);
    ok('accepted — it is in the journal');
    await shoot(page, '01-accepted.png');

    // The explore step: prose only. Read what the game says, ask again if the
    // clue alone does not name a direction, then go and look.
    let entry = await questEntry(page, crateQuest);
    let clue = (await questLog(page)).clues.find((c) => c.questId === crateQuest)?.text ?? '';
    note(`tracker: "${entry.steps[entry.step].text}"`);
    note(`clue: "${clue}"`);
    let direction = directionFrom([clue, entry.journalText]);
    if (!direction) {
      // Exactly what a stuck player does: go back and ask.
      await goTo(page, torv.x + 1.4, torv.z + 1.4, 'Torv again', { expectPrompt: 'Talk to Torv' });
      const again = await talk(page);
      note(`asked again — ${again.speaker}: "${again.text}"`);
      direction = directionFrom([again.text, clue, entry.journalText]);
      await closeDialogue(page);
    }
    if (!direction) {
      fail(
        'nothing the game says about this step names a direction — the clue, the journal and ' +
          'the giver all point nowhere',
      );
    }
    note(`the game points (${direction.dx}, ${direction.dz}) from Dawnhaven`);
    const crateSearch = await searchFor(page, crateQuest, 0, direction, 'the lost crate');
    report.crateProbes = crateSearch.probes;
    ok('explore step credited — the place the prose describes is where the quest wanted us');

    // The interact step. The prompt names the object; the run presses F.
    entry = await questEntry(page, crateQuest);
    note(`tracker: "${entry.steps[entry.step].text}"`);
    const nearby = (await onScreen(page)).filter(
      (row) => row.seated && Math.hypot(row.x - crateSearch.at.x, row.z - crateSearch.at.z) < 40,
    );
    if (nearby.length === 0) fail('nothing is standing where the explore step led');
    const crate = nearby.sort(
      (a, b) =>
        Math.hypot(a.x - crateSearch.at.x, a.z - crateSearch.at.z) -
        Math.hypot(b.x - crateSearch.at.x, b.z - crateSearch.at.z),
    )[0];
    await goTo(page, crate.x + 1.2, crate.z + 1.2, crate.name, { expectPrompt: 'F —' });
    const cratePrompt = (await page.textContent('[data-interact]'))?.trim() ?? '';
    ok(`prompt: "${cratePrompt}"`);
    await page.keyboard.press('KeyF');
    await until(
      page,
      (id) => {
        const q = (window.__dawned.connection.questLog.quests ?? []).find(
          (row) => row.questId === id,
        );
        return q?.ready === true;
      },
      { arg: crateQuest, label: 'the crate quest to be ready to hand in', timeout: 20000 },
    );
    ok('opened it — every step is behind us');
    await shoot(page, '02-crate.png');

    // Turn in. Where? The quest itself says — `turnInNpcId`, which the journal
    // renders as "Return to …", so the run resolves that name on the roster.
    entry = await questEntry(page, crateQuest);
    const turnInName = (await onScreen(page)).find(
      (row) => row.kind === 'npc' && row.id.includes(entry.turnInNpcId.replace('npc_', '')),
    );
    const goldBefore = await page.evaluate(() => window.__dawned.inventoryState().gold);
    await goTo(page, torv.x + 1.4, torv.z + 1.4, turnInName?.name ?? 'Torv', {
      expectPrompt: 'Talk to Torv',
    });
    conversation = await talk(page);
    await pick(page, conversation.choices, 'turn_in', 'Torv taking the crate quest back');
    await until(
      page,
      (id) =>
        !(window.__dawned.connection.questLog.quests ?? []).some(
          (q) => q.questId === id && q.status === 'active',
        ),
      {
        arg: crateQuest,
        label: 'the crate quest to leave the active log',
      },
    );
    const goldAfter = await page.evaluate(() => window.__dawned.inventoryState().gold);
    await closeDialogue(page);
    if (goldAfter <= goldBefore)
      fail(`turned in and gold did not move (${goldBefore} → ${goldAfter})`);
    ok(`turned in — ${goldAfter - goldBefore} gold paid (${goldBefore} → ${goldAfter})`);
    report.foundObject = { probes: crateSearch.probes, gold: goldAfter - goldBefore };

    // --------------------------------------- 2. discovery, every POI kind
    head('2 · the discovery loop, one POI of every kind');
    // The POI list comes from the client's own copy — it is what the map draws.
    const pois = await page.evaluate(() => window.__dawned?.poiList?.() ?? []);
    if (pois.length === 0) fail('the client knows of no POIs at all');
    const byKind = new Map();
    for (const poi of pois) if (!byKind.has(poi.kind)) byKind.set(poi.kind, poi);
    note(`${pois.length} POI(s) on this map, ${byKind.size} distinct kind(s)`);

    /**
     * Somewhere that is inside no POI ring, so a forget-then-walk-in measures
     * one discovery and not two.
     *
     * This is not fussiness. Dawnhaven's own landmark ring is 22 m and Torv
     * stands 11 m from its centre, so the FIRST version of this loop forgot
     * everything while parked at Torv from the turn-in, re-discovered Dawnhaven
     * within the second — banner and all, unobserved — and then reported "no
     * banner ever appeared" for a POI the game had already announced correctly.
     */
    const neutral = (() => {
      let best = null;
      for (let x = -280; x <= 280; x += 20) {
        for (let z = -280; z <= 300; z += 20) {
          const clearance = Math.min(
            ...pois.map((poi) => Math.hypot(poi.x - x, poi.z - z) - poi.radius),
          );
          if (!Number.isFinite(clearance) || clearance < 60) continue;
          // Prefer close to the harbour: the shorter the hop, the less terrain
          // has to stream before the next measurement.
          const cost = Math.hypot(x - HAVEN.x, z - HAVEN.z);
          if (!best || cost < best.cost) best = { x, z, cost, clearance };
        }
      }
      if (!best) fail('every point on this map is inside a POI ring — cannot measure discovery');
      return best;
    })();
    note(
      `staging from (${neutral.x}, ${neutral.z}) — ` +
        `${neutral.clearance.toFixed(0)} m clear of the nearest ring`,
    );

    const discovered = [];
    for (const [kind, poi] of byKind) {
      // Stand clear, forget everything, and confirm the fog really closed —
      // only then is walking in a measurement of THIS place.
      await ops('/ops/tp', { player: CHARACTER, x: neutral.x, z: neutral.z });
      await sleep(1500);
      await ops('/ops/forget', { player: CHARACTER, pois: true });
      await until(
        page,
        () => (window.__dawned.connection.discoveryState?.pois ?? []).length === 0,
        {
          label: 'the fog to close over every POI',
          timeout: 15000,
        },
      );
      await page
        .waitForSelector('[data-discovery][hidden]', { timeout: 8000 })
        .catch(() => undefined);

      const xpBefore = await xpMark(page);
      await ops('/ops/tp', { player: CHARACTER, x: poi.x, z: poi.z });

      // Two separate claims, so a failure says which half broke. The server
      // asks "have you entered somewhere?" once a second per player, not every
      // tick, so this waits seconds rather than milliseconds.
      const known = await until(
        page,
        (id) => {
          const found = window.__dawned.connection.discoveryState?.pois ?? [];
          return found.includes(id) ? found : null;
        },
        { arg: poi.id, label: `the server to discover ${poi.id}`, timeout: 20000 },
      );
      const banner = await page
        .waitForSelector('[data-discovery]:not([hidden])', { timeout: 12000 })
        .catch(() => null);
      if (!banner) fail(`${poi.id} is discovered and on the map, but no banner ever appeared`);
      // Overlapping rings queue, so THIS place's banner may be second in line.
      const announced = await until(
        page,
        (want) => {
          const el = document.querySelector('[data-discovery]');
          if (!el || el.hidden) return null;
          const name = document.querySelector('[data-discovery-name]')?.textContent?.trim() ?? '';
          if (!name.toLowerCase().includes(want.toLowerCase())) return null;
          return {
            kind: document.querySelector('[data-discovery-kind]')?.textContent?.trim() ?? '',
            name,
          };
        },
        { arg: poi.name, label: `the banner to announce "${poi.name}"`, timeout: 20000 },
      );
      const bannerKind = announced.kind;
      const bannerName = announced.name;
      if (bannerKind.toLowerCase() !== kind.toLowerCase()) {
        fail(`the ${kind} "${poi.name}" announced itself as a "${bannerKind}"`);
      }
      const xpAfter = await xpMark(page);
      if (!xpMoved(xpBefore, xpAfter)) fail(`${poi.id} was discovered but no XP was awarded`);
      // More than one is legitimate — Dawnhaven's landmark ring is 22 m and the
      // shrine inside it is 14 m from the centre, so arriving at one finds
      // both. What matters is that each gets its own banner rather than the
      // last overwriting the first, which is why they are queued now.
      const alsoFound = known.filter((id) => id !== poi.id);
      discovered.push({ kind, name: poi.name, xp: xpDelta(xpBefore, xpAfter) });
      ok(
        `${bannerKind.padEnd(10)} ${bannerName.padEnd(22)} ${xpDelta(xpBefore, xpAfter)}` +
          (alsoFound.length > 0 ? ` (+${alsoFound.length} overlapping)` : ''),
      );
      if (discovered.length === 1) await shoot(page, '03-discovery.png');
    }
    report.discovery = discovered;
    // One of each KIND the design defines is the claim; say what the world can
    // actually carry rather than implying six when the map holds four.
    ok(`the loop fired for all ${discovered.length} POI kind(s) this map carries`);

    // ------------------------------------------------------ 3. the chain
    head("3 · the chain — The Loggers' Silence");
    const hesta = (await onScreen(page)).find((row) => row.kind === 'npc' && row.name === 'Hesta');
    if (!hesta) fail('no villager named Hesta is on screen');
    const chainReport = [];

    for (const [link, questId] of CHAIN.entries()) {
      head(`3.${link + 1} · ${questId}`);
      // Availability is the game's answer, not ours: a link whose prerequisite
      // is unmet has no `accept` on the giver's tree at all.
      await goTo(page, hesta.x + 1.4, hesta.z + 1.4, 'Hesta', { expectPrompt: 'Talk to Hesta' });
      conversation = await talk(page);
      note(`${conversation.speaker}: "${conversation.text.slice(0, 62)}…"`);
      await pick(page, conversation.choices, 'accept', `Hesta offering link ${link + 1}`);
      await until(
        page,
        (id) => (window.__dawned.connection.questLog.quests ?? []).some((q) => q.questId === id),
        {
          arg: questId,
          label: `${questId} in the log`,
        },
      );
      await closeDialogue(page);
      const accepted = await questEntry(page, questId);
      ok(`accepted "${accepted.name}" (level ${accepted.suggestedLevel} suggested)`);

      // Walk the steps, deciding each one from what the client shows.
      let guard = 0;
      for (;;) {
        const state = await questEntry(page, questId);
        if (!state) fail(`${questId} left the log mid-run`);
        if (state.ready) break;
        if (guard++ > 12) fail(`${questId}: 12 step attempts and still not ready`);
        const step = state.steps[state.step];
        note(
          `step ${state.step + 1}/${state.steps.length} — ${step.text} (${step.have}/${step.need})`,
        );

        if (step.type === 'explore') {
          const text = (await questLog(page)).clues.find((c) => c.questId === questId)?.text ?? '';
          note(`clue: "${text}"`);
          let dir = directionFrom([text, state.journalText]);
          if (!dir) {
            await goTo(page, hesta.x + 1.4, hesta.z + 1.4, 'Hesta again', {
              expectPrompt: 'Talk to Hesta',
            });
            const again = await talk(page);
            note(`asked again — "${again.text}"`);
            dir = directionFrom([again.text, text, state.journalText]);
            await closeDialogue(page);
          }
          if (!dir)
            fail(`${questId}: nothing the game says about this explore step names a direction`);
          const found = await searchFor(page, questId, state.step, dir, questId);
          chainReport.push({ questId, step: step.text, probes: found.probes });
          continue;
        }

        // Every other step type has a hint circle, which is the map's answer.
        if (!state.hint)
          fail(`${questId} step ${state.step + 1} (${step.type}) has no hint circle`);
        const hint = state.hint;

        if (step.type === 'interact') {
          // What is standing in the circle? The client's roster, filtered by
          // the circle the map drew — never the placement file.
          await goTo(page, hint.x, hint.z, 'the hint circle', { settle: 3000 });
          const inside = (await onScreen(page)).filter(
            (row) => row.seated && Math.hypot(row.x - hint.x, row.z - hint.z) <= hint.radius,
          );
          if (inside.length === 0) fail(`${questId}: nothing is standing inside the hint circle`);
          note(
            `${inside.length} thing(s) inside the circle: ${[...new Set(inside.map((r) => r.name))].join(', ')}`,
          );
          for (const object of inside) {
            const before = await questEntry(page, questId);
            if (before.step !== state.step) break;
            await goTo(page, object.x + 1.1, object.z + 1.1, object.name, { settle: 1400 });
            const prompt = await page.evaluate(() => {
              const el = document.querySelector('[data-interact]');
              return el && !el.hidden ? (el.textContent ?? '').trim() : '';
            });
            if (!prompt) continue;
            await page.keyboard.press('KeyF');
            await sleep(900);
          }
          const after = await questEntry(page, questId);
          if (after.step === state.step && after.counter === step.have) {
            fail(`${questId}: pressed F on everything in the circle and the counter never moved`);
          }
          chainReport.push({ questId, step: step.text, counted: after.counter });
          continue;
        }

        if (step.type === 'kill') {
          // The tracker line is the only thing the game tells the player about
          // WHAT to kill, so it is the only thing this run gets to use.
          const fought = await fightStep(page, questId, hint, step.text, 6 * 60 * 1000);
          note(`fought ${fought.seconds.toFixed(1)} s inside the circle`);
          chainReport.push({
            questId,
            step: step.text,
            seconds: Number(fought.seconds.toFixed(1)),
          });
          continue;
        }

        if (step.type === 'collect') {
          const gathered = await gatherStep(page, questId, hint, step.need - step.have);
          chainReport.push({ questId, step: step.text, gathers: gathered });
          continue;
        }

        if (step.type === 'deliver') {
          await goTo(page, hint.x, hint.z, 'the delivery hint circle', { settle: 2500 });
          const inCircle = (await onScreen(page)).filter(
            (row) =>
              row.kind === 'npc' &&
              row.seated &&
              Math.hypot(row.x - hint.x, row.z - hint.z) <= hint.radius + 6,
          );
          if (inCircle.length === 0) fail(`${questId}: nobody stands in the delivery circle`);
          const target = inCircle[0];
          await goTo(page, target.x + 1.3, target.z + 1.3, target.name, {
            expectPrompt: `Talk to ${target.name}`,
          });
          const handover = await talk(page);
          note(`${handover.speaker}: "${handover.text.slice(0, 56)}…"`);
          await closeDialogue(page);
          const after = await questEntry(page, questId);
          if (after.step === state.step && !after.ready) {
            fail(
              `${questId}: talked to ${target.name} carrying the goods and the deliver step did ` +
                `not credit — the P11-C refuse-then-credit bug`,
            );
          }
          chainReport.push({ questId, step: step.text, to: target.name });
          continue;
        }

        fail(`${questId}: step type "${step.type}" has no handler in this run`);
      }

      // Hand it in, and take the reward the class picker offers if there is one.
      await goTo(page, hesta.x + 1.4, hesta.z + 1.4, 'Hesta', { expectPrompt: 'Talk to Hesta' });
      const xpBefore = await xpMark(page);
      conversation = await talk(page);
      // A per-class Rare is picked BEFORE the turn-in choice, because the pick
      // rides along with it — there is no separate confirm.
      const rewardPick = await page.evaluate(() =>
        [...document.querySelectorAll('.dlg-pick-item')].map((el) => (el.textContent ?? '').trim()),
      );
      if (rewardPick.length > 0) {
        note(`reward choices on screen: ${rewardPick.join(' | ')}`);
        await page.click('.dlg-pick-item');
        await sleep(500);
      }
      await pick(page, conversation.choices, 'turn_in', `Hesta taking link ${link + 1}`);
      await until(
        page,
        (id) => {
          const q = (window.__dawned.connection.questLog.quests ?? []).find(
            (row) => row.questId === id,
          );
          return !q || q.status !== 'active';
        },
        { arg: questId, label: `${questId} to leave the active log` },
      );
      await closeDialogue(page);
      const xpAfter = await xpMark(page);
      const rewardLine = (await toasts(page)).find((line) => /XP|gold|title/i.test(line)) ?? '';
      if (!xpMoved(xpBefore, xpAfter)) fail(`${questId}: turned in and no XP was paid`);
      ok(`turned in — ${xpDelta(xpBefore, xpAfter)}${rewardLine ? ` · "${rewardLine}"` : ''}`);
      if (rewardLine.includes('title')) report.title = rewardLine;
      await shoot(page, `04-chain-${link + 1}.png`);

      // The next link must have been LOCKED until this moment. Only checkable
      // between links, and it is the whole reason a chain is a chain.
      if (link + 1 < CHAIN.length) {
        const nextId = CHAIN[link + 1];
        const held = (await questLog(page)).quests.some((q) => q.questId === nextId);
        if (held) fail(`${nextId} was already in the log before ${questId} was turned in`);
      }
    }
    report.chain = chainReport;

    // The chain's end pays a per-class Rare and a title (§1.5).
    const weapons = await page.evaluate(() =>
      window.__dawned
        .inventoryState()
        .cells.map(([, stack]) => stack.itemId)
        .filter((id) => id.startsWith('item_weapon_')),
    );
    note(`pack now holds: ${weapons.join(', ') || 'no weapons'}`);
    if (report.title) ok(`the chain paid its ${report.title}`);
    await shoot(page, '05-done.png');

    // ---------------------------------------------------------- the record
    head('what this run measured');
    console.log(
      `   found-object quest: explore solved in ${report.foundObject.probes} probe(s), ` +
        `${report.foundObject.gold} gold paid`,
    );
    console.log(
      `   discovery: ${report.discovery.length} kind(s) — ` +
        report.discovery.map((d) => `${d.kind} +${d.xp}xp`).join(', '),
    );
    for (const row of report.chain) {
      const detail =
        row.probes !== undefined
          ? `${row.probes} probe(s)`
          : row.seconds !== undefined
            ? `${row.seconds}s`
            : row.gathers !== undefined
              ? `${row.gathers} gather(s)`
              : row.counted !== undefined
                ? `${row.counted} counted`
                : `to ${row.to}`;
      console.log(`   ${row.questId.padEnd(24)} ${row.step.padEnd(30)} ${detail}`);
    }

    const fatal = pageErrors.filter((line) => !/favicon|ResizeObserver/i.test(line));
    if (fatal.length > 0) fail(`console errors:\n${fatal.slice(0, 6).join('\n')}`);

    console.log(
      '\n📜 P11 DoD met: the chain is findable, acceptable, completable and turn-in-able.\n',
    );
  } finally {
    // Leave the world as we found it, the two-client-sync lesson: a run that
    // strands its fixture 300 m out breaks the NEXT run rather than this one.
    await ops('/ops/tp', { player: CHARACTER, x: HAVEN.x, z: HAVEN.z }).catch(() => undefined);
    await browser.close();
  }
};

/**
 * Gather until the step has what it needs, from the nodes standing in the hint
 * circle. Every one is a real `GatherOp` — nothing is granted, because "collect
 * by gathering" is a claim about the profession loop as much as about the quest.
 */
const gatherStep = async (page, questId, hint, needed) => {
  await goTo(page, hint.x, hint.z, 'the gathering hint circle', { settle: 3000 });
  await ops('/ops/respawnnodes', {});
  await sleep(700);

  let picked = 0;
  let refused = 0;
  let respawns = 1;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const entry = await questEntry(page, questId);
    if (!entry) fail(`${questId} left the log while gathering`);
    if (entry.ready || entry.step > 0 || entry.counter >= entry.target) {
      note(`${picked} successful gather(s), ${refused} refusal(s), ${respawns} respawn sweep(s)`);
      return picked;
    }

    const node = await page.evaluate(() => window.__dawned.gatheringState().inReach);
    if (!node) {
      // Walk the circle looking for something to pick, the way you would.
      const spot = {
        x: hint.x + (Math.random() * 2 - 1) * hint.radius,
        z: hint.z + (Math.random() * 2 - 1) * hint.radius,
      };
      await ops('/ops/tp', { player: CHARACTER, x: spot.x, z: spot.z });
      await sleep(700);
      continue;
    }

    const before = (await questEntry(page, questId))?.counter ?? 0;
    await page.evaluate(
      (id) => window.__dawned.sendGatherOp({ kind: 'start', placementId: id }),
      node.placementId,
    );
    await page
      .waitForFunction(() => window.__dawned.gatheringState().channel === null, null, {
        timeout: 20000,
      })
      .catch(() => undefined);
    await sleep(500);
    const after = (await questEntry(page, questId))?.counter ?? 0;
    if (after > before) picked++;
    else refused++;

    /**
     * Bring the patch back when it stops giving.
     *
     * This circle holds FOUR mossbloom nodes and the step wants FIVE, so one
     * respawn cycle is mandatory even for a perfect run — and a depleted node
     * refuses instantly, which the first version of this loop counted as a
     * gather. 61 "gathers", 4 mossbloom, no idea why. Nodes come back on a
     * 90–180 s timer in play; `/ops/respawnnodes` is the same "do not make a
     * test wait three minutes" lever P10 shipped it as.
     */
    if (refused >= 4) {
      await ops('/ops/respawnnodes', {});
      respawns++;
      refused = 0;
      await sleep(900);
    }
    if (picked > needed * 6) {
      fail(`${questId}: ${picked} successful gathers and the step still is not full`);
    }
  }
  fail(
    `${questId}: ran out of time in the gathering circle — ${picked} picked, ` +
      `${refused} refused since the last of ${respawns} respawn sweep(s)`,
  );
};

main().catch(async (error) => {
  console.error(`\n❌ ${error.message}\n`);
  process.exitCode = 1;
});
