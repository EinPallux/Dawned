/**
 * Message encoders/decoders (docs/tech/NETWORKING.md §2).
 *
 * Hot path (snapshots, input intents) is packed binary; cold path (handshake,
 * roster, chat) rides JSON envelopes because clarity beats bytes there.
 *
 * Every encoder accepts an optional writer so callers can reuse one buffer per
 * client and keep the tick loop allocation-free.
 */

import {
  BinaryReader,
  BinaryWriter,
  ProtocolError,
  dequantizeAngle,
  quantizeAngle,
} from './codec.js';
import { ClientOp, ServerOp, type NoticeCode } from './opcodes.js';
import type { Appearance, ClassId } from '../data/appearance.js';

const encodeJsonEnvelope = (
  opcode: number,
  payload: unknown,
  writer?: BinaryWriter,
): Uint8Array => {
  const w = (writer ?? new BinaryWriter()).reset();
  w.u8(opcode).string(JSON.stringify(payload));
  return w.toUint8Array();
};

/** Read the leading opcode without consuming the rest of the packet. */
export const peekOpcode = (data: Uint8Array): number => {
  if (data.byteLength < 1) throw new ProtocolError('empty packet');
  return data[0]!;
};

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface HelloMessage {
  protocolVersion: number;
  /** Opaque session token from POST /api/auth/login (32 hex chars). */
  token: string;
  /** The character to enter the world as (must belong to the token's account). */
  characterId: number;
}

export const encodeHello = (msg: HelloMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(64)).reset();
  w.u8(ClientOp.Hello).u16(msg.protocolVersion).string(msg.token).u32(msg.characterId);
  return w.toUint8Array();
};

export const decodeHello = (reader: BinaryReader): HelloMessage => ({
  protocolVersion: reader.u16(),
  token: reader.string(),
  characterId: reader.u32(),
});

export interface InputIntentMessage {
  /** Monotonic per-client sequence number, wraps at u16. */
  seq: number;
  /**
   * Movement axes in WORLD space, −1..1. The client converts camera-relative
   * input by its yaw before sending — the server never sees camera space and
   * simply integrates the direction at the authoritative speed.
   */
  moveX: number;
  moveZ: number;
  /** Facing in radians. */
  yaw: number;
  /** Bitfield of {@link InputButton}. */
  buttons: number;
}

export const encodeInputIntent = (msg: InputIntentMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(16)).reset();
  w.u8(ClientOp.InputIntent)
    .u16(msg.seq)
    .i8(Math.round(Math.max(-1, Math.min(1, msg.moveX)) * 127))
    .i8(Math.round(Math.max(-1, Math.min(1, msg.moveZ)) * 127))
    .u16(quantizeAngle(msg.yaw))
    .u8(msg.buttons);
  return w.toUint8Array();
};

export const decodeInputIntent = (reader: BinaryReader): InputIntentMessage => {
  const seq = reader.u16();
  const moveX = reader.i8() / 127;
  const moveZ = reader.i8() / 127;
  const yaw = dequantizeAngle(reader.u16());
  const buttons = reader.u8();
  return { seq, moveX, moveZ, yaw, buttons };
};

export interface AbilityRequestMessage {
  /** Client-side request counter (echoed in rejects; wraps at u16). */
  seq: number;
  /** {@link ActionId} 0/1, or a hotbar slot via SLOT_ACTION_BASE (v7). */
  action: number;
  /** Aim at press time. Yaw in radians; pitch in radians (−π/2..π/2). */
  aimYaw: number;
  aimPitch: number;
  /** Soft-target entity at press (0 = none) — Death Mark, Shadowstep (v7). */
  targetId: number;
  /**
   * Ground-aim world point for ground_aoe abilities (v8): the crosshair's
   * terrain hit, range-clamped client-side, re-validated server-side against
   * the def's maxRange. null for every other targeting kind.
   */
  groundAim: { x: number; z: number } | null;
}

