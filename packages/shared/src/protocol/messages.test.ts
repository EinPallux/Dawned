import { describe, expect, it } from 'vitest';
import { BinaryReader, BinaryWriter } from './codec.js';
import {
  HitFlag,
  decodeAbilityReject,
  decodeAbilityRequest,
  decodeAbilityResolve,
  decodeAbilityStart,
  decodeEntityEvent,
  decodeHello,
  decodeInputIntent,
  decodeJsonEnvelope,
  decodePing,
  decodePong,
  decodeProjectileEnd,
  decodeProjectileSpawn,
  decodeSnapshot,
  decodeSystemNotice,
  decodeTelegraph,
  encodeAbilityReject,
  encodeAbilityRequest,
  encodeAbilityState,
  encodeAbilityResolve,
  encodeAbilityStart,
  encodeChatBroadcast,
  encodeEffectSync,
  encodeEnemyMeta,
  encodeEntityEvent,
  encodeHello,
  encodeInputIntent,
  encodePing,
  encodePong,
  encodeProjectileEnd,
  encodeProjectileSpawn,
  encodeSnapshot,
  encodeSystemNotice,
  encodeTelegraph,
  peekOpcode,
  type ChatBroadcastMessage,
  decodeAllocateSkill,
  decodeAllocateStats,
  decodeLevelUp,
  decodeRespec,
  decodeXpGained,
  encodeAllocateSkill,
  encodeAllocateStats,
  encodeLevelUp,
  encodeInventorySync,
  encodeItemNotice,
  encodeItemOp,
  encodeGatherOp,
  encodeGatherState,
  encodeNodeStates,
  encodeProfessionSync,
  type GatherStateMessage,
  type NodeStatesMessage,
  type ProfessionSyncMessage,
  encodeLootBags,
  encodeProgressSync,
  encodeVendorPanel,
  encodeRespec,
  encodeXpGained,
  type SnapshotMessage,
} from './messages.js';
import { parseItemOp } from './item-ops.js';
import { parseGatherOp } from './gather-ops.js';
import { GatherRefusal, PROFESSIONS, gatherRefusalText } from '../formulas/professions.js';
import {
  AbilityRejectReason,
  ActionId,
  ClientOp,
  EntityEventKind,
  InputButton,
  NoticeCode,
  PROTOCOL_VERSION,
  RespecWireKind,
  ServerOp,
  TelegraphShape,
  XpSource,
  actionForSlot,
  slotForAction,
} from './opcodes.js';

/** Strip the opcode byte and hand back a reader positioned at the payload. */
const body = (packet: Uint8Array): BinaryReader => {
  const reader = new BinaryReader(packet);
  reader.u8();
  return reader;
};

describe('handshake and input messages', () => {
  it('round-trips the authenticated Hello', () => {
    const token = 'a'.repeat(32);
    const packet = encodeHello({ protocolVersion: PROTOCOL_VERSION, token, characterId: 42 });
    expect(peekOpcode(packet)).toBe(ClientOp.Hello);
    expect(decodeHello(body(packet))).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      token,
      characterId: 42,
    });
  });

  it('round-trips InputIntent within quantization tolerance', () => {
    const packet = encodeInputIntent({
      seq: 4242,
      moveX: -0.5,
      moveZ: 1,
      yaw: 2.2,
      buttons: InputButton.Sprint | InputButton.Jump,
    });
    const decoded = decodeInputIntent(body(packet));
    expect(decoded.seq).toBe(4242);
    expect(decoded.moveX).toBeCloseTo(-0.5, 2);
    expect(decoded.moveZ).toBeCloseTo(1, 2);
    expect(decoded.yaw).toBeCloseTo(2.2, 3);
    expect(decoded.buttons & InputButton.Sprint).toBeTruthy();
    expect(decoded.buttons & InputButton.Jump).toBeTruthy();
    expect(decoded.buttons & InputButton.Dodge).toBeFalsy();
  });

  it('clamps out-of-range movement axes rather than wrapping them', () => {
    const packet = encodeInputIntent({ seq: 1, moveX: 9, moveZ: -9, yaw: 0, buttons: 0 });
    const decoded = decodeInputIntent(body(packet));
    expect(decoded.moveX).toBeCloseTo(1, 2);
    expect(decoded.moveZ).toBeCloseTo(-1, 2);
  });

  it('wraps the input sequence at u16 without throwing', () => {
    const packet = encodeInputIntent({ seq: 65535, moveX: 0, moveZ: 0, yaw: 0, buttons: 0 });
    expect(decodeInputIntent(body(packet)).seq).toBe(65535);
  });

  it('round-trips Ping/Pong timestamps at full f64 precision', () => {
    const now = 1_754_100_123_456.789;
    const ping = decodePing(
      body(encodePing({ clientTimeMs: now, echoServerTimeMs: now - 50, echoAgeMs: 1980.5 })),
    );
    expect(ping.clientTimeMs).toBe(now);
    expect(ping.echoServerTimeMs).toBe(now - 50);
    expect(ping.echoAgeMs).toBe(1980.5);
    const pong = decodePong(body(encodePong({ clientTimeMs: now, serverTimeMs: now + 12.5 })));
    expect(pong.clientTimeMs).toBe(now);
    expect(pong.serverTimeMs).toBe(now + 12.5);
  });
});

