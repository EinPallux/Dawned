#!/usr/bin/env node
/**
 * Prediction-mismatch gate at injected latency (the P3 DoD's measurable half).
 *
 * A headless client runs the REAL prediction loop — shared stepMovement at
 * 20 Hz, pending-input replay against every server snapshot, exactly the
 * algorithm packages/client/src/net/connection.ts ships — over a socket with
 * artificial one-way delay + jitter both directions. It sprint-jumps along
 * heading sweeps (slopes included) and measures how far replayed prediction
 * disagrees with the authoritative state.
 *
 * Pass: zero hard snaps (>1.5 m — visible rubber-banding) and p95 correction
 * under 10 cm across the run. The browser "feels LAN-like" signoff on real
 * hardware remains the owner's (rendering load is unmeasurable in CI).
 *
 * Usage: node tools/smoke/predict-lag.mjs [--rtt 100] [--jitter 20] [--seconds 60]
 * Requires the game server and its map artifacts (spawns via lib/fixtures REST).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  BinaryReader,
  ChunkTerrain,
  DODGE_DURATION_S,
  EntityFlag,
  InputButton,
  MAP_VERSION,
  PROTOCOL_VERSION,
  ServerOp,
  TICK_DT,
  TICK_MS,
  Walkgrid,
  cloneMovementState,
  createMovementState,
  decodeChunk,
  decodeJsonEnvelope,
  decodeSnapshot,
  encodeChat,
  encodeHello,
  encodeInputIntent,
  peekOpcode,
  stepMovement,
} from '@dawned/shared';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? Number(process.argv[index + 1]) : fallback;
};
const RTT_MS = arg('rtt', 100);
const JITTER_MS = arg('jitter', 20);
const RUN_SECONDS = arg('seconds', 60);
const API = 'http://127.0.0.1:8081';
const GAME_URL = 'ws://127.0.0.1:8081/game';

const CORRECTION_SNAP_M = 1.5; // mirror of the client's hard-snap threshold

const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.error(`❌ ${m}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- terrain: the same committed artifacts the server loads -----------------
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mapDir = path.join(repoRoot, 'assets_baked/map', MAP_VERSION);
const terrain = new ChunkTerrain();
for (const file of fs.readdirSync(mapDir).filter((name) => name.startsWith('chunk_'))) {
  terrain.addChunk(decodeChunk(new Uint8Array(fs.readFileSync(path.join(mapDir, file)))));
}
terrain.attachWalkgrid(
  Walkgrid.decode(new Uint8Array(fs.readFileSync(path.join(mapDir, 'walkgrid.bin')))),
);

// --- delayed socket ---------------------------------------------------------
/** One-way delay with jitter; per-direction monotonic so packets never reorder. */
const delayed = () => {
  let scheduledAt = 0;
  return (fn) => {
    const delay = RTT_MS / 2 + (Math.random() * JITTER_MS) / 2;
    const now = Date.now();
    scheduledAt = Math.max(now + delay, scheduledAt);
    setTimeout(fn, scheduledAt - now);
  };
};