export const encodeAbilityRequest = (
  msg: AbilityRequestMessage,
  writer?: BinaryWriter,
): Uint8Array => {
  const w = (writer ?? new BinaryWriter(24)).reset();
  w.u8(ClientOp.AbilityRequest)
    .u16(msg.seq)
    .u8(msg.action)
    .u16(quantizeAngle(msg.aimYaw))
    .i8(Math.round((Math.max(-1.55, Math.min(1.55, msg.aimPitch)) / (Math.PI / 2)) * 127))
    .u32(msg.targetId);
  // Ground aim (v8): flag byte + world x/z as f32 (how positions travel).
  if (msg.groundAim) {
    w.u8(1).f32(msg.groundAim.x).f32(msg.groundAim.z);
  } else {
    w.u8(0);
  }
  return w.toUint8Array();
};

export const decodeAbilityRequest = (reader: BinaryReader): AbilityRequestMessage => {
  const base = {
    seq: reader.u16(),
    action: reader.u8(),
    aimYaw: dequantizeAngle(reader.u16()),
    aimPitch: (reader.i8() / 127) * (Math.PI / 2),
    targetId: reader.u32(),
  };
  const hasGroundAim = reader.u8() === 1;
  return {
    ...base,
    groundAim: hasGroundAim ? { x: reader.f32(), z: reader.f32() } : null,
  };
};

export interface PingMessage {
  clientTimeMs: number;
  /**
   * RTT echo (v6): the serverTimeMs of the last pong received, plus how long
   * ago it arrived. The server derives rtt ≈ now − (echo + age) — its own
   * measurement for the lag-compensation rewind window, never client-claimed
   * latency (a liar can only inflate within the 250 ms clamp). 0/0 = no pong yet.
   */
  echoServerTimeMs: number;
  echoAgeMs: number;
}

export const encodePing = (msg: PingMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(24)).reset();
  w.u8(ClientOp.Ping).f64(msg.clientTimeMs).f64(msg.echoServerTimeMs).f64(msg.echoAgeMs);
  return w.toUint8Array();
};

export const decodePing = (reader: BinaryReader): PingMessage => ({
  clientTimeMs: reader.f64(),
  echoServerTimeMs: reader.f64(),
  echoAgeMs: reader.f64(),
});

export interface ChatMessage {
  text: string;
}

export const encodeChat = (msg: ChatMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ClientOp.Chat, msg, writer);

/**
 * Spend banked attribute points (v9): the Character panel stages +/− locally,
 * Confirm sends the summed deltas in one message. Server validates the sum
 * against `unspentStatPoints` and answers with a ProgressSync either way.
 */
export interface AllocateStatsMessage {
  str: number;
  agi: number;
  int: number;
  vit: number;
  end: number;
}

export const encodeAllocateStats = (
  msg: AllocateStatsMessage,
  writer?: BinaryWriter,
): Uint8Array => {
  const w = (writer ?? new BinaryWriter(8)).reset();
  const clamp = (n: number): number => Math.max(0, Math.min(255, Math.floor(n)));
  w.u8(ClientOp.AllocateStats)
    .u8(clamp(msg.str))
    .u8(clamp(msg.agi))
    .u8(clamp(msg.int))
    .u8(clamp(msg.vit))
    .u8(clamp(msg.end));
  return w.toUint8Array();
};

export const decodeAllocateStats = (reader: BinaryReader): AllocateStatsMessage => ({
  str: reader.u8(),
  agi: reader.u8(),
  int: reader.u8(),
  vit: reader.u8(),
  end: reader.u8(),
});

/** Put one rank into a skill-tree node (v9). Server re-runs the shared gate. */
export interface AllocateSkillMessage {
  nodeId: string;
}

export const encodeAllocateSkill = (
  msg: AllocateSkillMessage,
  writer?: BinaryWriter,
): Uint8Array => {
  const w = (writer ?? new BinaryWriter(72)).reset();
  w.u8(ClientOp.AllocateSkill).string(msg.nodeId);
  return w.toUint8Array();
};

export const decodeAllocateSkill = (reader: BinaryReader): AllocateSkillMessage => ({
  nodeId: reader.string(),
});

/** Mirror of Dawn respec request (v9). `kind` is {@link RespecWireKind}. */
export interface RespecMessage {
  kind: number;
}

export const encodeRespec = (msg: RespecMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(4)).reset();
  w.u8(ClientOp.Respec).u8(msg.kind);
  return w.toUint8Array();
};

export const decodeRespec = (reader: BinaryReader): RespecMessage => ({
  kind: reader.u8(),
});