describe('snapshots', () => {
  const makeSnapshot = (entityCount: number): SnapshotMessage => ({
    tick: 1234,
    lastInputSeq: 99,
    serverTimeMs: 1_754_100_000_000,
    self: {
      x: 12.5,
      y: 3.25,
      z: -40.75,
      vx: 1.5,
      vy: -2.25,
      vz: 0,
      yaw: 1.75,
      stamina: 87.5,
      flags: 0b1_0000_0101, // exercises the v6 u16 width (Leashing bit)
      hp: 217,
      maxHp: 236,
      resource: 63, // v7: class resource floor (Rage/Energy/Mana)
      comboPoints: 4, // v7: Rogue CP (0 for other classes)
      rollTimeLeftMs: 410, // v11: the roll, so reconciliation can continue it
      rollDirYaw: -2.1,
      rollCooldownMs: 355,
    },
    entities: Array.from({ length: entityCount }, (_, i) => ({
      id: i + 1,
      kind: i % 2,
      x: i * 2,
      y: 0,
      z: -i,
      yaw: (i % 6) * 1.04,
      flags: (i % 4) | (i % 3 === 0 ? 0b1_0000_0000 : 0),
      hpFraction: (i % 5) / 4,
    })),
  });

  it('round-trips self state exactly (prediction depends on it)', () => {
    const snapshot = makeSnapshot(0);
    const decoded = decodeSnapshot(body(encodeSnapshot(snapshot)));
    expect(decoded.tick).toBe(snapshot.tick);
    expect(decoded.lastInputSeq).toBe(snapshot.lastInputSeq);
    expect(decoded.serverTimeMs).toBe(snapshot.serverTimeMs);
    expect(decoded.self.x).toBe(snapshot.self.x);
    expect(decoded.self.y).toBe(snapshot.self.y);
    expect(decoded.self.z).toBe(snapshot.self.z);
    expect(decoded.self.vx).toBe(snapshot.self.vx);
    expect(decoded.self.stamina).toBe(snapshot.self.stamina);
    expect(decoded.self.flags).toBe(snapshot.self.flags);
    expect(decoded.self.hp).toBe(snapshot.self.hp);
    expect(decoded.self.maxHp).toBe(snapshot.self.maxHp);
    expect(decoded.self.resource).toBe(snapshot.self.resource);
    expect(decoded.self.comboPoints).toBe(snapshot.self.comboPoints);
    expect(decoded.self.yaw).toBeCloseTo(snapshot.self.yaw, 3);
    // v11 roll block: the client rebuilds its predicted roll from these, so a
    // dropped or mis-ordered field ends the roll a frame after it starts.
    expect(decoded.self.rollTimeLeftMs).toBe(snapshot.self.rollTimeLeftMs);
    expect(decoded.self.rollCooldownMs).toBe(snapshot.self.rollCooldownMs);
    // The yaw is quantized into [0, 2π), so a negative angle comes back turned
    // once around — same heading, different number. The client rebuilds the
    // roll's unit direction from it, so that is what has to survive.
    expect(Math.sin(decoded.self.rollDirYaw)).toBeCloseTo(Math.sin(snapshot.self.rollDirYaw), 3);
    expect(Math.cos(decoded.self.rollDirYaw)).toBeCloseTo(Math.cos(snapshot.self.rollDirYaw), 3);
  });

  it('round-trips a full lobby of entities', () => {
    const snapshot = makeSnapshot(20);
    const decoded = decodeSnapshot(body(encodeSnapshot(snapshot)));
    expect(decoded.entities).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      const source = snapshot.entities[i]!;
      const target = decoded.entities[i]!;
      expect(target.id).toBe(source.id);
      expect(target.kind).toBe(source.kind);
      expect(target.x).toBe(source.x);
      expect(target.z).toBe(source.z);
      expect(target.flags).toBe(source.flags);
      expect(target.yaw).toBeCloseTo(source.yaw, 3);
      expect(target.hpFraction).toBeCloseTo(source.hpFraction, 2);
    }
  });

  it('stays inside the per-client bandwidth budget at 20 players', () => {
    // docs/tech/TECH_STACK.md: ≤12 kB/s down per client at 20 Hz → ≤600 B/tick.
    const packet = encodeSnapshot(makeSnapshot(19));
    expect(packet.byteLength).toBeLessThanOrEqual(600);
  });

  it('reuses a writer without leaking bytes between messages', () => {
    const writer = new BinaryWriter(2048);
    const big = encodeSnapshot(makeSnapshot(20), writer).byteLength;
    const small = encodeSnapshot(makeSnapshot(1), writer).byteLength;
    expect(small).toBeLessThan(big);
    expect(decodeSnapshot(body(encodeSnapshot(makeSnapshot(1), writer))).entities).toHaveLength(1);
  });
});

