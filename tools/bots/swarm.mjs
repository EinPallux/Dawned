#!/usr/bin/env node
/**
 * Bot swarm — the P3/P14 load harness (docs/tech/NETWORKING.md §8): N headless
 * authenticated clients wander, sprint and jump around the island while you
 * watch tick timings (/ops/metrics) and join with a real browser on top.
 *
 * Bots are provisioned straight in the database (dev/staging only, same posture
 * as the browser smokes): accounts `zz_bot_*` carry an unusable password hash —
 * they can never log in through the front door — and each run mints fresh
 * short-lived sessions for them. Accounts/characters are reused across runs.
 *
 * Usage:
 *   node tools/bots/swarm.mjs [--bots 20] [--minutes 2] [--url ws://127.0.0.1:8081/game]
 *
 * DATABASE_URL env overrides the dev default. Exits non-zero if any bot fails
 * to reach the world or the swarm loses more than 10% of its bots mid-run.
 */

import { createHash, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import pg from 'pg';
import {
  BinaryReader,
  InputButton,
  PROTOCOL_VERSION,
  ServerOp,
  TICK_MS,
  decodeJsonEnvelope,
  decodeSnapshot,
  encodeHello,
  encodeInputIntent,
  encodePing,
  peekOpcode,
} from '@dawned/shared';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const BOT_COUNT = Number(arg('bots', 20));
const RUN_MINUTES = Number(arg('minutes', 2));
const GAME_URL = arg('url', 'ws://127.0.0.1:8081/game');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://dawned:dawned@127.0.0.1:5432/dawned';

/** Marker instead of a hash — argon2 verification fails closed on it. */
const UNUSABLE_HASH = '!bot-account-no-login';
const CLASSES = ['warrior', 'mage', 'rogue', 'cleric'];
const OUTFITS = ['ranger', 'peasant'];

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** aa, ab, … az, ba… — letters only, character names reject digits. */
const suffix = (index) =>
  String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + (index % 26));

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

const provision = async (count) => {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const bots = [];
  for (let i = 0; i < count; i++) {
    const accountName = `zz_bot_${suffix(i)}`;
    const characterName = `Botwander${suffix(i)}`;
    const account = await db.query(
      `INSERT INTO accounts (name, pass_hash) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET status = 'active'
       RETURNING id`,
      [accountName, UNUSABLE_HASH],
    );
    const accountId = account.rows[0].id;

    let character = await db.query(
      `SELECT id FROM characters WHERE account_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [accountId],
    );
    if (character.rows.length === 0) {
      character = await db.query(
        `INSERT INTO characters (account_id, name, class_id, body, outfit)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [accountId, characterName, CLASSES[i % 4], i % 2 === 0 ? 'm' : 'f', OUTFITS[i % 2]],
      );
    }

    const token = randomBytes(16).toString('hex');
    await db.query(
      `INSERT INTO sessions (account_id, token_hash, kind, expires_at)
       VALUES ($1, $2, 'game', now() + interval '1 day')`,
      [accountId, sha256Hex(token)],
    );
    bots.push({ index: i, accountId, characterId: character.rows[0].id, token });
  }
  await db.end();
  return bots;
};

