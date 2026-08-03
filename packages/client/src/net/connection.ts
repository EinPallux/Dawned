/**
 * Client networking: handshake, clock sync, prediction/reconciliation and remote
 * entity interpolation (docs/tech/NETWORKING.md §3–§4).
 *
 * The golden rule: this module never invents authoritative state. It predicts with
 * the shared movement step, then corrects itself against every snapshot.
 */

import {
  BinaryReader,
  EntityFlag,
  INTERP_DELAY_MS,
  NoticeCode,
  PROTOCOL_VERSION,
  ProtocolError,
  ServerOp,
  TICK_DT,
  cloneMovementState,
  createMovementState,
  decodeJsonEnvelope,
  decodePong,
  decodeSnapshot,
  decodeSystemNotice,
  encodeChat,
  encodeHello,
  encodeInputIntent,
  encodePing,
  noticeTextFor,
  peekOpcode,
  stepMovement,
  type ChatBroadcastMessage,
  type MovementIntent,
  type MovementState,
  type RosterEntry,
  type RosterMessage,
  type SnapshotMessage,
  type TerrainSampler,
  type WelcomeMessage,
} from '@dawned/shared';

/** How long a positional correction is smoothed over, in ms. */
const CORRECTION_SMOOTH_MS = 80;
/** Errors below this (metres) are ignored — float noise, not desync. */
const CORRECTION_IGNORE_M = 0.02;
/** Errors above this snap instantly (teleport, knockback, or a real desync). */
const CORRECTION_SNAP_M = 1.5;
/** Interpolation samples kept per remote entity. */
const INTERP_BUFFER_SIZE = 32;
const PING_INTERVAL_MS = 2000;
/** Drift beyond this (ms) means the interpolation clock resyncs hard instead of easing. */
const INTERP_RESYNC_MS = 400;
/** How strongly each snapshot pulls the interpolation clock toward the server's timeline. */
const INTERP_CLOCK_EASE = 0.15;
/** Hard bound on how far easing may leave the clock behind the newest snapshot. */
const INTERP_MAX_LAG_MS = 60;
/** Hard bound on running ahead (which would starve the buffer and stutter). */
const INTERP_MAX_LEAD_MS = 40;
/**
 * Reconnect schedule after an unexpected socket loss. Cumulative attempt times
 * (~0.4 / 1.6 / 4.1 / 8.1 / 13.1 s) all land inside the server's 15 s grace
 * window (gateway LINGER_MS), so a successful attempt reattaches the same
 * entity in place and nobody around sees a despawn.
 */
const RECONNECT_DELAYS_MS = [400, 1200, 2500, 4000, 5000];

export interface RemoteSample {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
}

export interface RemoteEntity {
  id: number;
  name: string;
  samples: RemoteSample[];
  /** Rendered position, updated every frame by {@link Connection.sampleRemotes}. */
  render: { x: number; y: number; z: number; yaw: number; flags: number };
}

export type ConnectionStatus =
  'connecting' | 'connected' | 'playing' | 'reconnecting' | 'closed' | 'error';

export interface ConnectionEvents {
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onChat?: (message: ChatBroadcastMessage) => void;
  onRoster?: (players: RosterEntry[]) => void;
  onWelcome?: (welcome: WelcomeMessage) => void;
  /** Fired for every SystemNotice so the UI can react per code (restart, name taken…). */
  onNotice?: (code: NoticeCode, friendlyText: string) => void;
}

interface PendingInput {
  seq: number;
  intent: MovementIntent;
}

export class Connection {
  private socket: WebSocket | null = null;
  private readonly events: ConnectionEvents;

  status: ConnectionStatus = 'connecting';
  selfId = 0;
  playerName = '';

  /** Credentials kept for automatic reconnection after a socket loss. */
  private url = '';
  private token = '';
  private characterId = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the player was in-world — only then is auto-reconnect worth it. */
  private everPlayed = false;
  /** Set by {@link disconnect} so an intentional close never auto-reconnects. */
  private manualClose = false;
  /** Set when the server names a reason (kick, restart, full) — terminal, no retry. */
  private refusedByServer = false;