describe('chat broadcast', () => {
  it('round-trips through the JSON envelope with the right opcode', () => {
    const message: ChatBroadcastMessage = {
      from: 'Pallux',
      fromId: 3,
      text: 'meet at the hill ⚔',
      system: false,
    };
    const packet = encodeChatBroadcast(message);
    expect(peekOpcode(packet)).toBe(ServerOp.ChatBroadcast);
    expect(decodeJsonEnvelope<ChatBroadcastMessage>(body(packet))).toEqual(message);
  });
});

describe('system notices', () => {
  it('round-trips a code with detail', () => {
    const packet = encodeSystemNotice({ code: NoticeCode.Kicked, detail: 'afk sweep' });
    expect(peekOpcode(packet)).toBe(ServerOp.SystemNotice);
    expect(decodeSystemNotice(body(packet))).toEqual({
      code: NoticeCode.Kicked,
      detail: 'afk sweep',
    });
  });

  it('omits empty detail so the client uses its own mapped text', () => {
    const decoded = decodeSystemNotice(body(encodeSystemNotice({ code: NoticeCode.ServerFull })));
    expect(decoded).toEqual({ code: NoticeCode.ServerFull });
  });
});

describe('combat messages (protocol v6)', () => {
  it('round-trips an AbilityRequest with quantized aim and target (v7)', () => {
    const packet = encodeAbilityRequest({
      seq: 77,
      action: 0,
      aimYaw: -2.4,
      aimPitch: 0.3,
      targetId: 4021,
      groundAim: null,
    });
    expect(peekOpcode(packet)).toBe(ClientOp.AbilityRequest);
    const decoded = decodeAbilityRequest(body(packet));
    expect(decoded.seq).toBe(77);
    expect(decoded.action).toBe(0);
    expect(Math.cos(decoded.aimYaw)).toBeCloseTo(Math.cos(-2.4), 3);
    expect(Math.sin(decoded.aimYaw)).toBeCloseTo(Math.sin(-2.4), 3);
    expect(decoded.aimPitch).toBeCloseTo(0.3, 1);
    expect(decoded.targetId).toBe(4021);
    expect(decoded.groundAim).toBeNull();
  });

  it('round-trips an AbilityRequest ground aim point (v8)', () => {
    const packet = encodeAbilityRequest({
      seq: 5,
      action: 9,
      aimYaw: 0.5,
      aimPitch: -0.4,
      targetId: 0,
      groundAim: { x: -123.25, z: 987.5 },
    });
    const decoded = decodeAbilityRequest(body(packet));
    expect(decoded.groundAim).not.toBeNull();
    expect(decoded.groundAim?.x).toBeCloseTo(-123.25, 2);
    expect(decoded.groundAim?.z).toBeCloseTo(987.5, 2);
  });

  it('round-trips AbilityStart', () => {
    const message = { entityId: 900, action: 0, step: 2, durationMs: 750, yaw: 1.1, cast: false };
    const decoded = decodeAbilityStart(body(encodeAbilityStart(message)));
    expect(decoded.entityId).toBe(900);
    expect(decoded.step).toBe(2);
    expect(decoded.durationMs).toBe(750);
    expect(decoded.yaw).toBeCloseTo(1.1, 3);
    expect(decoded.cast).toBe(false);
  });

  it('round-trips the AbilityStart cast flag (v12 enemy cast bars)', () => {
    const message = { entityId: 7, action: 1, step: 0, durationMs: 1600, yaw: -0.4, cast: true };
    const decoded = decodeAbilityStart(body(encodeAbilityStart(message)));
    expect(decoded.cast).toBe(true);
    expect(decoded.durationMs).toBe(1600);
  });

  it('round-trips AbilityResolve with mixed hit flags', () => {
    const message = {
      attackerId: 3,
      action: 0,
      step: 1,
      hits: [
        { targetId: 41, amount: 133, flags: HitFlag.Crit },
        { targetId: 42, amount: 20, flags: HitFlag.Killed | HitFlag.Staggered },
        { targetId: 43, amount: 1, flags: 0 },
      ],
    };
    expect(decodeAbilityResolve(body(encodeAbilityResolve(message)))).toEqual(message);
  });

  it('round-trips AbilityReject', () => {
    const message = { seq: 12, action: 0, reason: AbilityRejectReason.NoStamina };
    expect(decodeAbilityReject(body(encodeAbilityReject(message)))).toEqual(message);
  });

  it('round-trips EntityEvent params', () => {
    const message = { entityId: 55, event: EntityEventKind.Knockback, a: -3.5, b: 2.25, c: 240 };
    expect(decodeEntityEvent(body(encodeEntityEvent(message)))).toEqual(message);
  });

  it('round-trips a cone Telegraph', () => {
    // f32 payload — values chosen exactly representable in single precision.
    const message = {
      casterId: 12,
      shape: TelegraphShape.Cone,
      x: -150.5,
      z: 42.25,
      yaw: 0.8,
      size: 3.5,
      spread: 1.5,
      impactInMs: 800,
    };
    const decoded = decodeTelegraph(body(encodeTelegraph(message)));
    expect(decoded.casterId).toBe(12);
    expect(decoded.shape).toBe(TelegraphShape.Cone);
    expect(decoded.x).toBe(-150.5);
    expect(decoded.size).toBe(3.5);
    expect(decoded.spread).toBe(1.5);
    expect(decoded.impactInMs).toBe(800);
    expect(decoded.yaw).toBeCloseTo(0.8, 3);
  });

  it('round-trips projectile spawn and end', () => {
    // f32 payloads — exactly representable values keep toEqual honest.
    const spawn = {
      projectileId: 71,
      ownerId: 3,
      x: 1,
      y: 1.5,
      z: 2,
      dirX: 0.5,
      dirY: 0,
      dirZ: 0.75,
      speed: 28,
      visual: 2,
    };
    expect(decodeProjectileSpawn(body(encodeProjectileSpawn(spawn)))).toEqual(spawn);
    const end = { projectileId: 71, hit: true, x: 9, y: 1.25, z: 12 };
    expect(decodeProjectileEnd(body(encodeProjectileEnd(end)))).toEqual(end);
  });

  it('carries enemy metadata through the JSON envelope', () => {
    const message = {
      enemies: [
        {
          id: 501,
          typeId: 'enemy_shore_glub',
          name: 'Shore Glub',
          level: 2,
          rank: 'normal',
          modelRef: 'enemies_glub',
          scale: 1,
        },
      ],
    };
    const packet = encodeEnemyMeta(message);
    expect(peekOpcode(packet)).toBe(ServerOp.EnemyMeta);
    expect(decodeJsonEnvelope(body(packet))).toEqual(message);
  });
});

