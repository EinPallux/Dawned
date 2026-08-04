#!/usr/bin/env node
/**
 * Headless dodge-roll probe (COMBAT.md §7, protocol v11).
 *
 * The roll was reported as "buggy, does not always work, especially when
 * walking". It was not the animation: the roll lasts 550 ms but is started by
 * ONE input, which the server acks within a round trip — and until v11 the
 * snapshot carried no roll state at all. So every reconciliation after that ack
 * rebuilt a not-rolling state, cloned it over the prediction, and cancelled the
 * player's own roll a fraction of a second in. While moving, the gait resumed
 * instantly and hid it; standing, it read as a twitch.
 *
 * This probe speaks the protocol directly (no renderer, true 20 Hz) and pins
 * both halves of the contract that fix depends on:
 *   1. a Dodge intent starts a roll the SERVER agrees is running,
 *   2. the snapshot's v11 roll block reports it — a timer that counts down and
 *      a direction that matches where the character is actually being carried,
 *   3. the roll carries DODGE_DISTANCE_M, standing AND while walking.
 *
 * Usage: node tools/smoke/roll-probe.mjs [ws://host:port/game]
 */

import { WebSocket } from 'ws';
import {
  BinaryReader,
  DODGE_DISTANCE_M,
  DODGE_DURATION_S,
  EntityFlag,
  InputButton,
  PROTOCOL_VERSION,
  ServerOp,
  decodeJsonEnvelope,
  decodeSnapshot,
  encodeHello,
  encodeInputIntent,
  peekOpcode,
} from '@dawned/shared';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const URL = process.argv[2] ?? 'ws://127.0.0.1:8081/game';
const API_BASE = URL.replace(/^ws/, 'http').replace(/\/game$/, '');
const PASSWORD = 'smoke-pass-123456';
const TICK_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Probe {
  constructor() {
    this.socket = new WebSocket(URL);
    this.socket.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.welcome = null;
    this.snapshot = null;
    this.seq = 0;
    this.socket.on('message', (data) => {
      const bytes = new Uint8Array(data);
      const opcode = peekOpcode(bytes);
      const reader = new BinaryReader(bytes);
      reader.u8();
      if (opcode === ServerOp.Welcome) this.welcome = decodeJsonEnvelope(reader);
      else if (opcode === ServerOp.Snapshot) this.snapshot = decodeSnapshot(reader);
    });
  }

  async connect(token, characterId) {
    await this.opened;
    this.socket.send(encodeHello({ protocolVersion: PROTOCOL_VERSION, token, characterId }));
    const deadline = Date.now() + 8000;
    while (!this.welcome && Date.now() < deadline) await sleep(20);
    if (!this.welcome) throw new Error('never received Welcome');
    while (!this.snapshot && Date.now() < deadline) await sleep(20);
    if (!this.snapshot) throw new Error('never received a Snapshot');
  }

  send(moveX, moveZ, buttons = 0, yaw = 0) {
    this.seq = (this.seq + 1) & 0xffff;
    this.socket.send(encodeInputIntent({ seq: this.seq, moveX, moveZ, yaw, buttons }));
  }

  /** Hold an intent for `ticks` server ticks, sampling the self block each time. */
  async hold(ticks, moveX, moveZ, buttons, yaw) {
    const samples = [];
    for (let i = 0; i < ticks; i++) {
      this.send(moveX, moveZ, buttons, yaw);
      await sleep(TICK_MS);
      const self = this.snapshot.self;
      samples.push({
        x: self.x,
        z: self.z,
        rollMs: self.rollTimeLeftMs,
        dirYaw: self.rollDirYaw,
        cooldownMs: self.rollCooldownMs,
        dodging: (self.flags & EntityFlag.Dodging) !== 0,
        stamina: self.stamina,
      });
    }
    return samples;
  }

  close() {
    this.socket.close();
  }
}

class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};
const ok = (message) => console.log(`✅ ${message}`);