  /** Predicted local state — what the player sees themselves as. */
  readonly predicted: MovementState = createMovementState();
  /** Last authoritative state received from the server. */
  private readonly authoritative: MovementState = createMovementState();
  /** Scratch state used while replaying unacked inputs. */
  private readonly replayScratch: MovementState = createMovementState();

  /** Visual offset that decays a correction away instead of snapping. */
  private correction = { x: 0, y: 0, z: 0, remainingMs: 0 };

  private readonly pendingInputs: PendingInput[] = [];
  private inputSeq = 0;

  /** Clock sync: serverTime ≈ performance.now() + clockOffsetMs. Diagnostics only. */
  private clockOffsetMs = 0;
  rttMs = 0;
  /** Last pong's server stamp + local receipt time — echoed in pings (v6). */
  private lastPongServerTimeMs = 0;
  private lastPongAtMs = 0;
  private clockInitialized = false;
  /**
   * Ping runs on its own interval timer, NOT the render loop: browsers stop
   * requestAnimationFrame entirely in hidden tabs, so an rAF-driven ping would get
   * every alt-tabbed player kicked by the server's idle sweep. Interval timers keep
   * firing in the background (throttled to 1/s, and to 1/min under Chrome's
   * intensive throttling after ~5 min hidden) — the server's idle window is sized
   * to tolerate the worst case (gateway IDLE_TIMEOUT_MS > 60 s).
   */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Interpolation clock, in server-time units.
   *
   * Deliberately NOT derived from ping/pong: a stalled frame (GC, alt-tab, a slow
   * GPU) inflates the measured RTT, which skews an offset-based clock by hundreds of
   * milliseconds and drags every remote player visibly behind. Instead we drive it
   * from the snapshot stream — the only clock that matters for "when did the server
   * say this happened" — advancing it with local time between snapshots and easing it
   * toward `newestSnapshot − INTERP_DELAY_MS`.
   */
  private interpClockMs = 0;
  private interpClockReady = false;

  readonly remotes = new Map<number, RemoteEntity>();
  private roster: RosterEntry[] = [];

  /** Diagnostics for the HUD netgraph. */
  stats = {
    snapshotsReceived: 0,
    corrections: 0,
    snaps: 0,
    lastCorrectionM: 0,
    bytesIn: 0,
    bytesOut: 0,
    serverTick: 0,
    /** performance.now() when the newest snapshot was handled (0 = none yet). */
    lastSnapshotAtMs: 0,
    /** Smoothed gap between snapshots — healthy is ~TICK_MS. */
    snapshotIntervalMs: 0,
  };

  /** Wipe per-session state so a reattached session starts from its first snapshot. */
  private resetForSession(): void {
    this.pendingInputs.length = 0;
    this.correction.x = 0;
    this.correction.y = 0;
    this.correction.z = 0;
    this.correction.remainingMs = 0;
    this.interpClockReady = false;
    this.clockInitialized = false;
    this.remotes.clear();
    this.stats.lastSnapshotAtMs = 0;
    this.stats.snapshotIntervalMs = 0;
  }

  /**
   * The terrain the prediction step walks on — the SAME sampler the streaming
   * manager fills, so predicted ground always matches the rendered ground
   * (and, transitively, the server's copy of the same chunk bytes).
   *
   * `groundReady` says whether real chunk data backs a position yet. Without it
   * (e.g. right after a far teleport), replaying inputs would step through void
   * and gravity-poison the predicted state — so snapshots are adopted verbatim
   * instead until the ground streams in.
   */
  constructor(
    events: ConnectionEvents = {},
    private readonly terrain: TerrainSampler,
    private readonly groundReady?: (x: number, z: number) => boolean,
  ) {
    this.events = events;
  }

  connect(url: string, token: string, characterId: number): void {
    this.url = url;
    this.token = token;
    this.characterId = characterId;
    this.manualClose = false;
    this.refusedByServer = false;
    this.reconnectAttempt = 0;
    this.setStatus('connecting');
    this.openSocket();
  }