describe('ability messages (protocol v7)', () => {
  it('carries an entity effect list through EffectSync', () => {
    const message = {
      entityId: 17,
      effects: [
        { effectId: 'bleed_rending', stacks: 1, remainingMs: 7200, harmful: true },
        { effectId: 'buff_shield_wall', stacks: 1, remainingMs: 5400, harmful: false },
      ],
    };
    const packet = encodeEffectSync(message);
    expect(peekOpcode(packet)).toBe(ServerOp.EffectSync);
    expect(decodeJsonEnvelope(body(packet))).toEqual(message);
  });

  it('carries authoritative cooldowns/resource through AbilityState', () => {
    const message = {
      cooldowns: { ability_warrior_shield_bash: 4200, ability_warrior_charge: 900 },
      resource: 45,
      comboPoints: 0,
    };
    const packet = encodeAbilityState(message);
    expect(peekOpcode(packet)).toBe(ServerOp.AbilityState);
    expect(decodeJsonEnvelope(body(packet))).toEqual(message);
  });

  it('maps hotbar slots into the action byte and back', () => {
    for (let slot = 1; slot <= 8; slot++) {
      expect(slotForAction(actionForSlot(slot))).toBe(slot);
    }
    expect(slotForAction(ActionId.BasicAttack)).toBeNull();
    expect(slotForAction(ActionId.Respawn)).toBeNull();
    expect(slotForAction(actionForSlot(8) + 1)).toBeNull();
  });
});

