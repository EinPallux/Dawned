import { describe, expect, it } from 'vitest';
import { BinaryReader, BinaryWriter } from './codec.js';
import {
  decodeHello,
  decodeInputIntent,
  decodeJsonEnvelope,
  decodePing,
  decodePong,
  decodeSnapshot,
  decodeSystemNotice,
  encodeChatBroadcast,
  encodeHello,
  encodeInputIntent,
  encodePing,
  encodePong,
  encodeSnapshot,
  encodeSystemNotice,
  peekOpcode,
  type ChatBroadcastMessage,
  type SnapshotMessage,
} from './messages.js';
import { ClientOp, InputButton, NoticeCode, PROTOCOL_VERSION, ServerOp } from './opcodes.js';

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
    expect(decodePing(body(encodePing({ clientTimeMs: now }))).clientTimeMs).toBe(now);
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
      flags: 0b101,
    },
    entities: Array.from({ length: entityCount }, (_, i) => ({
      id: i + 1,
      x: i * 2,
      y: 0,
      z: -i,
      yaw: (i % 6) * 1.04,
      flags: i % 4,
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
    expect(decoded.self.yaw).toBeCloseTo(snapshot.self.yaw, 3);
  });

  it('round-trips a full lobby of entities', () => {
    const snapshot = makeSnapshot(20);
    const decoded = decodeSnapshot(body(encodeSnapshot(snapshot)));
    expect(decoded.entities).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      const source = snapshot.entities[i]!;
      const target = decoded.entities[i]!;
      expect(target.id).toBe(source.id);
      expect(target.x).toBe(source.x);
      expect(target.z).toBe(source.z);
      expect(target.flags).toBe(source.flags);
      expect(target.yaw).toBeCloseTo(source.yaw, 3);
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