  private openSocket(): void {
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return; // superseded by a newer attempt
      if (this.status === 'connecting') this.setStatus('connected');
      this.sendRaw(
        encodeHello({
          protocolVersion: PROTOCOL_VERSION,
          token: this.token,
          characterId: this.characterId,
        }),
      );
      this.sendPing();
      this.pingTimer = setInterval(() => {
        this.sendPing();
      }, PING_INTERVAL_MS);
    });

    socket.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      if (this.socket !== socket) return;
      this.receiveRaw(socket, new Uint8Array(event.data));
    });

    // 'error' always precedes 'close' on failures — a single handler decides
    // whether this socket loss retries or ends the session.
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.stopPingTimer();
      this.handleSocketLoss();
    });
  }

  /**
   * Socket gone. Reattach path (docs/tech/NETWORKING.md §6): the server parks the
   * entity for 15 s, so we retry on a schedule that fits inside that window and
   * resume seamlessly. Terminal paths: the user left, the server refused us by
   * name (kick/restart/full), we never made it in-world, or retries ran out.
   */
  private handleSocketLoss(): void {
    if (this.manualClose || this.refusedByServer) return; // status already set
    if (!this.everPlayed) {
      if (this.status !== 'error') this.setStatus('error', 'Connection failed.');
      return;
    }
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.setStatus('closed');
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt]!;
    this.reconnectAttempt++;
    this.setStatus(
      'reconnecting',
      `attempt ${this.reconnectAttempt}/${RECONNECT_DELAYS_MS.length}`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      this.openSocket();
    }, delay);
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingTimer();
    this.socket?.close();
    this.socket = null;
  }

  // -------------------------------------------------------------------------
  // Lag lab (docs/tech/NETWORKING.md §8): artificial latency/jitter, both ways
  // -------------------------------------------------------------------------

  /**
   * Injected round-trip latency and jitter, split evenly across send/receive.
   * Local-only and strictly worse-than-real: the server stays authoritative, so
   * this can never be more than a self-handicap — safe to leave in production
   * builds for remote debugging of a player's feel report.
   */
  private netsimRttMs = 0;
  private netsimJitterMs = 0;
  /** Per-direction monotonic delivery clocks — injected jitter must not reorder. */
  private sendDeliverAt = 0;
  private recvDeliverAt = 0;

  setNetsim(rttMs: number, jitterMs: number): void {
    this.netsimRttMs = Math.max(0, Math.min(2000, rttMs));
    this.netsimJitterMs = Math.max(0, Math.min(1000, jitterMs));
  }

  get netsim(): { rttMs: number; jitterMs: number } {
    return { rttMs: this.netsimRttMs, jitterMs: this.netsimJitterMs };
  }

  /** One-way artificial delay for this packet (half the RTT + jittered half). */
  private netsimDelayMs(): number {
    if (this.netsimRttMs <= 0 && this.netsimJitterMs <= 0) return 0;
    return this.netsimRttMs / 2 + (Math.random() * this.netsimJitterMs) / 2;
  }

  private sendRaw(bytes: Uint8Array): void {
    this.stats.bytesOut += bytes.byteLength;
    const delay = this.netsimDelayMs();
    if (delay <= 0) {
      if (this.isOpen) this.socket!.send(bytes);
      return;
    }
    const socket = this.socket;
    const now = performance.now();
    this.sendDeliverAt = Math.max(now + delay, this.sendDeliverAt);
    setTimeout(() => {
      // Deliver only onto the same socket generation, and only if still open.
      if (this.socket === socket && socket?.readyState === WebSocket.OPEN) socket.send(bytes);
    }, this.sendDeliverAt - now);
  }

  private receiveRaw(socket: WebSocket, bytes: Uint8Array): void {
    const deliver = (): void => {
      if (this.socket !== socket) return; // stale socket's queue — drop
      try {
        this.handlePacket(bytes);
      } catch (error) {
        if (error instanceof ProtocolError) {
          console.error('[net] malformed packet from server:', error.message);
        } else {
          console.error('[net] error handling packet:', error);
        }
      }
    };
    const delay = this.netsimDelayMs();
    if (delay <= 0) {
      deliver();
      return;
    }
    const now = performance.now();
    this.recvDeliverAt = Math.max(now + delay, this.recvDeliverAt);
    setTimeout(deliver, this.recvDeliverAt - now);
  }

  private stopPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.events.onStatus?.(status, detail);
  }

  private get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** Server time in ms, as best we can estimate it. */
  serverNow(): number {
    return performance.now() + this.clockOffsetMs;
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private handlePacket(data: Uint8Array): void {
    this.stats.bytesIn += data.byteLength;
    const opcode = peekOpcode(data);
    const reader = new BinaryReader(data);
    reader.u8();

    switch (opcode) {
      case ServerOp.Welcome: {
        const welcome = decodeJsonEnvelope<WelcomeMessage>(reader);
        // A welcome is a session boundary — on a reattach after reconnect the
        // server resumes our old entity where it stood, and everything derived
        // from the previous socket (unacked inputs, corrections, interpolation
        // buffers) is stale. Start clean; the first snapshot refills all of it.
        this.resetForSession();
        this.selfId = welcome.selfId;
        this.playerName = welcome.players.find((p) => p.id === welcome.selfId)?.name ?? '';
        this.predicted.x = welcome.spawn.x;
        this.predicted.y = welcome.spawn.y;
        this.predicted.z = welcome.spawn.z;
        this.predicted.yaw = welcome.spawn.yaw;
        this.predicted.vx = 0;
        this.predicted.vy = 0;
        this.predicted.vz = 0;
        this.predicted.fallPeakY = welcome.spawn.y;
        cloneInto(this.authoritative, this.predicted);
        this.roster = welcome.players;
        this.everPlayed = true;
        this.reconnectAttempt = 0;
        this.setStatus('playing');
        this.events.onWelcome?.(welcome);
        this.events.onRoster?.(welcome.players);
        return;
      }
      case ServerOp.Snapshot:
        this.handleSnapshot(decodeSnapshot(reader));
        return;
      case ServerOp.Roster: {
        const message = decodeJsonEnvelope<RosterMessage>(reader);
        this.roster = message.players;
        this.syncRemotesWithRoster();
        this.events.onRoster?.(message.players);
        return;
      }
      case ServerOp.ChatBroadcast:
        this.events.onChat?.(decodeJsonEnvelope<ChatBroadcastMessage>(reader));
        return;
      case ServerOp.Pong: {
        const pong = decodePong(reader);
        const now = performance.now();
        this.rttMs = now - pong.clientTimeMs;
        // Remember the pong for the next ping's echo — the server derives its
        // OWN rtt measurement from it for the lag-comp rewind (protocol v6).
        this.lastPongServerTimeMs = pong.serverTimeMs;
        this.lastPongAtMs = now;
        // Server time at the moment we receive this ≈ its stamp + half the trip back.
        const estimated = pong.serverTimeMs + this.rttMs / 2;
        const offset = estimated - now;
        this.clockOffsetMs = this.clockInitialized
          ? this.clockOffsetMs * 0.85 + offset * 0.15
          : offset;
        this.clockInitialized = true;
        return;
      }
      case ServerOp.SystemNotice: {
        const notice = decodeSystemNotice(reader);
        // Prefer our own mapped copy; the server's detail is for the log.
        const friendly = noticeTextFor(notice.code);
        // A named refusal (kick, restart, full, second login…) is terminal:
        // auto-reconnecting against it would just get refused again.
        this.refusedByServer = true;
        this.setStatus('error', friendly);
        this.events.onNotice?.(notice.code, friendly);
        console.warn('[net] system notice', notice.code, notice.detail ?? friendly);
        return;
      }
      default:
        console.warn(`[net] ignoring unknown opcode 0x${opcode.toString(16)}`);
    }
  }

  private handleSnapshot(snapshot: SnapshotMessage): void {
    this.stats.snapshotsReceived++;
    this.stats.serverTick = snapshot.tick;
    const arrivedAt = performance.now();
    if (this.stats.lastSnapshotAtMs > 0) {
      const gap = arrivedAt - this.stats.lastSnapshotAtMs;
      this.stats.snapshotIntervalMs =
        this.stats.snapshotIntervalMs === 0 ? gap : this.stats.snapshotIntervalMs * 0.9 + gap * 0.1;
    }
    this.stats.lastSnapshotAtMs = arrivedAt;

    // 1. Adopt the authoritative self state.
    const self = snapshot.self;
    this.authoritative.x = self.x;
    this.authoritative.y = self.y;
    this.authoritative.z = self.z;
    this.authoritative.vx = self.vx;
    this.authoritative.vy = self.vy;
    this.authoritative.vz = self.vz;
    this.authoritative.yaw = self.yaw;
    this.authoritative.stamina = self.stamina;
    this.authoritative.maxStamina = this.predicted.maxStamina;
    this.authoritative.grounded = (self.flags & EntityFlag.Grounded) !== 0;
    this.authoritative.sprinting = (self.flags & EntityFlag.Sprinting) !== 0;
    this.authoritative.swimming = (self.flags & EntityFlag.Swimming) !== 0;
    this.authoritative.fallPeakY = this.predicted.fallPeakY;
    this.authoritative.staminaIdleMs = this.predicted.staminaIdleMs;

    // 2. Drop inputs the server has already consumed.
    while (
      this.pendingInputs.length > 0 &&
      seqLE(this.pendingInputs[0]!.seq, snapshot.lastInputSeq)
    ) {
      this.pendingInputs.shift();
    }

    // 2b. No chunk data under the authoritative position yet (a far teleport —
    // /stuck, a future GM recall — outruns streaming): predicting there would
    // step through void, so gravity marks us airborne and the view free-falls
    // until the chunk arrives. Take the server's word verbatim and stand down;
    // run-world gates new inputs on the same ground-readiness, so the pending
    // buffer stays empty until prediction can resume honestly.
    if (this.groundReady && !this.groundReady(self.x, self.z)) {
      this.pendingInputs.length = 0;
      cloneInto(this.predicted, this.authoritative);
      this.correction.x = 0;
      this.correction.y = 0;
      this.correction.z = 0;
      this.correction.remainingMs = 0;
      this.stats.lastCorrectionM = 0;
      this.bufferRemotes(snapshot);
      return;
    }

    // 3. Replay what it hasn't consumed yet, from the authoritative state.
    cloneInto(this.replayScratch, this.authoritative);
    for (const pending of this.pendingInputs) {
      stepMovement(this.replayScratch, pending.intent, TICK_DT, this.terrain);
    }

    // 4. Compare with what we predicted and correct smoothly (or snap).
    const errorX = this.replayScratch.x - this.predicted.x;
    const errorY = this.replayScratch.y - this.predicted.y;
    const errorZ = this.replayScratch.z - this.predicted.z;
    const error = Math.sqrt(errorX * errorX + errorY * errorY + errorZ * errorZ);
    this.stats.lastCorrectionM = error;

    if (error > CORRECTION_IGNORE_M) {
      if (error > CORRECTION_SNAP_M) {
        this.stats.snaps++;
        this.correction.x = 0;
        this.correction.y = 0;
        this.correction.z = 0;
        this.correction.remainingMs = 0;
      } else {
        this.stats.corrections++;
        // Keep the visual where it was and let it slide into place.
        this.correction.x -= errorX;
        this.correction.y -= errorY;
        this.correction.z -= errorZ;
        this.correction.remainingMs = CORRECTION_SMOOTH_MS;
      }
      cloneInto(this.predicted, this.replayScratch);
    }

    this.bufferRemotes(snapshot);
  }

  /** Steps 5–6: interpolation clock + remote sample buffering (runs on EVERY snapshot). */
  private bufferRemotes(snapshot: SnapshotMessage): void {
    // 5. Advance the interpolation clock toward this snapshot's timeline.
    const target = snapshot.serverTimeMs - INTERP_DELAY_MS;
    if (!this.interpClockReady || Math.abs(this.interpClockMs - target) > INTERP_RESYNC_MS) {
      // First snapshot, or we drifted badly (tab was backgrounded): hard resync.
      this.interpClockMs = target;
      this.interpClockReady = true;
    } else {
      // Gentle pull so playback speed stays smooth instead of stuttering.
      this.interpClockMs += (target - this.interpClockMs) * INTERP_CLOCK_EASE;
      // ...but never let easing leave us trailing (or racing ahead of) the server's
      // timeline: on a slow client, snapshots arrive in bursts and a purely eased
      // clock accumulates lag, dragging every remote player metres behind.
      const behind = target - this.interpClockMs;
      if (behind > INTERP_MAX_LAG_MS) this.interpClockMs = target - INTERP_MAX_LAG_MS;
      else if (behind < -INTERP_MAX_LEAD_MS) this.interpClockMs = target + INTERP_MAX_LEAD_MS;
    }

    // 6. Buffer remote entities for interpolation.
    const time = snapshot.serverTimeMs;
    for (const entity of snapshot.entities) {
      let remote = this.remotes.get(entity.id);
      if (!remote) {
        remote = {
          id: entity.id,
          name: this.nameFor(entity.id),
          samples: [],
          render: { x: entity.x, y: entity.y, z: entity.z, yaw: entity.yaw, flags: entity.flags },
        };
        this.remotes.set(entity.id, remote);
      }
      remote.samples.push({
        time,
        x: entity.x,
        y: entity.y,
        z: entity.z,
        yaw: entity.yaw,
        flags: entity.flags,
      });
      if (remote.samples.length > INTERP_BUFFER_SIZE) remote.samples.shift();
    }

    // Drop entities that stopped being reported.
    const present = new Set(snapshot.entities.map((entity) => entity.id));
    for (const id of this.remotes.keys()) {
      if (!present.has(id)) this.remotes.delete(id);
    }
  }

  private nameFor(id: number): string {
    return this.roster.find((entry) => entry.id === id)?.name ?? `Player ${id}`;
  }

  /** Roster data (class, level, appearance) for an entity, once known. */
  rosterEntryFor(id: number): RosterEntry | undefined {
    return this.roster.find((entry) => entry.id === id);
  }

  private syncRemotesWithRoster(): void {
    for (const remote of this.remotes.values()) {
      remote.name = this.nameFor(remote.id);
    }
  }

  // -------------------------------------------------------------------------
  // Outbound / simulation
  // -------------------------------------------------------------------------

  /**
   * Advance the local player one fixed tick: predict immediately, tell the server
   * what we intended.
   */
  simulateTick(intent: MovementIntent): void {
    this.inputSeq = (this.inputSeq + 1) & 0xffff;
    const record: PendingInput = { seq: this.inputSeq, intent: { ...intent } };
    this.pendingInputs.push(record);
    // Bound the buffer: a very long stall should not replay thousands of steps.
    if (this.pendingInputs.length > 120) this.pendingInputs.shift();

    stepMovement(this.predicted, intent, TICK_DT, this.terrain);

    if (this.isOpen) {
      this.sendRaw(
        encodeInputIntent({
          seq: record.seq,
          moveX: intent.moveX,
          moveZ: intent.moveZ,
          yaw: intent.yaw,
          buttons: intent.buttons,
        }),
      );
    }
  }

  /** Per-frame housekeeping: advance the interp clock, decay corrections, resample. */
  update(dtMs: number): void {
    // Between snapshots the interpolation clock simply runs at local wall speed;
    // each arriving snapshot eases it back onto the server's timeline.
    // (Pinging is NOT done here — see pingTimer.)
    if (this.interpClockReady) this.interpClockMs += dtMs;

    if (this.correction.remainingMs > 0) {
      const decay = Math.max(0, 1 - dtMs / this.correction.remainingMs);
      this.correction.x *= decay;
      this.correction.y *= decay;
      this.correction.z *= decay;
      this.correction.remainingMs = Math.max(0, this.correction.remainingMs - dtMs);
    }

    this.sampleRemotes();
  }

  /**
   * Where the local player should be drawn: prediction, extrapolated by the
   * frame's leftover sub-tick time, plus the decaying correction offset.
   *
   * The simulation steps at 20 Hz; a 60–144 Hz display drawing raw tick
   * positions shows the character advancing in 27 cm bursts — the whole game
   * reads as laggy. Extrapolating along the post-step velocity for the
   * accumulator's remainder (≤ one tick) is exact whenever the next tick keeps
   * the same intent — i.e. almost every frame — and off by a frame's worth of
   * acceleration otherwise, which the correction smoothing absorbs unseen.
   */
  renderPosition(aheadMs = 0): { x: number; y: number; z: number } {
    const p = this.predicted;
    const t = Math.min(aheadMs, TICK_DT * 1000) / 1000;
    let x = p.x + p.vx * t;
    let z = p.z + p.vz * t;
    // Never extrapolate into a blocked cell — the sim will slide, so should we.
    if (t > 0 && this.terrain.walkableAt && !this.terrain.walkableAt(x, z)) {
      x = p.x;
      z = p.z;
    }
    // Vertical: grounded characters follow the terrain under the extrapolated
    // point (otherwise slopes stair-step at tick rate); airborne integrates vy;
    // swimming stays pinned to the surface (vy is already 0).
    let y: number;
    if (p.grounded) {
      y = this.terrain.heightAt(x, z);
    } else {
      y = p.y + p.vy * t;
    }
    return {
      x: x + this.correction.x,
      y: y + this.correction.y,
      z: z + this.correction.z,
    };
  }

  /** Interpolate every remote entity to the interpolation clock's time. */
  private sampleRemotes(): void {
    if (!this.interpClockReady) return;
    const renderTime = this.interpClockMs;
    for (const remote of this.remotes.values()) {
      const samples = remote.samples;
      if (samples.length === 0) continue;
      if (samples.length === 1 || renderTime <= samples[0]!.time) {
        const only = samples[0]!;
        remote.render.x = only.x;
        remote.render.y = only.y;
        remote.render.z = only.z;
        remote.render.yaw = only.yaw;
        remote.render.flags = only.flags;
        continue;
      }

      let older = samples[0]!;
      let newer = samples[samples.length - 1]!;
      for (let i = 0; i < samples.length - 1; i++) {
        if (samples[i]!.time <= renderTime && samples[i + 1]!.time >= renderTime) {
          older = samples[i]!;
          newer = samples[i + 1]!;
          break;
        }
      }

      const span = newer.time - older.time;
      const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - older.time) / span)) : 1;
      remote.render.x = older.x + (newer.x - older.x) * t;
      remote.render.y = older.y + (newer.y - older.y) * t;
      remote.render.z = older.z + (newer.z - older.z) * t;
      remote.render.yaw = lerpAngleShortest(older.yaw, newer.yaw, t);
      remote.render.flags = newer.flags;
    }
  }

  sendChat(text: string): void {
    if (this.isOpen) this.sendRaw(encodeChat({ text }));
  }

  private sendPing(): void {
    if (!this.isOpen) return;
    const now = performance.now();
    this.sendRaw(
      encodePing({
        clientTimeMs: now,
        echoServerTimeMs: this.lastPongServerTimeMs,
        echoAgeMs: this.lastPongServerTimeMs > 0 ? now - this.lastPongAtMs : 0,
      }),
    );
  }
}

const cloneInto = (target: MovementState, source: Readonly<MovementState>): void => {
  Object.assign(target, cloneMovementState(source));
};

/** u16 sequence comparison that survives wraparound. */
const seqLE = (a: number, b: number): boolean => ((b - a) & 0xffff) < 0x8000;

const lerpAngleShortest = (a: number, b: number, t: number): number => {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
};

export { NoticeCode };
