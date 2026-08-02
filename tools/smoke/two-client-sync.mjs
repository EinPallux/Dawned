#!/usr/bin/env node
/**
 * Headless two-client sync check — the P0 Definition of Done, carried through
 * the P1 authenticated world.
 *
 * Provisions two fixture accounts + characters over REST, connects both with the
 * v2 Hello (session token + character id), walks one, and asserts that:
 *   1. both complete the authenticated handshake and receive a Welcome,
 *   2. each client sees the other in its snapshots,
 *   3. the walking client's server-side position actually advances,
 *   4. the observer's view of the walker matches the walker's own view,
 *   5. server-authoritative movement stays inside the legal speed envelope.
 * The walker walks back afterwards so persisted positions stay near spawn
 * across repeated runs.
 *
 * Usage: node tools/smoke/two-client-sync.mjs [ws://host:port/game]
 * Exits non-zero with a readable reason on any failure.
 */

import { WebSocket } from 'ws';
import {
  BinaryReader,
  InputButton,
  MOVE_SPEED,
  PROTOCOL_VERSION,
  ServerOp,
  SPRINT_MULTIPLIER,
  TICK_MS,
  decodeSnapshot,
  encodeHello,
  encodeInputIntent,
  decodeJsonEnvelope,
  peekOpcode,
} from '@dawned/shared';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const URL = process.argv[2] ?? 'ws://127.0.0.1:8081/game';
const API_BASE = URL.replace(/^ws/, 'http').replace(/\/game$/, '');
const WALK_TICKS = 60; // 3 seconds at 20 Hz
const PASSWORD = 'smoke-pass-123456';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TestClient {
  constructor(label, token, characterId) {
    this.label = label;
    this.token = token;
    this.characterId = characterId;
    this.socket = new WebSocket(URL);
    this.socket.binaryType = 'arraybuffer';
    // Capture 'open' at construction: both clients connect concurrently, so the
    // second socket can open while the first is still handshaking — attaching
    // once('open') later would miss an event that already fired.
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.welcome = null;
    this.lastSnapshot = null;
    this.snapshotCount = 0;
    this.seq = 0;
    this.notices = [];

    this.socket.on('message', (data) => {
      const bytes = new Uint8Array(data);
      const opcode = peekOpcode(bytes);
      const reader = new BinaryReader(bytes);
      reader.u8();
      switch (opcode) {
        case ServerOp.Welcome:
          this.welcome = decodeJsonEnvelope(reader);
          break;
        case ServerOp.Snapshot:
          this.lastSnapshot = decodeSnapshot(reader);
          this.snapshotCount++;
          break;
        case ServerOp.SystemNotice:
          this.notices.push({ code: reader.u16(), detail: reader.string() });
          break;
        default:
          break; // roster/chat are not asserted here
      }
    });
  }

  async connect() {
    await this.opened;
    this.socket.send(
      encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        token: this.token,
        characterId: this.characterId,
      }),
    );
    const deadline = Date.now() + 5000;
    while (!this.welcome && Date.now() < deadline) {
      if (this.notices.length > 0) {
        throw new Error(`${this.label} rejected: notice code ${this.notices[0].code}`);
      }
      await sleep(20);
    }
    if (!this.welcome) throw new Error(`${this.label} never received Welcome`);
  }

  sendInput(moveX, moveZ, buttons = 0, yaw = 0) {
    this.seq = (this.seq + 1) & 0xffff;
    this.socket.send(encodeInputIntent({ seq: this.seq, moveX, moveZ, yaw, buttons }));
  }

  close() {
    this.socket.close();
  }
}

/**
 * Note: we never call process.exit() after logging — stdout to a pipe is async in
 * Node, and exiting immediately truncates buffered output. Set exitCode instead and
 * let the event loop drain once the sockets are closed.
 */
class SmokeFailure extends Error {}

const fail = (message) => {
  throw new SmokeFailure(message);
};

const ok = (message) => console.log(`✅ ${message}`);