const main = async () => {
  console.log(
    `Dawned prediction gate → ${RTT_MS} ms RTT ± ${JITTER_MS} ms jitter, ${RUN_SECONDS} s\n`,
  );
  const token = await ensureAccount(API, 'zz_predict', 'smoke-pass-123456');
  const character = await ensureCharacter(API, token, 'Predictwalker', 'rogue');

  const socket = new WebSocket(GAME_URL);
  socket.binaryType = 'arraybuffer';
  const delaySend = delayed();
  const delayRecv = delayed();

  const predicted = createMovementState();
  const authoritative = createMovementState();
  const scratch = createMovementState();
  const pending = [];
  let seq = 0;
  let welcomed = false;
  let snapshots = 0;
  let hardSnaps = 0;
  const corrections = [];
  /**
   * The correction gate measures act 1's sweep only. Act 2 recalls the probe
   * with `/stuck`, and a deliberate ~1 km server-side teleport is not the
   * rubber-banding this gate is looking for.
   */
  let gating = true;

  const cloneInto = (target, source) => Object.assign(target, cloneMovementState(source));
  const seqLE = (a, b) => ((b - a) & 0xffff) < 0x8000;

  const handleSnapshot = (snapshot) => {
    snapshots++;
    const self = snapshot.self;
    authoritative.x = self.x;
    authoritative.y = self.y;
    authoritative.z = self.z;
    authoritative.vx = self.vx;
    authoritative.vy = self.vy;
    authoritative.vz = self.vz;
    authoritative.yaw = self.yaw;
    authoritative.stamina = self.stamina;
    authoritative.grounded = (self.flags & EntityFlag.Grounded) !== 0;
    authoritative.sprinting = (self.flags & EntityFlag.Sprinting) !== 0;
    authoritative.swimming = (self.flags & EntityFlag.Swimming) !== 0;
    authoritative.fallPeakY = predicted.fallPeakY;
    authoritative.staminaIdleMs = predicted.staminaIdleMs;
    authoritative.maxStamina = predicted.maxStamina;
    // The roll, from the v11 self block — this mirror exists to match
    // connection.ts, and leaving it at zero is exactly the bug that made a
    // 550 ms roll die a fraction of a second in (see the roll segment below).
    authoritative.rollTimeLeft = self.rollTimeLeftMs / 1000;
    authoritative.rollDirX = Math.sin(self.rollDirYaw);
    authoritative.rollDirZ = Math.cos(self.rollDirYaw);
    authoritative.rollCooldownMs = self.rollCooldownMs;

    while (pending.length > 0 && seqLE(pending[0].seq, snapshot.lastInputSeq)) pending.shift();
    cloneInto(scratch, authoritative);
    for (const entry of pending) stepMovement(scratch, entry.intent, TICK_DT, terrain);

    const error = Math.hypot(
      scratch.x - predicted.x,
      scratch.y - predicted.y,
      scratch.z - predicted.z,
    );
    if (gating) {
      corrections.push(error);
      if (error > CORRECTION_SNAP_M) hardSnaps++;
    }
    if (error > 0.02) cloneInto(predicted, scratch);
  };

  socket.on('open', () => {
    socket.send(
      encodeHello({ protocolVersion: PROTOCOL_VERSION, token, characterId: character.id }),
    );
  });
  socket.on('message', (data) => {
    delayRecv(() => {
      const bytes = new Uint8Array(data);
      const op = peekOpcode(bytes);
      const reader = new BinaryReader(bytes);
      reader.u8();
      if (op === ServerOp.Welcome) {
        const welcome = decodeJsonEnvelope(reader);
        predicted.x = welcome.spawn.x;
        predicted.y = welcome.spawn.y;
        predicted.z = welcome.spawn.z;
        predicted.yaw = welcome.spawn.yaw;
        cloneInto(authoritative, predicted);
        welcomed = true;
      } else if (op === ServerOp.Snapshot) {
        handleSnapshot(decodeSnapshot(reader));
      }
    });
  });

  await new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('no welcome')), 8000);
    const poll = setInterval(() => {
      if (welcomed) {
        clearTimeout(guard);
        clearInterval(poll);
        resolve();
      }
    }, 20);
  });
  ok('predicting client in world');

  // Sprint-jump heading sweeps: long pushes with slow yaw drift cross meadows,
  // slopes and shorelines; periodic jumps exercise the airborne/landing paths.
  let heading = Math.PI; // south, into the island from the spawn shore
  let tick = 0;
  const brain = setInterval(() => {
    tick++;
    if (tick % 90 === 0) heading += (Math.random() - 0.5) * 1.6;
    const buttons = InputButton.Sprint | (tick % 73 === 0 ? InputButton.Jump : 0);
    const intent = {
      moveX: Math.sin(heading),
      moveZ: Math.cos(heading),
      yaw: heading,
      buttons,
    };
    seq = (seq + 1) & 0xffff;
    pending.push({ seq, intent: { ...intent } });
    if (pending.length > 120) pending.shift();
    stepMovement(predicted, intent, TICK_DT, terrain);
    const frame = encodeInputIntent({ seq, ...intent });
    delaySend(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    });
  }, TICK_MS);

  await sleep(RUN_SECONDS * 1000);
  clearInterval(brain);
  await sleep(500);

  // --- act 2: does a PREDICTED roll survive its own reconciliation? ---------
  // A roll runs 550 ms — 11 ticks — but the press is one input, acked within a
  // round trip. Once it leaves the pending buffer the replay cannot re-create
  // it, so the roll only continues if the authoritative state carries it. When
  // it did not, every roll was cancelled a fraction of a second in: the player
  // pressed dodge, moved a metre instead of four, and the animation snapped
  // back to the gait. Nothing in the correction stats above catches that — the
  // replay agrees with itself, it is the PLAYER's roll that vanishes.
  // Home first: 20 s of random sprint sweeps regularly ends in the sea, and a
  // roll is refused in deep water by design (COMBAT.md §7).
  gating = false;
  socket.send(encodeChat({ text: '/stuck' }));
  await sleep(3000);
  if (predicted.swimming || !predicted.grounded) {
    fail(`/stuck did not put the probe on dry ground (swimming=${predicted.swimming})`);
  }

  const rollLifetimes = [];
  let rollTicks = 0;
  const rollBrain = setInterval(() => {
    tick++;
    // Walk (never sprint — sprinting eats the stamina a roll needs) and press
    // dodge every 3 s, which clears both the cooldown and the regen delay.
    const dodging = tick % 60 === 0;
    const intent = {
      moveX: Math.sin(heading),
      moveZ: Math.cos(heading),
      yaw: heading,
      buttons: dodging ? InputButton.Dodge : 0,
    };
    seq = (seq + 1) & 0xffff;
    pending.push({ seq, intent: { ...intent } });
    if (pending.length > 120) pending.shift();
    stepMovement(predicted, intent, TICK_DT, terrain);
    if (predicted.rollTimeLeft > 0) {
      rollTicks++;
    } else if (rollTicks > 0) {
      rollLifetimes.push(rollTicks);
      rollTicks = 0;
    }
    const frame = encodeInputIntent({ seq, ...intent });
    delaySend(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    });
  }, TICK_MS);
  await sleep(15_000);
  clearInterval(rollBrain);
  await sleep(500);
  socket.close();

  const shortest = Math.min(...rollLifetimes);
  ok(
    `${rollLifetimes.length} predicted rolls, each lived ${rollLifetimes.join('/')} ticks ` +
      `(a full ${DODGE_DURATION_S}s roll is ${Math.round(DODGE_DURATION_S / TICK_DT)})`,
  );
  if (rollLifetimes.length < 3) fail(`only ${rollLifetimes.length} rolls fired — expected 4+`);
  if (shortest < 8) {
    fail(
      `a predicted roll was cut to ${shortest} ticks (${(shortest * TICK_DT * 1000).toFixed(0)} ms) ` +
        `— reconciliation is cancelling the player's own roll`,
    );
  }

  corrections.sort((a, b) => a - b);
  const p50 = corrections[Math.floor(corrections.length * 0.5)] ?? 0;
  const p95 = corrections[Math.floor(corrections.length * 0.95)] ?? 0;
  const max = corrections[corrections.length - 1] ?? 0;
  ok(
    `${snapshots} snapshots · corrections p50 ${(p50 * 1000).toFixed(1)} mm, ` +
      `p95 ${(p95 * 1000).toFixed(1)} mm, max ${(max * 1000).toFixed(1)} mm · ` +
      `${hardSnaps} hard snaps`,
  );
  if (snapshots < RUN_SECONDS * 15) fail(`snapshot stream too thin (${snapshots})`);
  if (hardSnaps > 0) fail(`${hardSnaps} hard snaps (>1.5 m) — rubber-banding at ${RTT_MS} ms`);
  if (p95 > 0.1) fail(`correction p95 ${(p95 * 1000).toFixed(1)} mm exceeds the 100 mm gate`);
  console.log(`\n🌅 Prediction holds at ${RTT_MS} ms RTT ± ${JITTER_MS} ms.\n`);
  process.exit(0);
};

main().catch((error) => {
  console.error(`\n❌ ${error.stack ?? error.message}\n`);
  process.exit(1);
});