/**
 * Every inventory/loot/vendor intent (v10) in one envelope. Client-authored,
 * so the SERVER parses it with `itemOpSchema` (content/item-ops.ts) before
 * touching state — the envelope decoder deliberately hands back `unknown`.
 */
export const encodeItemOp = (op: unknown, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ClientOp.ItemOp, op, writer);

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface RosterEntry {
  id: number;
  name: string;
  classId: ClassId;
  level: number;
  appearance: Appearance;
}

export interface WelcomeMessage {
  protocolVersion: number;
  selfId: number;
  characterId: number;
  tickRate: number;
  serverTimeMs: number;
  spawn: { x: number; y: number; z: number; yaw: number };
  players: RosterEntry[];
}

export const encodeWelcome = (msg: WelcomeMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.Welcome, msg, writer);

export interface RosterMessage {
  players: RosterEntry[];
}

export const encodeRoster = (msg: RosterMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.Roster, msg, writer);

export interface ChatBroadcastMessage {
  from: string;
  fromId: number;
  text: string;
  system: boolean;
}

export const encodeChatBroadcast = (msg: ChatBroadcastMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.ChatBroadcast, msg, writer);

/** Entity taxonomy on the wire — the P4/P9 seam (enemies, projectiles, props). */
export const EntityKind = {
  Player: 0,
  Enemy: 1,
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

export interface SnapshotEntity {
  id: number;
  /** {@link EntityKind} discriminator. */
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Bitfield of {@link EntityFlag} (u16 since v6). */
  flags: number;
  /** Current HP as a fraction 0..1, quantized to u8 (nameplate bars). */
  hpFraction: number;
}

export interface SnapshotSelf {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  stamina: number;
  /** Bitfield of {@link EntityFlag} (u16 since v6). */
  flags: number;
  /** Authoritative health (v6). Integers per project rules. */
  hp: number;
  maxHp: number;
  /** Class resource — Rage/Energy/Mana, floored to whole units (v7). */
  resource: number;
  /** Rogue combo points 0..5; always 0 for other classes (v7). */
  comboPoints: number;
}

export interface SnapshotMessage {
  tick: number;
  /** Highest input sequence the server has consumed from this client. */
  lastInputSeq: number;
  serverTimeMs: number;
  self: SnapshotSelf;
  entities: SnapshotEntity[];
}

export const encodeSnapshot = (msg: SnapshotMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(1024)).reset();
  w.u8(ServerOp.Snapshot).u16(msg.tick).u16(msg.lastInputSeq).f64(msg.serverTimeMs);

  const self = msg.self;
  w.f32(self.x)
    .f32(self.y)
    .f32(self.z)
    .f32(self.vx)
    .f32(self.vy)
    .f32(self.vz)
    .u16(quantizeAngle(self.yaw))
    .f32(self.stamina)
    .u16(self.flags)
    .u32(self.hp)
    .u32(self.maxHp)
    .u16(self.resource)
    .u8(self.comboPoints);

  w.u16(msg.entities.length);
  for (const entity of msg.entities) {
    w.u32(entity.id)
      .u8(entity.kind)
      .f32(entity.x)
      .f32(entity.y)
      .f32(entity.z)
      .u16(quantizeAngle(entity.yaw))
      .u16(entity.flags)
      .u8(Math.round(Math.max(0, Math.min(1, entity.hpFraction)) * 255));
  }
  return w.toUint8Array();
};

export const decodeSnapshot = (reader: BinaryReader): SnapshotMessage => {
  const tick = reader.u16();
  const lastInputSeq = reader.u16();
  const serverTimeMs = reader.f64();

  const self: SnapshotSelf = {
    x: reader.f32(),
    y: reader.f32(),
    z: reader.f32(),
    vx: reader.f32(),
    vy: reader.f32(),
    vz: reader.f32(),
    yaw: dequantizeAngle(reader.u16()),
    stamina: reader.f32(),
    flags: reader.u16(),
    hp: reader.u32(),
    maxHp: reader.u32(),
    resource: reader.u16(),
    comboPoints: reader.u8(),
  };

  const count = reader.u16();
  const entities: SnapshotEntity[] = new Array<SnapshotEntity>(count);
  for (let i = 0; i < count; i++) {
    entities[i] = {
      id: reader.u32(),
      kind: reader.u8(),
      x: reader.f32(),
      y: reader.f32(),
      z: reader.f32(),
      yaw: dequantizeAngle(reader.u16()),
      flags: reader.u16(),
      hpFraction: reader.u8() / 255,
    };
  }
  return { tick, lastInputSeq, serverTimeMs, self, entities };
};

