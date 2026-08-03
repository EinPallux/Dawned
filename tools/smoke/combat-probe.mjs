#!/usr/bin/env node
/**
 * P4 server-combat probe (headless): the combat pipeline exercised over the
 * real protocol, no browser. One client walks from spawn to the training
 * dummies, swings the basic combo, then pushes on to the Glub camp and lets
 * itself get bitten. Asserts: enemy meta + entities stream, AbilityStart/
 * Resolve rounds with real damage, dummy HP visibly drops, combo steps chain,
 * enemies aggro (alert event) and fight back (player HP drops), and the
 * telegraph event fires for the heavy.
 *
 * Usage: node tools/smoke/combat-probe.mjs [ws://127.0.0.1:8081/game]
 * Requires: the game server (protocol v6, P4 seeds migrated), local Postgres.
 */

import { WebSocket } from 'ws';
import pg from 'pg';
import {
  ActionId,
  BinaryReader,
  EntityKind,
  PROTOCOL_VERSION,
  ServerOp,
  TICK_MS,
  decodeAbilityResolve,
  decodeAbilityStart,
  decodeEntityEvent,
  decodeJsonEnvelope,
  decodeSnapshot,
  decodeSystemNotice,
  decodeTelegraph,
  encodeAbilityRequest,
  encodeHello,
  encodeInputIntent,
  peekOpcode,
} from '@dawned/shared';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const URL = process.argv[2] ?? 'ws://127.0.0.1:8081/game';
const API_BASE = URL.replace(/^ws/, 'http').replace(/\/game$/, '');
const PASSWORD = 'smoke-pass-123456';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (message) => console.log(`✅ ${message}`);
const fail = (message) => {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
};

class ProbeClient {
  constructor() {
    this.seq = 1;
    this.attackSeq = 1;
    this.welcome = null;
    this.lastSnapshot = null;
    this.enemyMeta = new Map(); // id → meta
    this.abilityStarts = [];
    this.abilityResolves = [];
    this.entityEvents = [];
    this.telegraphs = [];
    this.notices = [];
  }

  async connect(token, characterId) {
    this.socket = new WebSocket(URL);
    this.socket.binaryType = 'arraybuffer';
    this.socket.on('message', (data) => {
      const bytes = new Uint8Array(data);
      const opcode = peekOpcode(bytes);
      const reader = new BinaryReader(bytes);
      reader.u8();
      switch (opcode) {
        case ServerOp.Welcome:
          this.welcome = decodeJsonEnvelope(reader);
          return;
        case ServerOp.Snapshot:
          this.lastSnapshot = decodeSnapshot(reader);
          return;
        case ServerOp.EnemyMeta: {
          const meta = decodeJsonEnvelope(reader);
          for (const enemy of meta.enemies) this.enemyMeta.set(enemy.id, enemy);
          return;
        }
        case ServerOp.AbilityStart:
          this.abilityStarts.push(decodeAbilityStart(reader));
          return;
        case ServerOp.AbilityResolve:
          this.abilityResolves.push(decodeAbilityResolve(reader));
          return;
        case ServerOp.EntityEvent:
          this.entityEvents.push(decodeEntityEvent(reader));
          return;
        case ServerOp.Telegraph:
          this.telegraphs.push(decodeTelegraph(reader));
          return;
        case ServerOp.SystemNotice:
          this.notices.push(decodeSystemNotice(reader));
          return;
        default:
          return; // chat, roster, pong, projectiles — not asserted here
      }
    });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.send(encodeHello({ protocolVersion: PROTOCOL_VERSION, token, characterId }));
    const deadline = Date.now() + 5000;
    while (!this.welcome) {
      if (Date.now() > deadline) fail('no Welcome inside 5 s');
      await sleep(20);
    }
  }

  intent(moveX, moveZ, yaw, buttons = 0) {
    this.socket.send(encodeInputIntent({ seq: this.seq++ & 0xffff, moveX, moveZ, yaw, buttons }));
  }

  attack(aimYaw) {
    this.socket.send(
      encodeAbilityRequest({
        seq: this.attackSeq++,
        action: ActionId.BasicAttack,
        aimYaw,
        aimPitch: 0,
      }),
    );
  }

  /** Walk toward (x, z) at full input until within `closeEnough`, max `maxMs`. */
  async walkTo(x, z, closeEnough, maxMs) {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const self = this.lastSnapshot?.self;
      if (!self) {
        await sleep(TICK_MS);
        continue;
      }
      const dx = x - self.x;
      const dz = z - self.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= closeEnough) return true;
      if (Date.now() > deadline) return false;
      const yaw = Math.atan2(dx, dz);
      this.intent(dx / dist, dz / dist, yaw);
      await sleep(TICK_MS);
    }
  }

  nearestEnemy(filter = () => true) {
    const self = this.lastSnapshot?.self;
    if (!self) return null;
    let best = null;
    let bestDist = Infinity;
    for (const entity of this.lastSnapshot.entities) {
      if (entity.kind !== EntityKind.Enemy) continue;
      const meta = this.enemyMeta.get(entity.id);
      if (!meta || !filter(meta, entity)) continue;
      const dist = Math.hypot(entity.x - self.x, entity.z - self.z);
      if (dist < bestDist) {
        best = { entity, meta, dist };
        bestDist = dist;
      }
    }
    return best;
  }
}

