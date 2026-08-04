#!/usr/bin/env node
/**
 * P7 live probe (headless; the browser-p7 smoke at P7-E drives the UI):
 * drives the progression wire end to end against a running dev server.
 *   1. ProgressSync follows the Welcome with the character sheet.
 *   2. /ops/setlevel (1 → 10 for re-runnability) → LevelUp + banked points.
 *   3. AllocateStats spends the bank; the sync reflects it.
 *   4. AllocateSkill vs the PUBLISHED trees: tier-1 rank lands, the tier-2
 *      gate refuses at 1 in-branch point (both answered by a sync).
 *   5. A relog sees the PERSISTED level + allocation + skill rank.
 *
 * Usage: node tools/smoke/p7-probe.mjs [ws://host:port/game]
 */

import { WebSocket } from 'ws';
import {
  BinaryReader,
  PROTOCOL_VERSION,
  ServerOp,
  decodeJsonEnvelope,
  decodeLevelUp,
  encodeAllocateSkill,
  encodeAllocateStats,
  encodeHello,
} from '@dawned/shared';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const URL = process.argv[2] ?? 'ws://127.0.0.1:8081/game';
const API_BASE = URL.replace(/^ws/, 'http').replace(/\/game$/, '');
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => {
  console.error(`❌ ${message}`);
  process.exit(1);
};
const ok = (message) => console.log(`✅ ${message}`);

class ProbeClient {
  constructor(token, characterId) {
    this.socket = new WebSocket(URL);
    this.socket.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.welcome = null;
    this.progressSyncs = [];
    this.levelUps = [];
    this.socket.on('message', (data) => {
      const bytes = new Uint8Array(data);
      const reader = new BinaryReader(bytes);
      const opcode = reader.u8();
      if (opcode === ServerOp.Welcome) this.welcome = decodeJsonEnvelope(reader);
      else if (opcode === ServerOp.ProgressSync)
        this.progressSyncs.push(decodeJsonEnvelope(reader));
      else if (opcode === ServerOp.LevelUp) this.levelUps.push(decodeLevelUp(reader));
    });
    this.token = token;
    this.characterId = characterId;
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
    for (let i = 0; i < 100 && !this.welcome; i++) await sleep(50);
    if (!this.welcome) fail('no Welcome within 5 s');
  }

  async waitSyncs(count, what) {
    for (let i = 0; i < 100 && this.progressSyncs.length < count; i++) await sleep(50);
    if (this.progressSyncs.length < count) fail(`no ProgressSync for ${what}`);
    return this.progressSyncs[this.progressSyncs.length - 1];
  }

  close() {
    this.socket.close();
  }
}

const ops = async (path, body) => {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-secret': OPS_SECRET },
    body: JSON.stringify(body),
  });
  if (!response.ok) fail(`${path} → ${response.status}: ${await response.text()}`);
  return response.json();
};

const main = async () => {
  const token = await ensureAccount(API_BASE, 'p7probe', PASSWORD);
  const character = await ensureCharacter(API_BASE, token, 'Probus', 'warrior');

  // 1. Fresh join → ProgressSync rides right behind the Welcome.
  const client = new ProbeClient(token, character.id);
  await client.connect();
  const first = await client.waitSyncs(1, 'join');
  if (typeof first.level !== 'number' || typeof first.xpToNext !== 'number') {
    fail(`join sync malformed: ${JSON.stringify(first)}`);
  }
  ok(
    `join ProgressSync: level ${first.level}, xp ${first.xp}/${first.xpToNext}, gold ${first.gold}`,
  );

  // 2. /ops/setlevel → LevelUp event + a sync with the banked points.
  // Down-level to 1 first so re-runs start from a clean refund, then jump.
  await ops('/ops/setlevel', { player: 'Probus', level: 1 });
  await client.waitSyncs(client.progressSyncs.length + 1, 'reset');
  await ops('/ops/setlevel', { player: 'Probus', level: 10 });
  const afterLevel = await client.waitSyncs(client.progressSyncs.length + 1, 'setlevel');
  if (afterLevel.level !== 10) fail(`setlevel sync says level ${afterLevel.level}`);
  if (afterLevel.unspentStatPoints !== 27 || afterLevel.unspentSkillPoints !== 9) {
    fail(
      `bank wrong: ${afterLevel.unspentStatPoints} stat / ${afterLevel.unspentSkillPoints} skill`,
    );
  }
  for (let i = 0; i < 40 && client.levelUps.length === 0; i++) await sleep(50);
  if (client.levelUps.length === 0) fail('no LevelUp event for /ops/setlevel');
  ok(`setlevel 10: LevelUp event + bank 27 stat / 9 skill`);

  // 3. Spend stat points; the next sync reflects the allocation.
  client.socket.send(encodeAllocateStats({ str: 2, agi: 0, int: 0, vit: 3, end: 1 }));
  const afterAlloc = await client.waitSyncs(client.progressSyncs.length + 1, 'allocate');
  if (afterAlloc.unspentStatPoints !== 21 || afterAlloc.allocated.vit !== 3) {
    fail(`allocation sync wrong: ${JSON.stringify(afterAlloc.allocated)}`);
  }
  ok('AllocateStats: 6 points spent, sync agrees');

  // 4. Skill allocation against the PUBLISHED tree (P7-C): tier-1 node takes
  // the rank; a tier-2 node refuses (needs 3 in-branch) but still syncs.
  client.socket.send(encodeAllocateSkill({ nodeId: 'node_warrior_bulwark_toughened' }));
  const afterSkill = await client.waitSyncs(client.progressSyncs.length + 1, 'skill allocation');
  if (afterSkill.nodes['node_warrior_bulwark_toughened'] !== 1) {
    fail(`tier-1 allocation lost: ${JSON.stringify(afterSkill.nodes)}`);
  }
  if (afterSkill.unspentSkillPoints !== 8) fail('skill point not spent');
  client.socket.send(encodeAllocateSkill({ nodeId: 'node_warrior_bulwark_thick_skull' }));
  const afterLocked = await client.waitSyncs(client.progressSyncs.length + 1, 'tier gate');
  if (afterLocked.nodes['node_warrior_bulwark_thick_skull'] !== undefined) {
    fail('tier-2 node must stay locked at 1 in-branch point');
  }
  ok('AllocateSkill: tier-1 rank taken, tier-2 gate holds, syncs agree');

  // 5. Relog: everything above survived the round trip to Postgres.
  client.close();
  await sleep(700); // let the write-through chain settle
  const again = new ProbeClient(token, character.id);
  await again.connect();
  const persisted = await again.waitSyncs(1, 'relog');
  if (persisted.level !== 10 || persisted.allocated.str !== 2 || persisted.allocated.vit !== 3) {
    fail(`persistence lost: ${JSON.stringify(persisted)}`);
  }
  if (persisted.nodes['node_warrior_bulwark_toughened'] !== 1) {
    fail(`skill rank not persisted: ${JSON.stringify(persisted.nodes)}`);
  }
  ok(
    `relog sees persisted level ${persisted.level}, allocation AND skill rank — write-through holds`,
  );
  again.close();

  console.log('\n🌅 P7-B probe passed — XP wire, setlevel, allocation and persistence all live.');
  process.exit(0);
};

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