export interface PongMessage {
  clientTimeMs: number;
  serverTimeMs: number;
}

export const encodePong = (msg: PongMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(24)).reset();
  w.u8(ServerOp.Pong).f64(msg.clientTimeMs).f64(msg.serverTimeMs);
  return w.toUint8Array();
};

export const decodePong = (reader: BinaryReader): PongMessage => ({
  clientTimeMs: reader.f64(),
  serverTimeMs: reader.f64(),
});

// ---------------------------------------------------------------------------
// Combat (protocol v6, docs/tech/NETWORKING.md §4)
// ---------------------------------------------------------------------------

export interface AbilityStartMessage {
  /** Acting entity (player or enemy). */
  entityId: number;
  /** {@link ActionId} for players; enemy ability ordinal for enemies. */
  action: number;
  /** Combo step 0–2 for basics; 0 otherwise. */
  step: number;
  /** Wind-up/step duration in ms — remotes scale their anim to this. */
  durationMs: number;
  yaw: number;
}

export const encodeAbilityStart = (msg: AbilityStartMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(16)).reset();
  w.u8(ServerOp.AbilityStart)
    .u32(msg.entityId)
    .u8(msg.action)
    .u8(msg.step)
    .u16(msg.durationMs)
    .u16(quantizeAngle(msg.yaw));
  return w.toUint8Array();
};

export const decodeAbilityStart = (reader: BinaryReader): AbilityStartMessage => ({
  entityId: reader.u32(),
  action: reader.u8(),
  step: reader.u8(),
  durationMs: reader.u16(),
  yaw: dequantizeAngle(reader.u16()),
});

/** Per-target outcome flags inside an {@link AbilityResolveMessage}. */
export const HitFlag = {
  Crit: 1 << 0,
  Killed: 1 << 1,
  Staggered: 1 << 2,
  /** `amount` healed instead of damaged (v8) — FCT renders the heal style. */
  Healed: 1 << 3,
  /** `amount` was absorbed by a shield (v8) — FCT shows the absorb read. */
  Absorbed: 1 << 4,
} as const;
export type HitFlag = (typeof HitFlag)[keyof typeof HitFlag];

export interface ResolveHit {
  targetId: number;
  amount: number;
  /** Bitfield of {@link HitFlag}. */
  flags: number;
}

export interface AbilityResolveMessage {
  attackerId: number;
  action: number;
  step: number;
  hits: ResolveHit[];
}

export const encodeAbilityResolve = (
  msg: AbilityResolveMessage,
  writer?: BinaryWriter,
): Uint8Array => {
  const w = (writer ?? new BinaryWriter(64)).reset();
  w.u8(ServerOp.AbilityResolve).u32(msg.attackerId).u8(msg.action).u8(msg.step);
  w.u8(msg.hits.length);
  for (const hit of msg.hits) {
    w.u32(hit.targetId).u32(hit.amount).u8(hit.flags);
  }
  return w.toUint8Array();
};

export const decodeAbilityResolve = (reader: BinaryReader): AbilityResolveMessage => {
  const attackerId = reader.u32();
  const action = reader.u8();
  const step = reader.u8();
  const count = reader.u8();
  const hits: ResolveHit[] = new Array<ResolveHit>(count);
  for (let i = 0; i < count; i++) {
    hits[i] = { targetId: reader.u32(), amount: reader.u32(), flags: reader.u8() };
  }
  return { attackerId, action, step, hits };
};

export interface AbilityRejectMessage {
  /** Echo of the request's seq so the client rolls back the right prediction. */
  seq: number;
  action: number;
  /** {@link AbilityRejectReason}. */
  reason: number;
}

export const encodeAbilityReject = (
  msg: AbilityRejectMessage,
  writer?: BinaryWriter,
): Uint8Array => {
  const w = (writer ?? new BinaryWriter(8)).reset();
  w.u8(ServerOp.AbilityReject).u16(msg.seq).u8(msg.action).u8(msg.reason);
  return w.toUint8Array();
};

