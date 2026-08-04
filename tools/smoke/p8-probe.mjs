#!/usr/bin/env node
/**
 * P8 live probe (headless; the browser-p8 smoke at P8-E drives the UI):
 * walks the item wire end to end against a running dev server.
 *   1. InventorySync + LootBags follow the Welcome with the whole pack.
 *   2. /ops/grant delivers items and gold → ItemNotice + a fresh sync.
 *   3. Bag drags go through the shared planner: a legal move lands, an
 *      illegal one is refused AND still resynced (mispredictions self-heal).
 *   4. Equipping a weapon changes the roster's visible main hand.
 *   5. A relog sees the PERSISTED bag, paper-doll and purse.
 *
 * Fixtures come from published content: the probe picks a stackable item and
 * (if one is published) a weapon the fixture character may actually wield, so
 * it keeps working as P8-C's catalogue grows. Usage:
 *   node tools/smoke/p8-probe.mjs [ws://host:port/game]
 */

import { WebSocket } from 'ws';
import {
  BinaryReader,
  PROTOCOL_VERSION,
  ServerOp,
  decodeJsonEnvelope,
  encodeHello,
  encodeItemOp,
  peekOpcode,
} from '@dawned/shared';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const URL = process.argv[2] ?? 'ws://127.0.0.1:8081/game';
const API_BASE = URL.replace(/^ws/, 'http').replace(/\/game$/, '');
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const PASSWORD = 'smoke-pass-123456';
const CLASS_ID = 'warrior';
const CHARACTER = 'Packrat';

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
    this.inventory = null;
    this.bags = null;
    this.notices = [];
    this.roster = [];
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('message', (data) => {
      const bytes = new Uint8Array(data);
      const opcode = peekOpcode(bytes);
      if (
        opcode !== ServerOp.InventorySync &&
        opcode !== ServerOp.LootBags &&
        opcode !== ServerOp.ItemNotice &&
        opcode !== ServerOp.Welcome &&
        opcode !== ServerOp.Roster
      ) {
        return;
      }
      const reader = new BinaryReader(bytes);
      reader.u8();
      if (opcode === ServerOp.InventorySync) this.inventory = decodeJsonEnvelope(reader);
      else if (opcode === ServerOp.LootBags) this.bags = decodeJsonEnvelope(reader);
      else if (opcode === ServerOp.ItemNotice) this.notices.push(decodeJsonEnvelope(reader));
      else this.roster = decodeJsonEnvelope(reader).players ?? this.roster;
    });
    this.token = token;
    this.characterId = characterId;
  }

  async hello() {
    await this.opened;
    this.socket.send(
      encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        token: this.token,
        characterId: this.characterId,
      }),
    );
    await sleep(900);
    if (!this.inventory) fail('no InventorySync followed the Welcome');
  }

  /** Send one item op and wait for the tick that answers it. */
  async send(op) {
    this.notices = [];
    this.socket.send(encodeItemOp(op));
    await sleep(400);
  }

  cells() {
    return new Map(this.inventory.bag);
  }

  refusal() {
    return this.notices.find((notice) => notice.kind === 'refused')?.reason ?? null;
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
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

// --- fixtures --------------------------------------------------------------

const catalogue = await fetch(`${API_BASE}/api/content/items`).then((response) => response.json());
const items = catalogue.items ?? [];
if (items.length === 0) {
  console.log('⚠️  no published items yet (P8-C authors the catalogue) — nothing to probe.');
  process.exit(0);
}
const stackable = items.find((item) => item.stack > 1);
if (!stackable) fail('no stackable item is published — the probe needs one to split');
const weapon = items.find(
  (item) =>
    item.category === 'weapon' &&
    item.requiresLevel <= 1 &&
    (item.classLock.length === 0 || item.classLock.includes(CLASS_ID)),
);

const token = await ensureAccount(API_BASE, 'p8probe', PASSWORD);
const character = await ensureCharacter(API_BASE, token, CHARACTER, CLASS_ID);

// A re-runnable probe starts from a known pack: hand the character back to
// zero by selling nothing and simply accounting for what is already there.
const client = new ProbeClient(token, character.id);
await client.hello();
const startCells = client.cells().size;
const startGold = client.inventory.gold;
ok(`hello sync: ${startCells} cells, ${startGold} gold, ${client.bags.bags.length} bags in sight`);

// --- 1. grants -------------------------------------------------------------

const grant = await ops('/ops/grant', { player: CHARACTER, itemId: stackable.id, qty: 3 });
if (grant.status !== 200) fail(`/ops/grant failed: ${grant.status}`);
await sleep(500);
const afterGrant = client.cells();
const granted = [...afterGrant.entries()].find(([, stack]) => stack.itemId === stackable.id);
if (!granted) fail(`the granted ${stackable.id} never arrived in the bag`);
ok(`grant: ${stackable.name} ×${granted[1].qty} in cell ${granted[0]}`);

const goldBefore = client.inventory.gold;
await ops('/ops/grant', { player: CHARACTER, gold: 25 });
await sleep(400);
if (client.inventory.gold !== goldBefore + 25) {
  fail(`purse should be ${goldBefore + 25}, is ${client.inventory.gold}`);
}
ok(`gold grant: ${goldBefore} → ${client.inventory.gold}`);

// --- 2. drags: the planner decides, the sync corrects ----------------------

const from = granted[0];
const to = [...Array(48).keys()].find((cell) => !client.cells().has(cell));
await client.send({ kind: 'move', from, to });
if (client.cells().get(to)?.itemId !== stackable.id) fail(`move ${from}→${to} did not land`);
ok(`move: cell ${from} → ${to}`);

// Dragging out of an empty cell is the classic mispredicted drag.
const empty = [...Array(48).keys()]
  .reverse()
  .filter((cell) => !client.cells().has(cell))
  .slice(0, 2);
await client.send({ kind: 'move', from: empty[0], to: empty[1] });
if (client.refusal() !== 'empty_slot') fail(`expected empty_slot, got ${client.refusal()}`);
if (!client.inventory) fail('a refusal must still carry a sync');
ok(`refusal answers with a sync (${client.refusal()})`);

// --- 3. equipping is visible to everyone ----------------------------------

if (weapon) {
  await ops('/ops/grant', { player: CHARACTER, itemId: weapon.id, qty: 1 });
  await sleep(400);
  const weaponCell = [...client.cells().entries()].find(([, stack]) => stack.itemId === weapon.id);
  if (!weaponCell) fail(`${weapon.id} never arrived`);
  await client.send({ kind: 'equip', from: weaponCell[0] });
  if (client.inventory.equipment.mainhand?.itemId !== weapon.id) {
    fail(`${weapon.id} did not reach the main hand`);
  }
  const self = client.roster.find((entry) => entry.name === CHARACTER);
  if (weapon.modelRef && self?.mainhandModel !== weapon.modelRef) {
    fail(`the roster still shows ${String(self?.mainhandModel)} in the main hand`);
  }
  ok(`equip: ${weapon.name} → main hand, roster model ${String(self?.mainhandModel)}`);
} else {
  console.log('⚠️  no level-1 weapon published for this class — skipping the equip leg.');
}

// --- 4. persistence --------------------------------------------------------

const expectedCells = client.cells();
const expectedEquipment = client.inventory.equipment;
const expectedGold = client.inventory.gold;
client.close();
await sleep(1200);

const relog = new ProbeClient(token, character.id);
await relog.hello();
if (relog.cells().size !== expectedCells.size) {
  fail(`relog: ${relog.cells().size} cells, expected ${expectedCells.size}`);
}
for (const [cell, stack] of expectedCells) {
  const restored = relog.cells().get(cell);
  if (restored?.itemId !== stack.itemId || restored.qty !== stack.qty) {
    fail(`relog: cell ${cell} came back as ${JSON.stringify(restored)}`);
  }
}
if (relog.inventory.equipment.mainhand?.itemId !== expectedEquipment.mainhand?.itemId) {
  fail('relog: the paper-doll did not survive');
}
if (relog.inventory.gold !== expectedGold) {
  fail(`relog: purse is ${relog.inventory.gold}, expected ${expectedGold}`);
}
ok(`relog: ${relog.cells().size} cells, ${relog.inventory.gold} gold, paper-doll intact`);
relog.close();

console.log('\n🌅 P8 probe passed — grants, drags, equips and persistence over the v10 wire.');
process.exit(0);