describe('progression messages (protocol v9)', () => {
  it('round-trips stat allocation deltas, clamped to bytes', () => {
    const message = { str: 2, agi: 0, int: 1, vit: 3, end: 0 };
    expect(decodeAllocateStats(body(encodeAllocateStats(message)))).toEqual(message);
    const wild = decodeAllocateStats(
      body(encodeAllocateStats({ str: 999, agi: -4, int: 0.9, vit: 0, end: 255 })),
    );
    expect(wild).toEqual({ str: 255, agi: 0, int: 0, vit: 0, end: 255 });
  });

  it('round-trips skill allocation and respec requests', () => {
    const skill = { nodeId: 'node_warrior_bulwark_toughened' };
    const packet = encodeAllocateSkill(skill);
    expect(peekOpcode(packet)).toBe(ClientOp.AllocateSkill);
    expect(decodeAllocateSkill(body(packet))).toEqual(skill);
    expect(decodeRespec(body(encodeRespec({ kind: RespecWireKind.Skills })))).toEqual({
      kind: 1,
    });
    expect(decodeRespec(body(encodeRespec({ kind: RespecWireKind.Stats })))).toEqual({ kind: 2 });
  });

  it('round-trips XP gains with absolute bar position', () => {
    const gain = { amount: 46, source: XpSource.Kill, xp: 136, level: 3 };
    const packet = encodeXpGained(gain);
    expect(peekOpcode(packet)).toBe(ServerOp.XpGained);
    expect(decodeXpGained(body(packet))).toEqual(gain);
  });

  it('round-trips level-ups for any entity', () => {
    const up = { entityId: 91, level: 12 };
    const packet = encodeLevelUp(up);
    expect(peekOpcode(packet)).toBe(ServerOp.LevelUp);
    expect(decodeLevelUp(body(packet))).toEqual(up);
  });

  it('carries the full self progression sheet through ProgressSync', () => {
    const message = {
      level: 7,
      xp: 1234,
      xpToNext: 2760,
      gold: 145,
      unspentStatPoints: 3,
      unspentSkillPoints: 1,
      allocated: { str: 8, agi: 2, int: 0, vit: 6, end: 2 },
      nodes: { node_warrior_bulwark_toughened: 3, node_warrior_warlord_sharpened: 2 },
    };
    const packet = encodeProgressSync(message);
    expect(peekOpcode(packet)).toBe(ServerOp.ProgressSync);
    expect(decodeJsonEnvelope(body(packet))).toEqual(message);
  });
});