const main = async () => {
  console.log(`Dawned smoke test → ${URL}\n`);

  // REST fixtures: two accounts, one character each (world-unique names owned
  // by their accounts, so re-runs find them again).
  let walker;
  let observer;
  try {
    const [walkerToken, observerToken] = await Promise.all([
      ensureAccount(API_BASE, 'zz_smoke_walker', PASSWORD),
      ensureAccount(API_BASE, 'zz_smoke_watcher', PASSWORD),
    ]);
    const [walkerCharacter, observerCharacter] = await Promise.all([
      ensureCharacter(API_BASE, walkerToken, 'Smokewalker', 'warrior'),
      ensureCharacter(API_BASE, observerToken, 'Smokewatcher', 'mage'),
    ]);
    ok(
      `fixtures ready (${walkerCharacter.name} #${walkerCharacter.id}, ${observerCharacter.name} #${observerCharacter.id})`,
    );
    walker = new TestClient('walker', walkerToken, walkerCharacter.id);
    observer = new TestClient('observer', observerToken, observerCharacter.id);
  } catch (error) {
    fail(`REST fixture setup failed: ${error.message}`);
  }

  try {
    await walker.connect();
    await observer.connect();
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    fail(`handshake failed: ${error.message}`);
  }
  ok(`both clients handshaked (ids ${walker.welcome.selfId} and ${observer.welcome.selfId})`);

  if (walker.welcome.protocolVersion !== PROTOCOL_VERSION) {
    fail(`protocol mismatch: server ${walker.welcome.protocolVersion}, client ${PROTOCOL_VERSION}`);
  }
  if (walker.welcome.characterId !== walker.characterId) {
    fail(`welcome carries character ${walker.welcome.characterId}, expected ${walker.characterId}`);
  }
  const rosterEntry = observer.welcome.players.find((p) => p.id === walker.welcome.selfId);
  if (rosterEntry && !rosterEntry.appearance) {
    fail('roster entries are missing appearance data');
  }

  // Let snapshots start flowing, then record the walker's starting position.
  await sleep(300);
  if (!walker.lastSnapshot) fail('walker received no snapshots');
  if (!observer.lastSnapshot) fail('observer received no snapshots');
  const start = { ...walker.lastSnapshot.self };

  // Walk north (into the island — the spawn beach is near the south coast),
  // sprinting, for WALK_TICKS ticks at tick rate.
  for (let i = 0; i < WALK_TICKS; i++) {
    walker.sendInput(0, -1, InputButton.Sprint);
    observer.sendInput(0, 0, 0);
    await sleep(TICK_MS);
  }
  await sleep(200);

  const end = walker.lastSnapshot.self;
  const travelled = Math.hypot(end.x - start.x, end.z - start.z);
  ok(`walker received ${walker.snapshotCount} snapshots, moved ${travelled.toFixed(2)} m`);

  if (travelled < 5) {
    fail(`walker barely moved (${travelled.toFixed(2)} m) — server is not simulating input`);
  }

  // Speed envelope: sprint speed × elapsed seconds, with slack for accel + jitter.
  const elapsedSec = (WALK_TICKS * TICK_MS + 500) / 1000;
  const maxLegal = MOVE_SPEED * SPRINT_MULTIPLIER * elapsedSec;
  if (travelled > maxLegal) {
    fail(
      `walker exceeded the legal speed envelope: ${travelled.toFixed(2)} m > ${maxLegal.toFixed(2)} m`,
    );
  }
  ok(`movement inside the authoritative speed envelope (≤ ${maxLegal.toFixed(2)} m)`);

  // The observer must see the walker as a remote entity, at the same place.
  const seen = observer.lastSnapshot.entities.find((e) => e.id === walker.welcome.selfId);
  if (!seen) {
    fail(
      `observer does not see the walker (entities: ${observer.lastSnapshot.entities.map((e) => e.id).join(', ') || 'none'})`,
    );
  }
  const disagreement = Math.hypot(seen.x - end.x, seen.z - end.z);
  ok(`observer sees the walker at Δ${disagreement.toFixed(3)} m from the walker's own view`);
  if (disagreement > 1.0) {
    fail(`views disagree by ${disagreement.toFixed(2)} m — replication is broken`);
  }

  // And symmetrically: the walker sees the observer.
  const backReference = walker.lastSnapshot.entities.find((e) => e.id === observer.welcome.selfId);
  if (!backReference) fail('walker does not see the observer');
  ok('replication is symmetric (each client sees the other)');

  // Walk back so the persisted position stays near spawn for the next run.
  for (let i = 0; i < WALK_TICKS; i++) {
    walker.sendInput(0, 1, InputButton.Sprint);
    await sleep(TICK_MS);
  }

  walker.close();
  observer.close();
  await sleep(100);

  console.log('\n🌅 Smoke test passed — two authenticated clients, one authoritative world.\n');
};

main().catch((error) => {
  console.error(
    `\n❌ ${error instanceof SmokeFailure ? error.message : `unexpected error: ${error.stack ?? error.message}`}\n`,
  );
  process.exitCode = 1;
});
