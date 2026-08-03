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
  decodeAbilityRequest,
  decodeHello,
  decodeInputIntent,
  decodeJsonEnvelope,
  decodePing,
  encodeAbilityReject,
  encodeAbilityResolve,
  encodeAbilityStart,
  encodeAbilityState,
  encodeEffectSync,
  exportCooldowns,
  slotForAction,
  encodeChatBroadcast,
  encodeEnemyMeta,
  encodeEntityEvent,
  encodePong,
  encodeProjectileEnd,
  encodeProjectileSpawn,
  encodeRoster,
  encodeSnapshot,
  encodeSystemNotice,
  encodeTelegraph,
  encodeWelcome,
  peekOpcode,
  type ChatMessage,
  type EnemyMetaEntry,
  type SnapshotEntity,
} from '@dawned/shared';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { MetricsRing } from '../metrics/ring.js';
import type { World } from '../world/world.js';
import type { ServerPlayer } from '../world/player.js';
import type { AuthService } from '../auth/service.js';
import { CharacterService, toAppearance } from '../characters/service.js';
import { Session } from './session.js';
import type { CombatEvent } from '../world/combat.js';

const MAX_CHAT_LENGTH = 200;
/** Position write-behind cadence (docs/tech/DATABASE.md §2). */
const PERSIST_INTERVAL_MS = 10_000;
const MAX_PACKET_BYTES = 4096;
/**
 * Sockets silent for this long are dropped. The client pings every 2 s in the
 * foreground, but hidden tabs get their timers throttled — Chrome's intensive
 * throttling goes as low as one timer fire per minute — so the window must sit
 * comfortably above 60 s or alt-tabbed players get kicked. Genuinely dead peers
 * are caught sooner by send backpressure and TCP itself.
 */