const main = async () => {
  console.log(`Dawned P4 combat probe → ${URL}\n`);
  const token = await ensureAccount(API_BASE, 'zz_combat_probe', PASSWORD);
  const character = await ensureCharacter(API_BASE, token, 'Combatprobe', 'warrior');
  // A clean slate: park the character at spawn so the walk is deterministic.
  const client = new ProbeClient();
  await client.connect(token, character.id);
  ok(`in world as ${character.name} (#${client.welcome.selfId})`);

  // Self HP present in snapshots (v6).
  await sleep(300);
  const self0 = client.lastSnapshot?.self;
  if (!self0 || self0.maxHp <= 0 || self0.hp <= 0) fail('self hp/maxHp missing from snapshot');
  ok(`self vitals stream (${self0.hp}/${self0.maxHp} hp)`);

  // --- death + respawn round trip (runs FIRST — the west camp is untouched) --
  // A second ACCOUNT (single-session rule) parks a 4 HP character inside the
  // west glub camp: perception alerts, bites kill, the soul-screen respawn
  // request revives at the shrine with the Dawned mark. OOC regen ticks from
  // the start (a P4 feature), so "loaded low" is asserted loosely.
  const token2 = await ensureAccount(API_BASE, 'zz_combat_probe2', PASSWORD);
  const doomedCharacter = await ensureCharacter(API_BASE, token2, 'Doomedtwo', 'rogue');
  const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://dawned:dawned@127.0.0.1:5432/dawned';
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(
    'UPDATE characters SET hp = 4, pos_x = -14, pos_y = 5, pos_z = 312 WHERE id = $1',
    [doomedCharacter.id],
  );
  await db.end();

  const doomed = new ProbeClient();
  await doomed.connect(token2, doomedCharacter.id);
  await sleep(300);
  const loadedHp = doomed.lastSnapshot.self.hp;
  if (loadedHp > doomed.lastSnapshot.self.maxHp * 0.25) {
    fail(`persisted low HP did not load (resumed at ${loadedHp})`);
  }
  ok(`doomed run resumes low (${loadedHp}/${doomed.lastSnapshot.self.maxHp} hp, regen ticking)`);

  const deathDeadline = Date.now() + 60_000;
  while (Date.now() < deathDeadline) {
    doomed.intent(0, 0, 0);
    if (
      doomed.lastSnapshot.self.hp === 0 &&
      doomed.entityEvents.some((e) => e.event === 3 && e.entityId === doomed.welcome.selfId)
    ) {
      break;
    }
    await sleep(TICK_MS * 2);
  }
  if (doomed.lastSnapshot.self.hp !== 0) fail('the west camp never finished the doomed character');
  ok('death: hp 0 + Death event');
  const doomedAlerts = doomed.entityEvents.filter((e) => e.event === 1);
  if (doomedAlerts.length === 0) fail('no Alert beat before the camp committed');
  ok(`enemies alert before committing (${doomedAlerts.length} beats)`);

  // Movement while dead must not move the body.
  const deadPos = { x: doomed.lastSnapshot.self.x, z: doomed.lastSnapshot.self.z };
  for (let i = 0; i < 20; i++) {
    doomed.intent(0, -1, 0);
    await sleep(TICK_MS);
  }
  const still = doomed.lastSnapshot.self;
  if (Math.hypot(still.x - deadPos.x, still.z - deadPos.z) > 0.05) fail('a dead character walked');
  ok('dead bodies ignore movement intents');

  doomed.socket.send(
    encodeAbilityRequest({ seq: 99, action: ActionId.Respawn, aimYaw: 0, aimPitch: 0 }),
  );
  await sleep(600);
  const revived = doomed.lastSnapshot.self;
  if (revived.hp !== revived.maxHp) fail(`respawn hp ${revived.hp}/${revived.maxHp}`);
  if (Math.hypot(revived.x - 0, revived.z - 400) > 25) fail('respawned far from the shrine ring');
  const dawned = doomed.entityEvents.find((e) => e.event === 7);
  if (!dawned) fail('no Dawned debuff event on respawn');
  ok(`respawn at the shrine with full HP + Dawned (${(dawned.a / 1000).toFixed(0)} s)`);
  doomed.socket.close();

  // Walk toward the dummy line at (0, 381) — meta + entities must appear.
  const reached = await client.walkTo(0, 383.5, 2.2, 30_000);
  if (!reached) fail('never reached the training dummies');
  let dummy = client.nearestEnemy((meta) => meta.typeId === 'enemy_training_dummy');
  if (!dummy) fail('no training dummy in the entity stream');
  if (!client.enemyMeta.size) fail('no EnemyMeta received');
  ok(
    `dummy in AOI with meta ("${dummy.meta.name}" lvl ${dummy.meta.level}, ${dummy.dist.toFixed(1)} m)`,
  );

  // Close to melee range on the dummy's actual position (reach 2.6 m).
  if (!(await client.walkTo(dummy.entity.x, dummy.entity.z + 1.4, 0.6, 15_000))) {
    fail('could not close to melee range on the dummy');
  }
  dummy = client.nearestEnemy((meta) => meta.typeId === 'enemy_training_dummy');
  if (!dummy || dummy.dist > 2.4) fail(`still out of reach (${dummy?.dist.toFixed(1)} m)`);

  // Swing the basic combo at the dummy: A → B → C with link timing.
  const hpBefore = dummy.entity.hpFraction;
  for (let step = 0; step < 3; step++) {
    const target = client.nearestEnemy((meta) => meta.typeId === 'enemy_training_dummy');
    if (!target) fail('dummy vanished mid-combo');
    const self = client.lastSnapshot.self;
    const aim = Math.atan2(target.entity.x - self.x, target.entity.z - self.z);
    client.attack(aim);
    // Stand still through the swing; press the next inside the link window.
    const stepMs = [450, 500, 750][step];
    const start = Date.now();
    while (Date.now() - start < stepMs * 0.75) {
      client.intent(0, 0, aim);
      await sleep(TICK_MS);
    }
  }
  await sleep(800);

  const starts = client.abilityStarts.filter((s) => s.entityId === client.welcome.selfId);
  if (starts.length < 3) fail(`expected 3 AbilityStarts, saw ${starts.length}`);
  if (starts[0].step !== 0 || starts[1].step !== 1 || starts[2].step !== 2) {
    fail(`combo steps did not chain (saw ${starts.map((s) => s.step).join(',')})`);
  }
  ok('basic combo chains A → B → C on the server');

  const resolves = client.abilityResolves.filter(
    (r) => r.attackerId === client.welcome.selfId && r.hits.length > 0,
  );
  if (resolves.length < 3) fail(`expected ≥3 landed resolves, saw ${resolves.length}`);
  const totalDamage = resolves.flatMap((r) => r.hits).reduce((sum, h) => sum + h.amount, 0);
  if (totalDamage <= 0) fail('resolves carried no damage');
  ok(`melee arc resolves with damage (${totalDamage} total over ${resolves.length} hits)`);

  const dummyAfter = client.nearestEnemy((meta) => meta.typeId === 'enemy_training_dummy');
  if (!dummyAfter || dummyAfter.entity.hpFraction >= hpBefore) {
    fail('dummy hp fraction did not drop');
  }
  ok(
    `dummy HP dropped (${(hpBefore * 100).toFixed(0)}% → ${(dummyAfter.entity.hpFraction * 100).toFixed(0)}%)`,
  );

  // March into the Glub camp and pick the fight by DAMAGE (works whatever
  // state a previous run left the camp in — damage-aggro is unconditional).
  await client.walkTo(0, 334, 6, 45_000);
  let glub = client.nearestEnemy(
    (meta, entity) => meta.typeId === 'enemy_shore_glub' && (entity.flags & (1 << 7)) === 0,
  );
  if (!glub) fail('no living glub in AOI at the camp');
  ok(`glub camp reached (nearest glub ${glub.dist.toFixed(1)} m)`);
  if (!(await client.walkTo(glub.entity.x, glub.entity.z + 1.2, 0.8, 15_000))) {
    fail('could not close on a glub');
  }
  glub = client.nearestEnemy((meta) => meta.typeId === 'enemy_shore_glub');
  {
    const self = client.lastSnapshot.self;
    client.attack(Math.atan2(glub.entity.x - self.x, glub.entity.z - self.z));
  }

  const hpStart = client.lastSnapshot.self.hp;
  const fightDeadline = Date.now() + 25_000;
  while (Date.now() < fightDeadline) {
    client.intent(0, 0, client.lastSnapshot.self.yaw);
    if (client.lastSnapshot.self.hp < hpStart) break;
    await sleep(TICK_MS * 2);
  }
  if (client.lastSnapshot.self.hp >= hpStart) fail('glubs never fought back');
  ok(`glubs fight back (hp ${hpStart} → ${client.lastSnapshot.self.hp})`);

  const enemyStarts = client.abilityStarts.filter((s) => s.entityId !== client.welcome.selfId);
  if (enemyStarts.length === 0) fail('no enemy AbilityStart wind-ups seen');
  ok(`enemy swings broadcast wind-ups (${enemyStarts.length})`);

  // The heavy (glub_tackle) telegraphs a cone sooner or later.
  const telegraphDeadline = Date.now() + 30_000;
  while (client.telegraphs.length === 0 && Date.now() < telegraphDeadline) {
    client.intent(0, 0, client.lastSnapshot.self.yaw);
    await sleep(TICK_MS * 2);
  }
  if (client.telegraphs.length === 0) fail('no telegraph for the heavy attack');
  const tele = client.telegraphs[0];
  ok(`heavy telegraphs the exact shape (cone r=${tele.size.toFixed(1)} m, ${tele.impactInMs} ms)`);

  client.socket.close();
  console.log('\n⚔️  P4 combat probe passed — pipeline, AI, telegraphs, death loop live.\n');
  process.exit(0);
};

main().catch((error) => fail(`unexpected: ${error.stack ?? error.message}`));
