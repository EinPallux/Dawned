#!/usr/bin/env node
/**
 * Headless fishing probe (PROFESSIONS.md §5, protocol v13).
 *
 * The reel is the only place in the game where both sides track a fast-moving
 * thing at once, and the worst thing it can do is be unwinnable — the shared
 * tests were written after exactly that bug. But "the formula can be won" and
 * "a player at the keyboard can win it" are different claims, and only this
 * one goes through the real server: a real cast, the real bite window, the
 * real 20 Hz Reel bit on the input stream, the real fish drift from the seed.
 *
 * It is headless on purpose. The browser probe (`p10-probe.mjs`) proves the
 * fishing UI — line, bite, bar, zone, a marker that moves — but it renders at
 * ~4 fps in a container, and the reel is only stepped once a frame. A hand
 * gets ~60 corrections a second; four is not enough to hold a marker inside
 * the catch zone, so a browser run could only ever report the container's
 * frame budget. Here the loop runs at the tick rate and the question is the
 * one worth asking: can the bar be landed, at every rarity band?
 *
 * Usage: node tools/smoke/fishing-probe.mjs [ws://host:port/game]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  BinaryReader,
  InputButton,
  PROTOCOL_VERSION,
  ServerOp,
  createReelState,
  decodeJsonEnvelope,
  decodeSnapshot,
  encodeGatherOp,
  encodeHello,
  encodeInputIntent,
  fishPosition,
  peekOpcode,
  reelStep,
} from '@dawned/shared';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const WS_URL = process.argv[2] ?? 'ws://127.0.0.1:8081/game';
const API_BASE = WS_URL.replace(/^ws/, 'http').replace(/\/game$/, '');
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
const CHARACTER = 'Angler';
const TICK_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (message) => console.log(`✅ ${message}`);
const fail = (message) => {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
};
const ops = async (route, body) => {
  const response = await fetch(`${API_BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-secret': OPS_SECRET },
    body: JSON.stringify(body),
  });
  if (!response.ok) fail(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
};

class Probe {
  constructor() {
    this.socket = new WebSocket(WS_URL);
    this.socket.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.welcome = null;
    this.snapshot = null;
    this.fishing = null;
    this.professions = null;
    this.seq = 0;
    this.socket.on('message', (data) => {
      const bytes = new Uint8Array(data);
      const opcode = peekOpcode(bytes);
      const reader = new BinaryReader(bytes);
      reader.u8();
      if (opcode === ServerOp.Welcome) this.welcome = decodeJsonEnvelope(reader);
      else if (opcode === ServerOp.Snapshot) this.snapshot = decodeSnapshot(reader);
      else if (opcode === ServerOp.FishingState) this.fishing = decodeJsonEnvelope(reader);
      else if (opcode === ServerOp.ProfessionSync) this.professions = decodeJsonEnvelope(reader);
    });
  }

  async connect(token, characterId) {
    await this.opened;
    this.socket.send(encodeHello({ protocolVersion: PROTOCOL_VERSION, token, characterId }));
    const deadline = Date.now() + 8000;
    while (!this.welcome && Date.now() < deadline) await sleep(20);
    if (!this.welcome) fail('never received Welcome');
    while (!this.snapshot && Date.now() < deadline) await sleep(20);
    if (!this.snapshot) fail('never received a Snapshot');
  }

  send(buttons = 0) {
    this.seq = (this.seq + 1) & 0xffff;
    this.socket.send(encodeInputIntent({ seq: this.seq, moveX: 0, moveZ: 0, yaw: 0, buttons }));
  }

  gather(op) {
    this.socket.send(encodeGatherOp(op));
  }

  level(profession) {
    return this.professions?.professions.find((p) => p.profession === profession) ?? null;
  }

  close() {
    this.socket.close();
  }
}

/**
 * Play one cast to its end. Returns the phase it resolved to.
 *
 * The controller tracks a VELOCITY rather than chasing the marker at the fish:
 * holding accelerates the marker at 6/s² and letting go at −3/s², so aiming
 * "hold while I am left of the fish" slams between the walls. Asking for a
 * speed proportional to the error makes the loop pick its own duty cycle,
 * which is what a hand does without being told.
 *
 * It mirrors the CLIENT's bar (the same `reelStep` and `fishPosition` the
 * browser runs) purely to decide when to press. The server is running its own
 * copy against the Reel bit, and its answer is the one that counts — which is
 * the property this probe is really checking.
 */