describe('items (v10)', () => {
  it('carries the whole self inventory through InventorySync', () => {
    const message = {
      bag: [
        [0, { itemId: 'item_weapon_sword_dawnsteel', qty: 1, rolled: { str: 4 } }],
        [3, { itemId: 'item_consumable_potion_minor', qty: 7, rolled: null }],
      ] as [number, { itemId: string; qty: number; rolled: Record<string, number> | null }][],
      equipment: {
        chest: { itemId: 'item_armor_chest_padded', qty: 1, rolled: { vit: 5 } },
      },
      gold: 412,
      cooldowns: { potion: 8200 },
      serverTimeMs: 123456,
    };
    const packet = encodeInventorySync(message);
    expect(peekOpcode(packet)).toBe(ServerOp.InventorySync);
    expect(decodeJsonEnvelope(body(packet))).toEqual(message);
  });

  it('carries per-player loot bags and vendor panels', () => {
    const bags = {
      bags: [
        {
          id: 4,
          x: 1.5,
          y: 4.2,
          z: 380.25,
          rarity: 'rare',
          items: [{ index: 0, itemId: 'item_junk_shell', qty: 2, rolled: null }],
          gold: 12,
          expiresAtMs: 60000,
        },
      ],
      serverTimeMs: 1000,
    };
    expect(peekOpcode(encodeLootBags(bags))).toBe(ServerOp.LootBags);
    expect(decodeJsonEnvelope(body(encodeLootBags(bags)))).toEqual(bags);

    const panel = {
      vendorId: 'vendor_general_dawnhaven',
      open: true,
      name: 'General Goods',
      kind: 'general',
      greeting: 'Dawn finds you well.',
      stock: [{ itemId: 'item_consumable_potion_minor', price: 12 }],
      buyback: [{ index: 0, itemId: 'item_junk_shell', qty: 3, price: 2 }],
      sellMult: 0.25,
    };
    expect(peekOpcode(encodeVendorPanel(panel))).toBe(ServerOp.VendorPanel);
    expect(decodeJsonEnvelope(body(encodeVendorPanel(panel)))).toEqual(panel);

    const notice = { kind: 'picked' as const, itemId: 'item_junk_shell', qty: 2 };
    expect(peekOpcode(encodeItemNotice(notice))).toBe(ServerOp.ItemNotice);
    expect(decodeJsonEnvelope(body(encodeItemNotice(notice)))).toEqual(notice);
  });

  it('gates client-authored item ops through zod (the envelope is untrusted)', () => {
    const move = { kind: 'move' as const, from: 0, to: 12 };
    const packet = encodeItemOp(move);
    expect(peekOpcode(packet)).toBe(ClientOp.ItemOp);
    expect(parseItemOp(decodeJsonEnvelope(body(packet)))).toEqual(move);

    // Out-of-grid slots, unknown kinds, bad refs and extra keys all refuse.
    expect(parseItemOp({ kind: 'move', from: 0, to: 48 })).toBeNull();
    expect(parseItemOp({ kind: 'move', from: -1, to: 3 })).toBeNull();
    expect(parseItemOp({ kind: 'teleport', from: 0 })).toBeNull();
    expect(parseItemOp({ kind: 'move', from: 0, to: 1, sneaky: true })).toBeNull();
    expect(
      parseItemOp({ kind: 'vendorBuy', vendorId: 'nope', itemId: 'item_x', qty: 1 }),
    ).toBeNull();
    expect(parseItemOp({ kind: 'split', from: 0, to: 1, qty: 0 })).toBeNull();
    expect(parseItemOp({ kind: 'equip', from: 2, prefer: 'backpack' })).toBeNull();
    expect(parseItemOp(null)).toBeNull();

    // Valid shapes across the union.
    expect(parseItemOp({ kind: 'loot', bagId: 7, index: null })).toEqual({
      kind: 'loot',
      bagId: 7,
      index: null,
    });
    expect(parseItemOp({ kind: 'equip', from: 2, prefer: 'ring2' })).toEqual({
      kind: 'equip',
      from: 2,
      prefer: 'ring2',
    });
    expect(parseItemOp({ kind: 'sort' })).toEqual({ kind: 'sort' });
  });
});

