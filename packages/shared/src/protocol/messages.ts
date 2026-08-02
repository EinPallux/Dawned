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

export interface PingMessage {
  clientTimeMs: number;
}

export const encodePing = (msg: PingMessage, writer?: BinaryWriter): Uint8Array => {
  const w = (writer ?? new BinaryWriter(16)).reset();
  w.u8(ClientOp.Ping).f64(msg.clientTimeMs);
  return w.toUint8Array();
};

export const decodePing = (reader: BinaryReader): PingMessage => ({ clientTimeMs: reader.f64() });

export interface ChatMessage {
  text: string;
}

export const encodeChat = (msg: ChatMessage, writer?: BinaryWriter): Uint8Array =>
  encodeJsonEnvelope(ClientOp.Chat, msg, writer);

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

export interface SnapshotEntity {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Bitfield of {@link EntityFlag}. */
  flags: number;
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
  flags: number;
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
    .u8(self.flags);

  w.u16(msg.entities.length);
  for (const entity of msg.entities) {
    w.u32(entity.id)
      .f32(entity.x)
      .f32(entity.y)
      .f32(entity.z)
      .u16(quantizeAngle(entity.yaw))
      .u8(entity.flags);
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
    flags: reader.u8(),
  };

  const count = reader.u16();
  const entities: SnapshotEntity[] = new Array<SnapshotEntity>(count);
  for (let i = 0; i < count; i++) {
    entities[i] = {
      id: reader.u32(),
      x: reader.f32(),
      y: reader.f32(),
      z: reader.f32(),
      yaw: dequantizeAngle(reader.u16()),
      flags: reader.u8(),
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