export const decodeAbilityReject = (reader: BinaryReader): AbilityRejectMessage => ({
  seq: reader.u16(),
  action: reader.u8(),
  reason: reader.u8(),
});

export interface EntityEventMessage {
  entityId: number;
  /** {@link EntityEventKind}. */
  event: number;
  /** Kind-specific params (see EntityEventKind docs). Unused = 0. */
  a: number;
  b: number;
  c: number;
}

export const encodeEntityEvent = (msg: EntityEventMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(20)).reset();
  w.u8(ServerOp.EntityEvent).u32(msg.entityId).u8(msg.event).f32(msg.a).f32(msg.b).f32(msg.c);
  return w.toUint8Array();
};

export const decodeEntityEvent = (reader: BinaryReader): EntityEventMessage => ({
  entityId: reader.u32(),
  event: reader.u8(),
  a: reader.f32(),
  b: reader.f32(),
  c: reader.f32(),
});

export interface TelegraphMessage {
  casterId: number;
  /** {@link TelegraphShape}. */
  shape: number;
  x: number;
  z: number;
  yaw: number;
  /** Circle: radius. Cone: reach. Rect: length. */
  size: number;
  /** Cone: full angle in radians. Rect: width. Circle: unused. */
  spread: number;
  /** Time until impact from send, ms — the decal's fill duration. */
  impactInMs: number;
}

export const encodeTelegraph = (msg: TelegraphMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(32)).reset();
  w.u8(ServerOp.Telegraph)
    .u32(msg.casterId)
    .u8(msg.shape)
    .f32(msg.x)
    .f32(msg.z)
    .u16(quantizeAngle(msg.yaw))
    .f32(msg.size)
    .f32(msg.spread)
    .u16(msg.impactInMs);
  return w.toUint8Array();
};

export const decodeTelegraph = (reader: BinaryReader): TelegraphMessage => ({
  casterId: reader.u32(),
  shape: reader.u8(),
  x: reader.f32(),
  z: reader.f32(),
  yaw: dequantizeAngle(reader.u16()),
  size: reader.f32(),
  spread: reader.f32(),
  impactInMs: reader.u16(),
});

export interface ProjectileSpawnMessage {
  projectileId: number;
  ownerId: number;
  x: number;
  y: number;
  z: number;
  /** Unit direction; the client integrates the straight flight locally. */
  dirX: number;
  dirY: number;
  dirZ: number;
  speed: number;
  /** Visual style index (class bolt tints, enemy variants). */
  visual: number;
}

export const encodeProjectileSpawn = (
  msg: ProjectileSpawnMessage,
  writer?: BinaryWriter,
): Uint8Array => {
  const w = (writer ?? new BinaryWriter(40)).reset();
  w.u8(ServerOp.ProjectileSpawn)
    .u32(msg.projectileId)
    .u32(msg.ownerId)
    .f32(msg.x)
    .f32(msg.y)
    .f32(msg.z)
    .f32(msg.dirX)
    .f32(msg.dirY)
    .f32(msg.dirZ)
    .f32(msg.speed)
    .u8(msg.visual);
  return w.toUint8Array();
};

export const decodeProjectileSpawn = (reader: BinaryReader): ProjectileSpawnMessage => ({
  projectileId: reader.u32(),
  ownerId: reader.u32(),
  x: reader.f32(),
  y: reader.f32(),
  z: reader.f32(),
  dirX: reader.f32(),
  dirY: reader.f32(),
  dirZ: reader.f32(),
  speed: reader.f32(),
  visual: reader.u8(),
});

export interface ProjectileEndMessage {
  projectileId: number;
  /** True when it struck something (impact FX); false = expired/blocked fade. */
  hit: boolean;
  x: number;
  y: number;
  z: number;
}

export const encodeProjectileEnd = (
  msg: ProjectileEndMessage,
  writer?: BinaryWriter,
): Uint8Array => {
  const w = (writer ?? new BinaryWriter(24)).reset();
  w.u8(ServerOp.ProjectileEnd)
    .u32(msg.projectileId)
    .u8(msg.hit ? 1 : 0)
    .f32(msg.x)
    .f32(msg.y)
    .f32(msg.z);
  return w.toUint8Array();
};

export const decodeProjectileEnd = (reader: BinaryReader): ProjectileEndMessage => ({
  projectileId: reader.u32(),
  hit: reader.u8() !== 0,
  x: reader.f32(),
  y: reader.f32(),
  z: reader.f32(),
});