describe('gathering (v13, P10)', () => {
  it('gates client-authored gather ops through zod (the envelope is untrusted)', () => {
    const start = { kind: 'start' as const, placementId: 'node_2015_2152' };
    const packet = encodeGatherOp(start);
    expect(peekOpcode(packet)).toBe(ClientOp.GatherOp);
    expect(parseGatherOp(decodeJsonEnvelope(body(packet)))).toEqual(start);

    expect(parseGatherOp({ kind: 'cancel' })).toEqual({ kind: 'cancel' });

    // Unknown kinds, missing ids, extra keys and junk all refuse.
    expect(parseGatherOp({ kind: 'start' })).toBeNull();
    expect(parseGatherOp({ kind: 'start', placementId: '' })).toBeNull();
    expect(parseGatherOp({ kind: 'start', placementId: 'a'.repeat(81) })).toBeNull();
    expect(parseGatherOp({ kind: 'start', placementId: 'n', extra: 1 })).toBeNull();
    expect(parseGatherOp({ kind: 'chop', placementId: 'n' })).toBeNull();
    expect(parseGatherOp(null)).toBeNull();
    expect(parseGatherOp('start')).toBeNull();
  });

  it('sends only the DEPLETED nodes — standing is the default', () => {
    const message: NodeStatesMessage = {
      depleted: [{ id: 'node_2015_2152', readyAtMs: 1_700_000_120_000 }],
      serverTimeMs: 1_700_000_000_000,
    };
    const packet = encodeNodeStates(message);
    expect(peekOpcode(packet)).toBe(ServerOp.NodeStates);
    expect(decodeJsonEnvelope<NodeStatesMessage>(body(packet))).toEqual(message);
  });

  it('round-trips a finished gather with its yield, proc and XP', () => {
    const message: GatherStateMessage = {
      phase: 'done',
      placementId: 'node_2015_2152',
      nodeId: 'node_woodcutting_birch',
      profession: 'woodcutting',
      tier: 1,
      gained: [{ itemId: 'item_material_birchwood_logs', qty: 2 }],
      proc: { itemId: 'item_material_resin', qty: 1 },
      profXp: 12,
    };
    const packet = encodeGatherState(message);
    expect(peekOpcode(packet)).toBe(ServerOp.GatherState);
    expect(decodeJsonEnvelope<GatherStateMessage>(body(packet))).toEqual(message);
  });

  it('carries a refusal reason rather than a bare failure', () => {
    const message: GatherStateMessage = { phase: 'refused', reason: GatherRefusal.TierLocked };
    const decoded = decodeJsonEnvelope<GatherStateMessage>(body(encodeGatherState(message)));
    expect(decoded.reason).toBe('tier_locked');
    expect(gatherRefusalText(decoded.reason ?? '')).toContain('profession level');
  });

  it('round-trips all four professions and the codex', () => {
    const message: ProfessionSyncMessage = {
      professions: PROFESSIONS.map((profession, index) => ({
        profession,
        level: index + 1,
        xp: 10 * index,
        xpToNext: 60,
        tier: 1,
      })),
      codex: { woodcutting: ['item_material_birchwood_logs'], mining: [] },
    };
    const packet = encodeProfessionSync(message);
    expect(peekOpcode(packet)).toBe(ServerOp.ProfessionSync);
    expect(decodeJsonEnvelope<ProfessionSyncMessage>(body(packet))).toEqual(message);
  });
});
