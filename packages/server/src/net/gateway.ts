/**
 * WebSocket gateway: handshake, packet routing, snapshot fan-out.
 *
 * Every inbound packet is treated as hostile until validated — malformed input
 * closes the socket, it never throws into the tick loop (docs/tech/SECURITY.md §2).
 */

import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BinaryReader,
  ClientOp,
  NoticeCode,
  PROTOCOL_VERSION,
  ProtocolError,
  TICK_RATE,
  decodeHello,
  decodeInputIntent,
  decodeJsonEnvelope,
  decodePing,
  encodeChatBroadcast,
  encodePong,
  encodeRoster,
  encodeSnapshot,
  encodeSystemNotice,
  encodeWelcome,
  peekOpcode,
  type ChatMessage,
  type SnapshotEntity,
} from '@dawned/shared';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { MetricsRing } from '../metrics/ring.js';
import type { World } from '../world/world.js';
import { Session } from './session.js';

const NAME_PATTERN = /^[A-Za-z0-9_]{2,16}$/;
const RESERVED_NAMES = new Set(['admin', 'gm', 'system', 'server', 'dawned', 'moderator']);
const MAX_CHAT_LENGTH = 200;
const MAX_PACKET_BYTES = 4096;
/** Sockets silent for this long are dropped (client pings every 2 s). */
const IDLE_TIMEOUT_MS = 30_000;

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<string, Session>();
  private nextSessionId = 1;
  /** Scratch array reused for every snapshot build. */
  private readonly entityScratch: SnapshotEntity[] = [];

  constructor(
    server: HttpServer,
    private readonly world: World,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly metrics: MetricsRing,
  ) {
    this.wss = new WebSocketServer({
      server,
      path: '/game',
      maxPayload: MAX_PACKET_BYTES,
      // Compression costs CPU we do not have; our packets are already small.
      perMessageDeflate: false,
    });

    this.wss.on('connection', (socket, request) => {
      const origin = request.headers.origin;
      if (!this.isOriginAllowed(origin)) {
        this.log.warn({ origin }, 'rejected websocket from disallowed origin');
        socket.close(1008, 'origin not allowed');
        return;
      }
      const ip =
        (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
        request.socket.remoteAddress ??
        'unknown';
      this.accept(socket, ip);
    });
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    // Native clients and same-origin production requests may omit Origin.
    if (!origin) return true;
    if (this.config.NODE_ENV !== 'production') return true;
    return origin === this.config.CLIENT_ORIGIN;
  }

  private accept(socket: WebSocket, ip: string): void {
    const id = `s${this.nextSessionId++}`;
    const session = new Session(id, socket, ip, (bytes) => {
      this.metrics.recordBytesOut(bytes);
    });
    this.sessions.set(id, session);
    this.log.debug({ sessionId: id, ip }, 'socket connected');

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      session.lastMessageAt = Date.now();
      this.metrics.recordBytesIn(data.byteLength);
      if (!isBinary) {
        this.disconnect(
          session,
          NoticeCode.MalformedPacket,
          'text frames are not part of the protocol',
        );
        return;
      }
      try {
        this.route(session, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } catch (error) {
        if (error instanceof ProtocolError) {
          this.log.warn({ sessionId: id, err: error.message }, 'malformed packet');
          this.disconnect(session, NoticeCode.MalformedPacket, error.message);
        } else {
          this.log.error({ sessionId: id, err: error }, 'error handling packet');
          this.disconnect(session, NoticeCode.MalformedPacket, 'internal error');
        }
      }
    });

    socket.on('close', () => {
      this.cleanup(session);
    });
    socket.on('error', (error) => {
      this.log.debug({ sessionId: id, err: error.message }, 'socket error');
      this.cleanup(session);
    });
  }

  private route(session: Session, data: Uint8Array): void {
    if (session.state === 'closed') return;
    const opcode = peekOpcode(data);
    const reader = new BinaryReader(data);
    reader.u8(); // consume opcode

    switch (opcode) {
      case ClientOp.Hello:
        this.handleHello(session, reader);
        return;
      case ClientOp.InputIntent:
        this.handleInput(session, reader);
        return;
      case ClientOp.Ping:
        this.handlePing(session, reader);
        return;
      case ClientOp.Chat:
        this.handleChat(session, reader);
        return;
      default:
        throw new ProtocolError(`unknown opcode 0x${opcode.toString(16)}`);
    }
  }

  private handleHello(session: Session, reader: BinaryReader): void {
    if (session.state !== 'handshaking') {
      this.disconnect(session, NoticeCode.InvalidHello, 'already handshaked');
      return;
    }
    const hello = decodeHello(reader);

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.log.info(
        { got: hello.protocolVersion, want: PROTOCOL_VERSION },
        'protocol mismatch on hello',
      );
      this.disconnect(session, NoticeCode.ProtocolMismatch);
      return;
    }

    const name = hello.name.trim();
    if (!NAME_PATTERN.test(name) || RESERVED_NAMES.has(name.toLowerCase())) {
      this.disconnect(session, NoticeCode.NameInvalid);
      return;
    }
    if (this.world.hasName(name)) {
      this.disconnect(session, NoticeCode.NameTaken);
      return;
    }
    if (this.world.playerCount >= this.config.MAX_PLAYERS) {
      this.disconnect(session, NoticeCode.ServerFull);
      return;
    }

    const player = this.world.addPlayer(name);
    session.player = player;
    session.state = 'playing';

    session.send(
      encodeWelcome(
        {
          protocolVersion: PROTOCOL_VERSION,
          selfId: player.id,
          tickRate: TICK_RATE,
          serverTimeMs: Date.now(),
          spawn: { x: player.movement.x, y: player.movement.y, z: player.movement.z },
          players: this.world.roster(),
        },
        session.writer,
      ),
    );

    this.log.info({ sessionId: session.id, name, id: player.id }, 'player entered the world');
    this.broadcastRoster();
    this.broadcastSystemChat(`${name} entered the world.`);
  }

  private handleInput(session: Session, reader: BinaryReader): void {
    const player = session.player;
    if (session.state !== 'playing' || !player) return;
    if (!session.allowInput()) {
      player.violations++;
      return;
    }
    const intent = decodeInputIntent(reader);
    player.queueInput(intent);
  }

  private handlePing(session: Session, reader: BinaryReader): void {
    if (!session.allowGeneric()) return;
    const ping = decodePing(reader);
    session.send(encodePong({ clientTimeMs: ping.clientTimeMs, serverTimeMs: Date.now() }));
  }

  private handleChat(session: Session, reader: BinaryReader): void {
    const player = session.player;
    if (session.state !== 'playing' || !player) return;
    if (!session.allowChat()) {
      this.sendNotice(session, NoticeCode.RateLimited);
      return;
    }
    const message = decodeJsonEnvelope<ChatMessage>(reader);
    const text =
      typeof message.text === 'string' ? message.text.trim().slice(0, MAX_CHAT_LENGTH) : '';
    if (!text) return;
    this.broadcastChat(player.name, player.id, text);
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /** Called once per tick: one snapshot per playing session. */
  broadcastSnapshots(tick: number): void {
    const serverTimeMs = Date.now();
    for (const session of this.sessions.values()) {
      const player = session.player;
      if (session.state !== 'playing' || !player) continue;
      if (session.overloaded) {
        this.log.warn({ sessionId: session.id }, 'dropping unresponsive client (backpressure)');
        this.disconnect(session, NoticeCode.Kicked, 'connection too slow');
        continue;
      }
      // Under soft backpressure, halve the snapshot rate for this client only.
      if (session.backpressured && (tick & 1) === 1) continue;

      const m = player.movement;
      session.send(
        encodeSnapshot(
          {
            tick,
            lastInputSeq: player.lastProcessedSeq,
            serverTimeMs,
            self: {
              x: m.x,
              y: m.y,
              z: m.z,
              vx: m.vx,
              vy: m.vy,
              vz: m.vz,
              yaw: m.yaw,
              stamina: m.stamina,
              flags: player.flags,
            },
            entities: this.world.entitiesFor(player, this.entityScratch),
          },
          session.writer,
        ),
      );
    }
  }

  /** Drop sockets that have gone quiet (client pings every 2 s). */
  sweepIdle(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastMessageAt > IDLE_TIMEOUT_MS) {
        this.log.info({ sessionId: session.id }, 'idle timeout');
        this.disconnect(session, NoticeCode.Kicked, 'idle');
      }
    }
  }

  broadcastChat(from: string, fromId: number, text: string): void {
    const payload = { from, fromId, text, system: false };
    for (const session of this.sessions.values()) {
      if (session.state !== 'playing') continue;
      session.send(encodeChatBroadcast(payload));
    }
  }

  broadcastSystemChat(text: string): void {
    const payload = { from: 'System', fromId: 0, text, system: true };
    for (const session of this.sessions.values()) {
      if (session.state !== 'playing') continue;
      session.send(encodeChatBroadcast(payload));
    }
  }

  private broadcastRoster(): void {
    const roster = this.world.roster();
    for (const session of this.sessions.values()) {
      if (session.state !== 'playing') continue;
      session.send(encodeRoster({ players: roster }));
    }
  }

  private sendNotice(session: Session, code: NoticeCode, detail?: string): void {
    session.send(encodeSystemNotice(detail === undefined ? { code } : { code, detail }));
  }

  private disconnect(session: Session, code: NoticeCode, detail?: string): void {
    this.sendNotice(session, code, detail);
    session.close(1000, detail ?? '');
    this.cleanup(session);
  }

  private cleanup(session: Session): void {
    if (!this.sessions.delete(session.id)) return;
    session.state = 'closed';
    const player = session.player;
    if (player) {
      // P3 adds the 15 s reconnect grace window; P0 despawns immediately.
      this.world.removePlayer(player.id);
      this.log.info({ sessionId: session.id, name: player.name }, 'player left the world');
      this.broadcastRoster();
      this.broadcastSystemChat(`${player.name} left the world.`);
    }
  }

  /** Announce and close every socket — used by graceful shutdown. */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      this.sendNotice(session, NoticeCode.ServerShuttingDown);
      session.close(1001, 'server restarting');
    }
    this.sessions.clear();
    this.wss.close();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