/**
 * Immutable description of an enemy entity, sent once when it first enters a
 * client's interest set (the snapshot then carries only dynamic state). JSON
 * envelope — cold path, small volume.
 */
export interface EnemyMetaEntry {
  id: number;
  /** Content slug (`enemy_shore_glub`). */
  typeId: string;
  name: string;
  level: number;
  rank: string;
  /** Baked model manifest id + display scale. */
  modelRef: string;
  scale: number;
}

export interface EnemyMetaMessage {
  enemies: EnemyMetaEntry[];
}

export const encodeEnemyMeta = (msg: EnemyMetaMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.EnemyMeta, msg, writer);

/**
 * One live buff/debuff on an entity, as the buff bar renders it. `effectId`
 * is the content-declared id (`bleed_rending`), `icon` derives client-side.
 */
export interface EffectSyncEntry {
  effectId: string;
  stacks: number;
  /** Remaining ms at send time (client counts down locally). */
  remainingMs: number;
  /** True for hostile effects (red seam on the bar; debuff row). */
  harmful: boolean;
  /** Absorb pool left on shield effects (v8) — the chip shows the number. */
  shieldRemaining?: number;
}

/**
 * Authoritative effect list for ONE entity — sent on any change, replacing
 * the client's list for that entity wholesale (tiny lists, no diff protocol
 * needed at our scale). JSON envelope (cold-ish path, v7).
 */
export interface EffectSyncMessage {
  entityId: number;
  effects: EffectSyncEntry[];
}

export const encodeEffectSync = (msg: EffectSyncMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.EffectSync, msg, writer);

/**
 * Authoritative ability bookkeeping for SELF: sent on join/resume and after
 * any reject that implies the client predicted wrong (cooldown/resource
 * drift). The client adopts it wholesale. JSON envelope (rare, v7).
 */
export interface AbilityStateMessage {
  /** abilityId → remaining cooldown ms. Absent = ready. */
  cooldowns: Record<string, number>;
  /** Authoritative resource floor + combo points (usually redundant with the
   * snapshot; included so one message fully restores prediction state). */
  resource: number;
  comboPoints: number;
}

export const encodeAbilityState = (msg: AbilityStateMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.AbilityState, msg, writer);

/**
 * Authoritative progression state for SELF (v9) — sent on join and after any
 * change (XP threshold crossings send XpGained/LevelUp instead; this carries
 * the durable sheet). The client adopts it wholesale: it is both the initial
 * state and the correction that heals any mispredicted allocation click.
 */
export interface ProgressSyncMessage {
  level: number;
  /** XP into the current level. */
  xp: number;
  /** XP needed to leave it (0 at the cap) — the curve stays server-side. */
  xpToNext: number;
  gold: number;
  unspentStatPoints: number;
  unspentSkillPoints: number;
  /** Allocated (spent) attribute points on top of the class base spread. */
  allocated: { str: number; agi: number; int: number; vit: number; end: number };
  /** Allocated skill-tree ranks by node id. */
  nodes: Record<string, number>;
}

export const encodeProgressSync = (msg: ProgressSyncMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.ProgressSync, msg, writer);

/** An XP award (v9): FCT "+N XP" + bar tick. Carries the absolute position
 * after the award so a dropped packet can never desync the bar. */
export interface XpGainedMessage {
  amount: number;
  /** {@link XpSource}. */
  source: number;
  /** Absolute XP into the current level, after this award. */
  xp: number;
  level: number;
}

export const encodeXpGained = (msg: XpGainedMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(16)).reset();
  w.u8(ServerOp.XpGained).u32(msg.amount).u8(msg.source).u32(msg.xp).u8(msg.level);
  return w.toUint8Array();
};

export const decodeXpGained = (reader: BinaryReader): XpGainedMessage => ({
  amount: reader.u32(),
  source: reader.u8(),
  xp: reader.u32(),
  level: reader.u8(),
});

/** An entity leveled up (v9): self plays the §1.3 juice contract, remotes get
 * the gold pillar + nameplate refresh. */
export interface LevelUpMessage {
  entityId: number;
  level: number;
}

export const encodeLevelUp = (msg: LevelUpMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(8)).reset();
  w.u8(ServerOp.LevelUp).u32(msg.entityId).u8(msg.level);
  return w.toUint8Array();
};