/** One roll, from a standing or walking start. Returns what the server did. */
const rollOnce = async (probe, { walking, yaw }) => {
  const moveX = walking ? Math.sin(yaw) : 0;
  const moveZ = walking ? Math.cos(yaw) : 0;
  // Settle: stamina regen has a 1 s delay, and a walking start needs to be at
  // speed before the roll so the measured carry is the ROLL, not the run-up.
  await probe.hold(40, moveX, moveZ, 0, yaw);
  const before = probe.snapshot.self;
  // The press, then keep moving exactly as before: the roll must carry itself.
  await probe.hold(1, moveX, moveZ, InputButton.Dodge, yaw);
  const during = await probe.hold(20, moveX, moveZ, 0, yaw);
  const rolling = during.filter((s) => s.rollMs > 0);
  const start = { x: before.x, z: before.z };
  const last = rolling.at(-1) ?? start;
  return { start, during, rolling, end: { x: last.x, z: last.z } };
};

const main = async () => {
  console.log(`Dawned roll probe → ${URL}\n`);
  const token = await ensureAccount(API_BASE, 'rollprobe', PASSWORD);
  const character = await ensureCharacter(API_BASE, token, 'Tumbler', 'warrior');
  const probe = new Probe();
  await probe.connect(token, character.id ?? character);

  // A previous run may have parked this character somewhere awkward; roll on
  // flat ground by walking a short, consistent line first.
  await probe.hold(20, 0, 0, 0, 0);

  for (const start of ['standing', 'walking']) {
    const walking = start === 'walking';
    const yaw = walking ? 0.9 : 0.9;
    const { start: from, during, rolling, end } = await rollOnce(probe, { walking, yaw });

    if (rolling.length === 0) {
      fail(`${start}: the server never reported a roll (v11 rollTimeLeftMs stayed 0)`);
    }
    ok(`${start}: server reports the roll for ${rolling.length} ticks`);

    // The timer must COUNT DOWN — a stuck or re-armed value would let the
    // client's reconciliation extend the roll forever.
    const timers = rolling.map((s) => s.rollMs);
    const monotonic = timers.every((ms, i) => i === 0 || ms < timers[i - 1]);
    if (!monotonic) fail(`${start}: rollTimeLeftMs did not count down: ${timers.join(' → ')}`);
    if (timers[0] > DODGE_DURATION_S * 1000) {
      fail(`${start}: first rollTimeLeftMs ${timers[0]} exceeds the ${DODGE_DURATION_S}s roll`);
    }
    ok(`${start}: rollTimeLeftMs counts down ${timers[0]} → ${timers.at(-1)} ms`);

    // The Dodging flag and the timer are the same fact told twice (remotes read
    // the flag, self reads the timer) — they must never disagree.
    const disagreeing = during.filter((s) => s.rollMs > 0 !== s.dodging);
    if (disagreeing.length > 0) {
      fail(`${start}: Dodging flag and rollTimeLeftMs disagree on ${disagreeing.length} ticks`);
    }
    ok(`${start}: the Dodging flag matches the timer on every tick`);

    // And the roll has to actually MOVE the character its documented distance.
    const carried = Math.hypot(end.x - from.x, end.z - from.z);
    const floor = walking ? DODGE_DISTANCE_M * 0.8 : DODGE_DISTANCE_M * 0.7;
    if (carried < floor) {
      fail(`${start}: the roll carried only ${carried.toFixed(2)} m (want ≥ ${floor.toFixed(1)})`);
    }
    ok(`${start}: carried ${carried.toFixed(2)} m (DODGE_DISTANCE_M ${DODGE_DISTANCE_M})`);

    // The reported direction must point where the body actually went — the
    // client rebuilds its predicted roll vector from exactly this angle.
    const travelled = Math.atan2(end.x - from.x, end.z - from.z);
    const reported = rolling[0].dirYaw;
    const off = Math.abs(
      Math.atan2(Math.sin(travelled - reported), Math.cos(travelled - reported)),
    );
    if (off > 0.25) {
      fail(`${start}: rollDirYaw ${reported.toFixed(2)} but travelled ${travelled.toFixed(2)}`);
    }
    ok(`${start}: rollDirYaw matches the travelled heading (off by ${off.toFixed(3)} rad)`);

    // Walk back so repeated runs do not march this character into the sea.
    await probe.hold(30, -Math.sin(yaw), -Math.cos(yaw), 0, yaw + Math.PI);
  }

  probe.close();
  console.log('\n✅ roll probe passed');
};

main().catch((error) => {
  console.error(error instanceof ProbeFailure ? `❌ ${error.message}` : error);
  process.exitCode = 1;
});