const playOneCast = async (probe, placementId, log) => {
  probe.fishing = null;
  probe.gather({ kind: 'start', placementId });

  const deadline = Date.now() + 70_000;
  let reel = createReelState();
  let reelOf = 0;
  let steppedAt = Date.now();
  let held = false;
  let hooked = false;
  let nextAt = Date.now();

  while (Date.now() < deadline) {
    const state = probe.fishing;
    const phase = state?.phase ?? 'none';

    if (phase === 'caught' || phase === 'escaped') return phase;
    if (phase === 'none' && hooked) return 'lost';

    // Answer the bite. 0.8 s of window, and this loop runs every 50 ms.
    if (phase === 'bite' && !hooked) {
      hooked = true;
      probe.gather({ kind: 'hook' });
    }

    if (phase === 'reeling' && state.startedAtMs !== undefined) {
      const drift = { driftSpeed: state.driftSpeed ?? 0.18, markerHalf: state.markerHalf ?? 0.16 };
      // Restart only when a NEW reel opens: the periodic correction carries
      // the seed too, so keying on that resets the bar several times a second
      // and it can never fill (the client had exactly this bug).
      const now = Date.now();
      if (reelOf !== state.startedAtMs) {
        reelOf = state.startedAtMs;
        reel = createReelState();
        steppedAt = now;
      }
      const dtMs = Math.min(200, now - steppedAt);
      steppedAt = now;
      // The server stamps `startedAtMs` off `Date.now()` and this runs on the
      // same box, so its clock IS the server's — no offset estimation needed,
      // which is one fewer thing that can be wrong in a probe about timing.
      const elapsed = now - state.startedAtMs;
      const fish = fishPosition(state.seed ?? 0, elapsed, drift);
      reel = reelStep(reel, held, dtMs, fish, drift);
      if (state.progress !== undefined) {
        // How far apart are the bar being DRAWN and the bar being SCORED? The
        // player steers by the first and is judged by the second, so this gap
        // is the whole question: a marker sitting on a fish that is told it
        // missed is the worst thing a minigame can do.
        log.gap = Math.max(log.gap, Math.abs(state.progress - reel.progress));
        log.serverProgress = state.progress;
        // Same convergence rule the client uses: a correction describes a bar
        // from a few ticks ago, so cloning it drags a filling bar backwards.
        const error = state.progress - reel.progress;
        if (Math.abs(error) > 0.3) reel = { ...reel, progress: state.progress };
        else if (Math.abs(error) > 0.02) {
          reel = { ...reel, progress: reel.progress + error * 0.25 };
        }
      }
      // `fishing.test.ts` calls "hold while the marker is below the fish" the
      // dumbest strategy there is, and it lands all twenty seeds offline. On
      // the wire it needs one correction: the bit sent now is applied by the
      // server on its NEXT tick, so the decision has to be made for where the
      // bar will be then, not where it is. Deciding for "now" is a delayed
      // feedback loop, and it oscillates around the fish instead of riding it.
      const nextFish = fishPosition(state.seed ?? 0, elapsed + TICK_MS, drift);
      held = reelStep(reel, held, TICK_MS, nextFish, drift).marker < nextFish;
      log.peak = Math.max(log.peak, reel.progress);
    }

    probe.send(held ? InputButton.Reel : 0);
    // Pace to a DEADLINE, at exactly the tick rate. `sleep(TICK_MS)` plus the
    // loop's own work lands ~57 ms apart, so the server starves and repeats a
    // stale command; sending faster is worse, because it consumes one input
    // per tick and the queue just grows, so every command it applies is older
    // than the last. Both directions break a control loop, in opposite ways.
    nextAt += TICK_MS;
    await sleep(Math.max(0, nextAt - Date.now()));
  }
  return 'timeout';
};

const main = async () => {
  console.log(`Dawned fishing probe → ${WS_URL}\n`);
  const token = await ensureAccount(API_BASE, 'fishprobe', PASSWORD);
  const character = await ensureCharacter(API_BASE, token, CHARACTER, 'warrior');
  const probe = new Probe();
  await probe.connect(token, character.id ?? character);

  // Fish where the world actually has shoals: read the LIVE bake's own list,
  // off disk rather than over HTTP. The bake is served by Vite in dev and by
  // Caddy in production, and this probe should not need either — it already
  // runs beside the server for the localhost ops API.
  const health = await (await fetch(`${API_BASE}/api/health`)).json();
  const bakeDir = path.resolve(
    fileURLToPath(new URL('../../assets_baked/map', import.meta.url)),
    health.mapVersion,
  );
  const placements = JSON.parse(await readFile(path.join(bakeDir, 'placements.json'), 'utf8'));
  const shoals = (placements.nodes ?? []).filter((n) => n.nodeId.startsWith('node_fishing_'));
  if (shoals.length === 0) fail('the live bake has no fishing shoals');
  const shoal = shoals[0];
  await ops('/ops/respawnnodes', {});
  await ops('/ops/tp', { player: CHARACTER, x: shoal.x + 1.4, z: shoal.z });
  // Settle on the ground, and let the server see us standing still: a hold
  // breaks when the player drifts, and a teleport lands mid-fall.
  for (let i = 0; i < 30; i++) {
    probe.send(0);
    await sleep(TICK_MS);
  }
  ok(`at ${shoal.nodeId} (${shoals.length} shoals in the bake)`);

  // Land one. A miss is a legal outcome — the fish gets away and the spot is
  // not depleted — so the claim is "the bar can be won", not "won first try".
  const attempts = [];
  let caught = 0;
  for (let i = 0; i < 12 && caught === 0; i++) {
    const log = { peak: 0, gap: 0, serverProgress: 0 };
    const outcome = await playOneCast(probe, shoal.id, log);
    attempts.push(
      `${outcome} local ${log.peak.toFixed(2)} / server ${log.serverProgress.toFixed(2)} (worst gap ${log.gap.toFixed(2)})`,
    );
    if (outcome === 'caught') caught++;
    await sleep(500);
  }
  console.log(`   attempts:\n     ${attempts.join('\n     ')}`);
  if (caught === 0) {
    fail(
      `${attempts.length} casts and never landed one — a reel that cannot be won is the P10-C bug (${attempts.join(', ')})`,
    );
  }
  ok(`landed a fish in ${attempts.length} cast(s)`);

  const fishing = probe.level('fishing');
  if (!fishing || (fishing.level === 1 && fishing.xp === 0)) {
    fail(`landed a fish and fishing shows ${JSON.stringify(fishing)}`);
  }
  ok(`fishing ${fishing.level} (${fishing.xp} xp)`);

  probe.close();
  console.log('\n🎣 fishing probe passed\n');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