export const decodeLevelUp = (reader: BinaryReader): LevelUpMessage => ({
  entityId: reader.u32(),
  level: reader.u8(),
});

// ---------------------------------------------------------------------------
// Items (v10) — ITEMS_LOOT.md. All JSON envelopes: these are UI-cadence
// messages, and their shapes are heterogeneous by nature.
// ---------------------------------------------------------------------------

/** One owned stack on the wire (bag cell or paper-doll slot). */
export interface WireStack {
  id: number;
  itemId: string;
  qty: number;
  /** Rolled attributes for gear; absent for stackables. */
  rolled?: Record<string, number> | null;
}

/**
 * Authoritative bag + paper-doll + purse for SELF (v10) — sent on join and
 * after any change. The client adopts it wholesale: it is both the initial
 * state and the correction that heals a mispredicted drag.
 */
export interface InventorySyncMessage {
  /** Bag cells as [slotIndex, stack] pairs (sparse — 48-slot grid). */
  bag: [number, WireStack][];
  /** Equipment by slot name (EquipSlot). */
  equipment: Record<string, WireStack>;
  gold: number;
  /** performance-independent server timestamps for consumable lanes. */
  cooldowns: Record<string, number>;
  /** Server time when the payload was built (cooldowns are relative to it). */
  serverTimeMs: number;
}

export const encodeInventorySync = (msg: InventorySyncMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.InventorySync, msg, writer);

/** A loot bag as THIS player sees it — contents are per-player instanced. */
export interface WireLootBag {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Best rarity inside — colors the beam (ITEMS_LOOT.md §3). */
  rarity: string;
  items: { index: number; itemId: string; qty: number; rolled?: Record<string, number> | null }[];
  gold: number;
  /** Server time the bag despawns (60 s lifetime). */
  expiresAtMs: number;
}

export interface LootBagsMessage {
  bags: WireLootBag[];
  serverTimeMs: number;
}

export const encodeLootBags = (msg: LootBagsMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.LootBags, msg, writer);

/** An opened vendor: priced stock + this session's buyback shelf (§6). */
export interface VendorPanelMessage {
  vendorId: string;
  name: string;
  kind: string;
  greeting: string;
  /** Buy list with the price the server WILL charge. */
  stock: { itemId: string; price: number }[];
  /** Last sold stacks, newest first, at the price paid. */
  buyback: { index: number; itemId: string; qty: number; price: number }[];
  /** Multiplier applied to item value when this vendor buys from the player. */
  sellMult: number;
}

export const encodeVendorPanel = (msg: VendorPanelMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.VendorPanel, msg, writer);

/** Bag traffic worth a toast (§3 loot juice, refusals in words). */
export interface ItemNoticeMessage {
  kind: 'picked' | 'gold' | 'sold' | 'bought' | 'full' | 'refused' | 'used' | 'equipped';
  itemId?: string;
  qty?: number;
  gold?: number;
  /** Refusal reason code (InventoryRefusal) for the words the HUD shows. */
  reason?: string;
}

export const encodeItemNotice = (msg: ItemNoticeMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ServerOp.ItemNotice, msg, writer);

export interface SystemNoticeMessage {
  code: NoticeCode;
  /** Optional server-supplied detail; the client prefers its own mapped text. */
  detail?: string;
}

export const encodeSystemNotice = (msg: SystemNoticeMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(64)).reset();
  w.u8(ServerOp.SystemNotice)
    .u16(msg.code)
    .string(msg.detail ?? '');
  return w.toUint8Array();
};

export const decodeSystemNotice = (reader: BinaryReader): SystemNoticeMessage => {
  const code = reader.u16() as NoticeCode;
  const detail = reader.string();
  return detail ? { code, detail } : { code };
};

/**
 * Decode a JSON envelope body (opcode already consumed).
 *
 * The type parameter is a caller-side assertion, not a validated parse — cold-path
 * messages are trusted only because they come from our own server. If a JSON
 * envelope ever carries client-authored data, validate it with zod at the call site.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- deliberate call-site typing sugar
export const decodeJsonEnvelope = <T>(reader: BinaryReader): T => {
  const raw = reader.string();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ProtocolError('malformed JSON envelope');
  }
};