const IDLE_TIMEOUT_MS = 90_000;
/** Disconnect grace: the entity lingers so a dropped Wi-Fi blip can resume (NETWORKING §6). */
const LINGER_MS = 15_000;
/** `/stuck` teleport cooldown. */
const STUCK_COOLDOWN_MS = 60_000;

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<string, Session>();
  private nextSessionId = 1;
  /** Entities whose socket dropped, waiting out the reconnect grace (by character id). */
  private readonly lingering = new Map<number, { player: ServerPlayer; until: number }>();
  /** Scratch array reused for every snapshot build. */
  private readonly entityScratch: SnapshotEntity[] = [];

  constructor(
    server: HttpServer,
    private readonly world: World,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly metrics: MetricsRing,
    private readonly auth: AuthService,
    private readonly characters: CharacterService,
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
        // Async (DB lookups) — decode happens synchronously inside before any await,
        // so the reader's buffer is consumed safely; failures disconnect the session.
        this.handleHello(session, reader).catch((error: unknown) => {
          this.log.error({ sessionId: session.id, err: error }, 'hello handling failed');
          this.disconnect(session, NoticeCode.InvalidHello, 'internal error');
        });
        return;
      case ClientOp.InputIntent:
        this.handleInput(session, reader);
        return;
      case ClientOp.AbilityRequest:
        this.handleAbilityRequest(session, reader);
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

  /** Combat requests only queue here — the world validates inside the tick. */
  private handleAbilityRequest(session: Session, reader: BinaryReader): void {
    const player = session.player;
    if (session.state !== 'playing' || !player) return;
    if (!session.allowGeneric()) {
      player.violations++;
      return;
    }
    const request = decodeAbilityRequest(reader);
    player.queueAttack({
      seq: request.seq,
      action: request.action,
      targetId: request.targetId,
      aimYaw: request.aimYaw,
      aimPitch: request.aimPitch,
    });
  }

  /**
   * Authenticated handshake (protocol v2): token → account → owned character →
   * spawn. Async because it hits the database; the session is parked in
   * 'authenticating' so a second Hello or early input can't race it.
   */
  private async handleHello(session: Session, reader: BinaryReader): Promise<void> {
    if (session.state !== 'handshaking') {
      this.disconnect(session, NoticeCode.InvalidHello, 'already handshaked');
      return;
    }
    const hello = decodeHello(reader);
    session.state = 'authenticating';

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.log.info(
        { got: hello.protocolVersion, want: PROTOCOL_VERSION },
        'protocol mismatch on hello',
      );
      this.disconnect(session, NoticeCode.ProtocolMismatch);
      return;
    }

    const account = await this.auth.validateSession(hello.token);
    if (!account) {
      this.disconnect(session, NoticeCode.AuthFailed);
      return;
    }
    if (!session.isIn('authenticating')) return; // socket died during the DB trip

    const character = await this.characters.getOwned(account.id, hello.characterId);
    if (!character) {
      this.disconnect(session, NoticeCode.CharacterUnavailable);
      return;
    }
    if (!session.isIn('authenticating')) return;

    // Reconnect inside the grace window: the entity never left — reattach the
    // new socket to it, exactly where it stands. Bypasses the ServerFull check
    // (the entity is already counted) and skips the enter/leave broadcasts.
    const linger = this.lingering.get(character.id);
    let player: ServerPlayer;
    let reattached = false;
    if (linger) {
      this.lingering.delete(character.id);
      player = linger.player;
      reattached = true;
    } else {
      if (this.world.playerCount >= this.config.MAX_PLAYERS) {
        this.disconnect(session, NoticeCode.ServerFull);
        return;
      }

      // Single session per account (docs/tech/SECURITY.md §2): the newest login
      // wins, the older one is told why. Save the old character's position first.
      // The old entity may also be lingering (its socket already died) — its
      // grace ends now either way.
      const existing = this.world.findByAccount(account.id);
      if (existing) {
        this.lingering.delete(existing.characterId);
        const existingSession = this.findSessionByPlayer(existing.id);
        if (existingSession) {
          await this.persistPlayer(existing);
          this.disconnect(existingSession, NoticeCode.ReplacedByNewLogin);
        } else {
          this.world.removePlayer(existing.id);
        }
      }

      player = this.world.addPlayer({
        characterId: character.id,
        accountId: account.id,
        name: character.name,
        classId: character.classId,
        level: character.level,
        appearance: toAppearance(character),
        position:
          character.posX !== null && character.posY !== null && character.posZ !== null
            ? { x: character.posX, y: character.posY, z: character.posZ, yaw: character.yaw }
            : null,
        hp: character.hp,
      });
    }
    session.player = player;
    session.state = 'playing';

    session.send(
      encodeWelcome(
        {
          protocolVersion: PROTOCOL_VERSION,
          selfId: player.id,
          characterId: character.id,
          tickRate: TICK_RATE,
          serverTimeMs: Date.now(),
          spawn: {
            x: player.movement.x,
            y: player.movement.y,
            z: player.movement.z,
            yaw: player.movement.yaw,
          },
          players: this.world.roster(),
        },
        session.writer,
      ),
    );

    if (reattached) {
      this.log.info(
        { sessionId: session.id, character: character.name, id: player.id },
        'player resumed within the grace window',
      );
    } else {
      this.log.info(
        { sessionId: session.id, account: account.name, character: character.name, id: player.id },
        'player entered the world',
      );
      this.broadcastRoster();
      this.broadcastSystemChat(`${character.name} entered the world.`);
    }
  }

  private findSessionByPlayer(playerId: number): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.player?.id === playerId) return session;
    }
    return undefined;
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
    const now = Date.now();
    // Server-side RTT from the pong echo (v6): feeds the lag-comp rewind.
    // A liar can only inflate their own rewind inside the 250 ms clamp.
    if (ping.echoServerTimeMs > 0 && session.player) {
      const rtt = now - (ping.echoServerTimeMs + ping.echoAgeMs);
      if (rtt >= 0 && rtt < 5000) {
        const prev = session.player.rttMs;
        session.player.rttMs = prev === 0 ? rtt : prev * 0.7 + rtt * 0.3;
      }
    }
    session.send(encodePong({ clientTimeMs: ping.clientTimeMs, serverTimeMs: now }));
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
    if (text.startsWith('/')) {
      this.handleCommand(session, player, text);
      return;
    }
    this.broadcastChat(player.name, player.id, text);
  }

  /** Player slash-commands. GM commands land in P13 with the audit trail. */
  private handleCommand(session: Session, player: ServerPlayer, text: string): void {
    const command = text.split(/\s+/, 1)[0]!.toLowerCase();
    switch (command) {
      case '/stuck': {
        const now = Date.now();
        const waitMs = STUCK_COOLDOWN_MS - (now - player.lastStuckAt);
        if (waitMs > 0) {
          this.sendSystemChatTo(
            session,
            `/stuck is resting — try again in ${Math.ceil(waitMs / 1000)} s.`,
          );
          return;
        }
        player.lastStuckAt = now;
        this.world.teleportToSpawn(player);
        this.log.info({ name: player.name }, '/stuck teleport');
        this.sendSystemChatTo(session, 'The dawn pulls you back to the shore.');
        return;
      }
      default:
        this.sendSystemChatTo(session, `Unknown command: ${command}`);
    }
  }

  private sendSystemChatTo(session: Session, text: string): void {
    session.send(encodeChatBroadcast({ from: 'System', fromId: 0, text, system: true }));
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

      const entities = this.world.entitiesFor(player, this.entityScratch);
      this.announceNewEnemies(session, entities);

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
              hp: Math.round(player.hp),
              maxHp: player.maxHp,
              resource: Math.floor(player.resource.value),
              comboPoints: player.resource.comboPoints,
            },
            entities,
          },
          session.writer,
        ),
      );
    }
    this.flushEffectSync();
  }

  /**
   * Buff/debuff lists changed this tick fan out AFTER snapshots (same
   * current-visible-set contract as combat events). Self always receives its
   * own list; bystanders receive lists for entities they can see.
   */
  private flushEffectSync(): void {
    const flushHost = (
      entityId: number,
      host: { effects: import('../world/effects.js').ActiveEffect[]; effectsDirty: boolean },
    ): void => {
      if (!host.effectsDirty) return;
      host.effectsDirty = false;
      const nowMs = Date.now();
      const message = encodeEffectSync({
        entityId,
        effects: host.effects.map((effect) => ({
          effectId: effect.effectId,
          stacks: effect.stacks,
          remainingMs: Math.max(0, Math.round(effect.expiresAtMs - nowMs)),
          harmful: effect.harmful,
        })),
      });
      for (const session of this.sessions.values()) {
        const viewer = session.player;
        if (session.state !== 'playing' || !viewer) continue;
        if (viewer.id === entityId || viewer.visible.has(entityId)) session.send(message);
      }
    };
    for (const session of this.sessions.values()) {
      if (session.state === 'playing' && session.player) {
        flushHost(session.player.id, session.player);
      }
    }
    for (const enemy of this.world.enemies.values()) flushHost(enemy.id, enemy);
  }

  /**
   * Enemy identity rides a one-time EnemyMeta per session (the snapshot then
   * carries only dynamic state). Sent BEFORE the snapshot that first includes
   * the entity, so the client always has the meta when the id appears.
   */
  private announceNewEnemies(session: Session, entities: readonly SnapshotEntity[]): void {
    let batch: EnemyMetaEntry[] | null = null;
    for (const entity of entities) {
      if (entity.kind !== 1 || session.knownEnemies.has(entity.id)) continue;
      const enemy = this.world.enemies.get(entity.id);
      if (!enemy) continue;
      session.knownEnemies.add(entity.id);
      (batch ??= []).push({
        id: enemy.id,
        typeId: enemy.def.id,
        name: enemy.def.name,
        level: enemy.level,
        rank: enemy.def.rank,
        modelRef: enemy.def.modelRef,
        scale: enemy.def.scale,
      });
    }
    if (batch) session.send(encodeEnemyMeta({ enemies: batch }));
  }

  /**
   * Fan combat events out to interested clients: the actor always hears about
   * itself; bystanders hear about entities inside their interest set (the
   * visible sets refreshed by the previous snapshot — the AOI hysteresis
   * absorbs the one-tick staleness).
   */
  broadcastCombatEvents(events: readonly CombatEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'ability-reject': {
          const target = this.findSessionByPlayer(event.playerId);
          target?.send(
            encodeAbilityReject({ seq: event.seq, action: event.action, reason: event.reason }),
          );
          // A slot reject means the client's prediction diverged — follow with
          // the authoritative cooldown/resource picture so it re-syncs (v7).
          if (target?.player && slotForAction(event.action) !== null) {
            target.send(
              encodeAbilityState({
                cooldowns: exportCooldowns(target.player.abilityMachine),
                resource: Math.floor(target.player.resource.value),
                comboPoints: target.player.resource.comboPoints,
              }),
            );
          }
          break;
        }
        case 'ability-start':
          this.sendToInterested(event.entityId, (session) => {
            session.send(
              encodeAbilityStart({
                entityId: event.entityId,
                action: event.action,
                step: event.step,
                durationMs: event.durationMs,
                yaw: event.yaw,
              }),
            );
          });
          break;
        case 'ability-resolve':
          this.sendToInterested(event.attackerId, (session) => {
            session.send(
              encodeAbilityResolve({
                attackerId: event.attackerId,
                action: event.action,
                step: event.step,
                hits: event.hits,
              }),
            );
          });
          break;
        case 'entity-event':
          this.sendToInterested(event.entityId, (session) => {
            session.send(
              encodeEntityEvent({
                entityId: event.entityId,
                event: event.event,
                a: event.a,
                b: event.b,
                c: event.c,
              }),
            );
          });
          break;
        case 'telegraph':
          this.sendToInterested(event.casterId, (session) => {
            session.send(
              encodeTelegraph({
                casterId: event.casterId,
                shape: event.shape,
                x: event.x,
                z: event.z,
                yaw: event.yaw,
                size: event.size,
                spread: event.spread,
                impactInMs: event.impactInMs,
              }),
            );
          });
          break;
        case 'projectile-spawn':
          this.sendToInterested(event.ownerId, (session) => {
            session.send(
              encodeProjectileSpawn({
                projectileId: event.projectileId,
                ownerId: event.ownerId,
                x: event.x,
                y: event.y,
                z: event.z,
                dirX: event.dirX,
                dirY: event.dirY,
                dirZ: event.dirZ,
                speed: event.speed,
                visual: event.visual,
              }),
            );
          });
          break;
        case 'projectile-end':
          // Everyone in earshot of the flight got the spawn; ends are tiny —
          // broadcast to all playing sessions (they drop unknown ids).
          for (const session of this.sessions.values()) {
            if (session.state !== 'playing') continue;
            session.send(
              encodeProjectileEnd({
                projectileId: event.projectileId,
                hit: event.hit,
                x: event.x,
                y: event.y,
                z: event.z,
              }),
            );
          }
          break;
        case 'player-died':
        case 'enemy-died':
          // World-internal bookkeeping; clients learn via Death entity-events.
          break;
      }
    }
  }

  /** Send to the entity itself (if a player) and everyone whose AOI holds it. */
  private sendToInterested(entityId: number, send: (session: Session) => void): void {
    for (const session of this.sessions.values()) {
      const viewer = session.player;
      if (session.state !== 'playing' || !viewer) continue;
      if (viewer.id === entityId || viewer.visible.has(entityId)) send(session);
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
    // Server-initiated closes are deliberate (kick, replacement, protocol error):
    // no grace, the entity leaves now.
    this.cleanup(session, true);
  }

  private cleanup(session: Session, immediate = false): void {
    if (!this.sessions.delete(session.id)) return;
    session.state = 'closed';
    const player = session.player;
    if (!player) return;

    // Save last position/playtime in any case. Fire-and-forget: the disconnect
    // path must never block on the database.
    this.persistPlayer(player).catch((error: unknown) => {
      this.log.error({ err: error, character: player.characterId }, 'position save failed');
    });

    if (!immediate) {
      // Unexpected socket loss: the entity lingers for the grace window so the
      // player can resume seamlessly (their character stands where it was —
      // combat-loggable by design, NETWORKING §6).
      this.lingering.set(player.characterId, { player, until: Date.now() + LINGER_MS });
      this.log.info({ sessionId: session.id, name: player.name }, 'connection lost — lingering');
      return;
    }

    this.despawn(player, session.id);
  }

  private despawn(player: ServerPlayer, sessionId: string): void {
    this.lingering.delete(player.characterId);
    this.world.removePlayer(player.id);
    this.log.info({ sessionId, name: player.name }, 'player left the world');
    this.broadcastRoster();
    this.broadcastSystemChat(`${player.name} left the world.`);
  }

  /** Expire grace windows (called from the tick loop next to sweepIdle). */
  sweepLingering(): void {
    const now = Date.now();
    for (const [characterId, entry] of this.lingering) {
      if (now >= entry.until) {
        this.lingering.delete(characterId);
        this.despawn(entry.player, 'linger');
      }
    }
  }

  /** Write one player's position + vitals + accrued playtime (write-behind flush). */
  private async persistPlayer(player: ServerPlayer): Promise<void> {
    const now = Date.now();
    const playtimeDelta = (now - player.lastPersistedAt) / 1000;
    player.lastPersistedAt = now;
    const m = player.movement;
    await this.characters.savePosition(
      player.characterId,
      { x: m.x, y: m.y, z: m.z, yaw: m.yaw },
      playtimeDelta,
      // A death mid-save persists as 1 HP — logins never resume dead (§10).
      player.dead ? 1 : player.hp,
    );
  }

  /** Periodic write-behind for everyone online (started by the server boot). */
  startPersistence(): void {
    setInterval(() => {
      for (const session of this.sessions.values()) {
        const player = session.player;
        if (session.state !== 'playing' || !player) continue;
        this.persistPlayer(player).catch((error: unknown) => {
          this.log.error({ err: error, character: player.characterId }, 'position flush failed');
        });
      }
    }, PERSIST_INTERVAL_MS).unref();
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