const cleanupSessions = async (bots) => {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1::text[])`, [
    bots.map((bot) => sha256Hex(bot.token)),
  ]);
  await db.end();
};

// ---------------------------------------------------------------------------
// Bot brain
// ---------------------------------------------------------------------------

class Bot {
  constructor(spec) {
    this.spec = spec;
    this.seq = 0;
    this.snapshots = 0;
    this.welcomed = false;
    this.dead = false;
    this.x = 0;
    this.z = 0;
    // Wander state.
    this.heading = Math.random() * Math.PI * 2;
    this.mode = 'walk'; // walk | idle
    this.modeUntil = 0;
    this.sprinting = false;
    this.lastMoveCheck = { x: 0, z: 0, at: 0 };
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(GAME_URL);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const guard = setTimeout(() => reject(new Error(`bot ${this.spec.index}: no welcome`)), 8000);
      socket.on('open', () => {
        socket.send(
          encodeHello({
            protocolVersion: PROTOCOL_VERSION,
            token: this.spec.token,
            characterId: this.spec.characterId,
          }),
        );
      });
      socket.on('message', (data) => {
        const bytes = new Uint8Array(data);
        const op = peekOpcode(bytes);
        const reader = new BinaryReader(bytes);
        reader.u8();
        if (op === ServerOp.Welcome) {
          decodeJsonEnvelope(reader);
          this.welcomed = true;
          clearTimeout(guard);
          resolve();
        } else if (op === ServerOp.Snapshot) {
          const snapshot = decodeSnapshot(reader);
          this.snapshots++;
          this.x = snapshot.self.x;
          this.z = snapshot.self.z;
        }
      });
      socket.on('close', () => {
        this.dead = true;
      });
      socket.on('error', (error) => {
        this.dead = true;
        if (!this.welcomed) {
          clearTimeout(guard);
          reject(new Error(`bot ${this.spec.index}: ${error.message}`));
        }
      });
    });
  }

  /** One 20 Hz brain tick: keep wandering, sprint in bursts, hop sometimes. */
  tick(now) {
    if (this.dead || this.socket.readyState !== WebSocket.OPEN) return;

    if (now >= this.modeUntil) {
      if (this.mode === 'walk' && Math.random() < 0.25) {
        this.mode = 'idle';
        this.modeUntil = now + 500 + Math.random() * 1500;
      } else {
        this.mode = 'walk';
        this.heading = Math.random() * Math.PI * 2;
        this.sprinting = Math.random() < 0.4;
        this.modeUntil = now + 2000 + Math.random() * 3000;
      }
    }
    // Walked into something unwalkable (cliff, deep-ocean border): turn around
    // instead of grinding against the wall for the rest of the mode.
    if (this.mode === 'walk' && now - this.lastMoveCheck.at > 1500) {
      const moved = Math.hypot(this.x - this.lastMoveCheck.x, this.z - this.lastMoveCheck.z);
      if (this.lastMoveCheck.at > 0 && moved < 0.5) {
        this.heading = Math.random() * Math.PI * 2;
      }
      this.lastMoveCheck = { x: this.x, z: this.z, at: now };
    }

    const walking = this.mode === 'walk';
    let buttons = 0;
    if (walking && this.sprinting) buttons |= InputButton.Sprint;
    if (walking && Math.random() < 0.012) buttons |= InputButton.Jump;

    this.seq = (this.seq + 1) & 0xffff;
    this.socket.send(
      encodeInputIntent({
        seq: this.seq,
        moveX: walking ? Math.sin(this.heading) : 0,
        moveZ: walking ? Math.cos(this.heading) : 0,
        yaw: this.heading,
        buttons,
      }),
    );
    // Keep the idle sweep off our back even when the tab equivalent is quiet.
    if (this.seq % 40 === 0) this.socket.send(encodePing({ clientTimeMs: now }));
  }

  disconnect() {
    this.socket?.close();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const main = async () => {
  console.log(`Dawned bot swarm → ${BOT_COUNT} bots, ${RUN_MINUTES} min, ${GAME_URL}\n`);
  const specs = await provision(BOT_COUNT);
  console.log(`provisioned ${specs.length} bot accounts/characters/sessions`);

  const bots = specs.map((spec) => new Bot(spec));
  for (const bot of bots) {
    await bot.connect(); // staggered joins — the spawn ring handles the rest
    await sleep(60);
  }
  console.log(`all ${bots.length} bots in the world; wandering…\n`);

  const brain = setInterval(() => {
    const now = Date.now();
    for (const bot of bots) bot.tick(now);
  }, TICK_MS);

  const endAt = Date.now() + RUN_MINUTES * 60_000;
  let failed = false;
  while (Date.now() < endAt) {
    await sleep(10_000);
    const alive = bots.filter((bot) => !bot.dead).length;
    const snapshots = bots.reduce((sum, bot) => sum + bot.snapshots, 0);
    const spread = bots
      .filter((bot) => !bot.dead)
      .slice(0, 3)
      .map((bot) => `(${bot.x.toFixed(0)},${bot.z.toFixed(0)})`)
      .join(' ');
    console.log(
      `alive ${alive}/${bots.length} · ${snapshots} snapshots total · sample pos ${spread}`,
    );
    if (alive < bots.length * 0.9) {
      console.error('❌ lost more than 10% of the swarm');
      failed = true;
      break;
    }
  }

  clearInterval(brain);
  for (const bot of bots) bot.disconnect();
  await sleep(500);
  await cleanupSessions(specs);
  console.log(
    `\n${failed ? '❌ swarm run failed' : '🌅 swarm run complete'} — sessions cleaned.\n`,
  );
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(`\n❌ swarm error: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
