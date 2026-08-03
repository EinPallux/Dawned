/**
 * Client networking: handshake, clock sync, prediction/reconciliation and remote
 * entity interpolation (docs/tech/NETWORKING.md §3–§4).
 *
 * The golden rule: this module never invents authoritative state. It predicts with
 * the shared movement step, then corrects itself against every snapshot.
 */

import {
  AbilityRejectReason,
  ActionId,
  BASIC_COMBOS,
  BinaryReader,
  DODGE_STAMINA_COST,
  EVASIVE_DODGE_DISCOUNT,
  EVASIVE_ENERGY_PER_S,
  EVASIVE_MOVE_SPEED_PCT,
  InputButton,
  OOC_AFTER_MS,
  actionForSlot,
  beginDash,
  buildBasicChains,
  canAfford,
  commitUse,
  cooldownRemainingMs,
  createAbilityMachine,
  createResourceState,
  evaluateUse,
  gainResource,
  importCooldowns,
  interruptCast,
  playerStats,
  slotForAction,
  spendComboPoints,
  tickAbilityMachine,
  tickResource,
  COMBO_LINK_WINDOW_FRACTION,
  COMBO_RESET_MS,
  EntityFlag,
  GCD_MS,
  INTERP_DELAY_MS,
  NoticeCode,
  PROTOCOL_VERSION,
  ProtocolError,
  ServerOp,
  TICK_DT,
  cloneMovementState,
  comboWindow,
  createMovementState,
  decodeAbilityReject,
  decodeAbilityResolve,
  decodeAbilityStart,
  decodeEntityEvent,
  decodeJsonEnvelope,
  decodePong,
  decodeProjectileEnd,
  decodeProjectileSpawn,
  decodeSnapshot,
  decodeSystemNotice,
  decodeTelegraph,
  encodeAbilityRequest,
  encodeChat,
  encodeHello,
  encodeInputIntent,
  encodePing,
  noticeTextFor,
  peekOpcode,
  stepMovement,
  type AbilityDef,
  type AbilityResolveMessage,
  type AbilityStartMessage,
  type AbilityStateMessage,
  type ComboChain,
  type EffectSyncEntry,
  type EffectSyncMessage,
  type ResourceState,
  type ChatBroadcastMessage,
  type ClassId,
  type ComboStep,
  type EnemyMetaEntry,
  type EnemyMetaMessage,
  type EntityEventMessage,
  type MovementIntent,
  type MovementModifiers,
  type MovementState,
  type ProjectileEndMessage,
  type ProjectileSpawnMessage,
  type RosterEntry,
  type RosterMessage,
  type SnapshotMessage,
  type TelegraphMessage,
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
  hpFraction: number;
}

export interface RemoteEntity {
  id: number;
  /** {@link EntityKind} — players interpolate identically to enemies. */
  kind: number;
  name: string;
  samples: RemoteSample[];
  /** Rendered position, updated every frame by {@link Connection.sampleRemotes}. */
  render: { x: number; y: number; z: number; yaw: number; flags: number; hpFraction: number };
  /** Enemy identity (EnemyMeta, v6) — undefined for players. */
  enemyMeta?: EnemyMetaEntry;
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
  // --- combat (protocol v6) ------------------------------------------------
  onAbilityStart?: (message: AbilityStartMessage) => void;
  onAbilityResolve?: (message: AbilityResolveMessage) => void;
  /** A predicted action the server refused — prediction already rolled back. */
  onAbilityReject?: (action: number, reason: number) => void;
  onEntityEvent?: (message: EntityEventMessage) => void;
  onTelegraph?: (message: TelegraphMessage) => void;
  onProjectileSpawn?: (message: ProjectileSpawnMessage) => void;
  onProjectileEnd?: (message: ProjectileEndMessage) => void;
}

interface PendingInput {
  seq: number;
  intent: MovementIntent;
  /**
   * The movement modifiers active when this input was predicted. Replay must
   * step with the SAME modifiers or a buffed/slowed player would diverge from
   * the server on every snapshot (modifiers are time-dependent state, not a
   * pure function of the intent).
   */
  modifiers: MovementModifiers;
}

/** What a hotbar slot needs to render (polled per frame by the HUD). */
export interface SlotView {
  slot: number;
  def: AbilityDef | null;
  /** Remaining cooldown ms (0 = ready). */
  cooldownMs: number;
  cooldownTotalMs: number;
  /** Remaining GCD ms if the def rides the GCD (0 = free). */
  gcdMs: number;
  affordable: boolean;
  /** selfLevel below unlockLevel — rendered locked with the level number. */
  lockedUntilLevel: number;
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

  // --- combat (protocol v6) --------------------------------------------------
  /** Authoritative vitals from the newest snapshot. */
  selfHp = 0;
  selfMaxHp = 0;
  /** Dead per the server (control locked; run-world freezes prediction). */
  selfDead = false;
  /** Raw self flags from the newest snapshot (Dodging etc. for the HUD). */
  selfFlags = 0;
  /** "Dawned" debuff end, in performance.now() terms (0 = none). */
  dawnedUntilMs = 0;
  /** Own class — drives the predicted combo chain timing. */
  classId: ClassId = 'warrior';
  /** Predicted basic-combo chain (mirrors the server's shared rules). */
  private comboStep = -1;
  private comboStartedAtMs = 0;
  private gcdUntilMs = 0;
  private attackSeq = 1;

  // --- slot abilities (protocol v7) ----------------------------------------
  /** Published ability defs (fetched from /api/content/abilities). */
  private abilityDefs = new Map<string, AbilityDef>();
  /** Own hotbar: slot → def, rebuilt when defs or class change. */
  readonly slotDefs = new Map<number, AbilityDef>();
  /** Basic chains from content (falls back to the shared table). */
  private basicChains: Record<ClassId, ComboChain> = BASIC_COMBOS;
  /** The SAME timing machine the server validates with (anti-desync). */
  readonly abilityMachine = createAbilityMachine();
  /** Predicted resource: re-based on every snapshot, debited on commit. */
  readonly resource: ResourceState = createResourceState('warrior', 0);
  /** Authoritative buff/debuff lists (EffectSync) by entity id. */
  private readonly effectLists = new Map<number, EffectSyncEntry[]>();
  /** Predicted Whirlwind-style move slow until this performance.now() ms. */
  private abilityMoveMultUntilMs = 0;
  private abilityMoveMult = 1;
  /** Own character level (Welcome) — unlock gating mirrors the server. */
  selfLevel = 1;
  /**
   * Corrections are held (not adopted) until this time after a predicted dash
   * or blink: those are ability-initiated movement the input replay can't
   * re-trigger, so for one RTT the replayed path lags the predicted one by the
   * whole displacement. Holding keeps the lunge clean; any REAL divergence
   * left after the window resolves through the normal correct/snap path.
   */
  private correctionHoldUntilMs = 0;
  /** effectId → self move-speed % (built from defs; prediction parity). */
  private readonly effectSpeedPct = new Map<string, number>();
  /** effectId → dodge stamina discount (Evasive-style buffs). */
  private readonly effectDodgeDelta = new Map<string, number>();
  /**
   * Client mirror of the server's combat clock (drives Rage decay vs build
   * and mana regen rate). Marked by resolves/flinches that involve us — an
   * approximation the per-snapshot resource re-base keeps honest.
   */
  private lastCombatAtMs = 0;
  /**
   * Until this time, snapshots that still show MORE resource/CP than we
   * predict are ignored: a commit debits instantly, but for one round trip
   * the server hasn't consumed the request and its snapshots would bounce
   * the globe back up (75 → 100 → 75 flicker at real RTT). Downward values
   * (the spend confirmed, or something bigger) always adopt; rejects fully
   * correct through AbilityState.
   */
  private resourceHoldUntilMs = 0;
  /** Enemy identity by entity id — arrives once per enemy via EnemyMeta. */
  private readonly enemyMetas = new Map<number, EnemyMetaEntry>();
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
    this.enemyMetas.clear();
    this.comboStep = -1;
    this.comboStartedAtMs = 0;
    this.gcdUntilMs = 0;
    this.selfDead = false;
    this.dawnedUntilMs = 0;
    this.stats.lastSnapshotAtMs = 0;
    this.stats.snapshotIntervalMs = 0;
    // Ability prediction restarts from truth: the gateway sends an
    // AbilityState (cooldowns + resource) right after Welcome on any resume.
    this.abilityMachine.slots.clear();
    this.abilityMachine.gcdUntilMs = 0;
    this.abilityMachine.cast = null;
    this.effectLists.clear();
    this.abilityMoveMultUntilMs = 0;
    this.abilityMoveMult = 1;
    this.correctionHoldUntilMs = 0;
    this.resourceHoldUntilMs = 0;
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
        const selfEntry = welcome.players.find((p) => p.id === welcome.selfId);
        this.playerName = selfEntry?.name ?? '';
        this.classId = selfEntry?.classId ?? 'warrior';
        this.selfLevel = selfEntry?.level ?? 1;
        // Resource pool sized like the server sizes it (class + INT at level).
        Object.assign(
          this.resource,
          createResourceState(this.classId, playerStats(this.classId, this.selfLevel).int),
        );
        this.rebuildSlotDefs();
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
      case ServerOp.EnemyMeta: {
        const meta = decodeJsonEnvelope<EnemyMetaMessage>(reader);
        for (const enemy of meta.enemies) {
          this.enemyMetas.set(enemy.id, enemy);
          const remote = this.remotes.get(enemy.id);
          if (remote) {
            remote.enemyMeta = enemy;
            remote.name = enemy.name;
          }
        }
        return;
      }
      case ServerOp.AbilityStart:
        this.events.onAbilityStart?.(decodeAbilityStart(reader));
        return;
      case ServerOp.AbilityResolve: {
        const resolve = decodeAbilityResolve(reader);
        if (
          (resolve.attackerId === this.selfId && resolve.hits.length > 0) ||
          resolve.hits.some((hit) => hit.targetId === this.selfId)
        ) {
          this.lastCombatAtMs = performance.now();
        }
        this.events.onAbilityResolve?.(resolve);
        return;
      }
      case ServerOp.AbilityReject: {
        const reject = decodeAbilityReject(reader);
        // The server refused what we predicted — roll the prediction back so
        // the next press starts honest. Rare on healthy clients.
        if (reject.action === (ActionId.BasicAttack as number)) {
          this.comboStep = -1;
          this.comboStartedAtMs = 0;
        } else {
          // Slot reject: optimistically restore the charge/GCD we predicted
          // away. The AbilityState correction in the same flush then adopts
          // the server's cooldowns wholesale, so a legitimately-cooling slot
          // never stays wrongly ready.
          const slot = slotForAction(reject.action);
          const def = slot === null ? undefined : this.slotDefs.get(slot);
          if (def) {
            this.abilityMachine.slots.delete(def.id);
            this.abilityMachine.gcdUntilMs = 0;
          }
        }
        this.events.onAbilityReject?.(reject.action, reject.reason);
        return;
      }
      case ServerOp.EntityEvent: {
        const message = decodeEntityEvent(reader);
        if (message.entityId === this.selfId) {
          if (message.event === 7 /* Dawned */) {
            this.dawnedUntilMs = performance.now() + message.a;
          }
          if (message.event === 8 /* Flinch */) {
            this.lastCombatAtMs = performance.now();
          }
        }
        this.events.onEntityEvent?.(message);
        return;
      }
      case ServerOp.EffectSync: {
        const message = decodeJsonEnvelope<EffectSyncMessage>(reader);
        if (message.effects.length === 0) this.effectLists.delete(message.entityId);
        else this.effectLists.set(message.entityId, message.effects);
        return;
      }
      case ServerOp.AbilityState: {
        // Authoritative correction after a slot reject (or resume): adopt
        // cooldowns + resource wholesale — prediction re-bases from truth.
        // Clearing first matters: a cooldown we predicted that the server
        // does NOT have would otherwise survive (import only overwrites ids
        // present in the payload).
        const message = decodeJsonEnvelope<AbilityStateMessage>(reader);
        this.abilityMachine.slots.clear();
        importCooldowns(this.abilityMachine, message.cooldowns, this.abilityDefs);
        this.resource.value = message.resource;
        this.resource.comboPoints = message.comboPoints;
        this.resourceHoldUntilMs = 0; // authoritative correction — nothing in flight
        return;
      }
      case ServerOp.Telegraph:
        this.events.onTelegraph?.(decodeTelegraph(reader));
        return;
      case ServerOp.ProjectileSpawn:
        this.events.onProjectileSpawn?.(decodeProjectileSpawn(reader));
        return;
      case ServerOp.ProjectileEnd:
        this.events.onProjectileEnd?.(decodeProjectileEnd(reader));
        return;
      default:
        console.warn(`[net] ignoring unknown opcode 0x${opcode.toString(16)}`);
    }
  }

  /**
   * Press LMB: mirror the server's shared chain rules against the predicted
   * state. Accepted → the request is sent and the caller gets the step to
   * animate NOW (prediction); dropped (too early / GCD) → null, exactly as
   * the server would drop or reject it.
   */
  requestBasicAttack(aimYaw: number, aimPitch: number): { step: number; def: ComboStep } | null {
    if (this.status !== 'playing' || this.selfDead) return null;
    if (this.predicted.rollTimeLeft > 0 || this.predicted.swimming) return null;
    // Content-sourced chain (P5): the SAME rows the server validates with —
    // panel-tuned step timing stays predicted correctly.
    const combo = this.basicChains[this.classId];
    const now = performance.now();
    let step = 0;
    if (this.comboStep >= 0 && this.comboStartedAtMs > 0) {
      const current = combo.steps[this.comboStep]!;
      const window = comboWindow(
        current,
        now - this.comboStartedAtMs,
        COMBO_LINK_WINDOW_FRACTION,
        COMBO_RESET_MS,
      );
      if (window === 'too_early') return null;
      if (window === 'link') step = (this.comboStep + 1) % combo.steps.length;
    }
    if (now < this.gcdUntilMs && step === 0) return null;

    this.comboStep = step;
    this.comboStartedAtMs = now;
    this.gcdUntilMs = now + GCD_MS;
    if (this.isOpen) {
      this.attackSeq = (this.attackSeq + 1) & 0xffff;
      this.sendRaw(
        encodeAbilityRequest({
          seq: this.attackSeq,
          action: ActionId.BasicAttack,
          aimYaw,
          aimPitch,
          targetId: 0,
          groundAim: null,
        }),
      );
    }
    return { step, def: combo.steps[step]! };
  }

  /** Dodge cancels the predicted chain (the server does the same). */
  cancelPredictedCombo(): void {
    this.comboStep = -1;
    this.comboStartedAtMs = 0;
  }

  // -------------------------------------------------------------------------
  // Slot abilities (protocol v7) — predicted through the shared machine
  // -------------------------------------------------------------------------

  /**
   * Adopt the published ability defs (fetched from /api/content/abilities).
   * Everything prediction needs derives here: the own-class hotbar, the
   * content-sourced basic chains, and the effectId → movement-mod index that
   * keeps a buffed player's prediction in step with the server.
   */
  setAbilityContent(defs: readonly AbilityDef[]): void {
    this.abilityDefs.clear();
    this.effectSpeedPct.clear();
    this.effectDodgeDelta.clear();
    for (const def of defs) {
      this.abilityDefs.set(def.id, def);
      for (const effect of def.effects) {
        if (effect.kind !== 'apply_effect') continue;
        if (effect.mods.moveSpeedPct !== undefined) {
          this.effectSpeedPct.set(effect.effectId, effect.mods.moveSpeedPct);
        }
        if (effect.mods.dodgeCostDelta !== undefined) {
          this.effectDodgeDelta.set(effect.effectId, effect.mods.dodgeCostDelta);
        }
      }
    }
    const chains = buildBasicChains(defs);
    if (chains) this.basicChains = chains;
    this.rebuildSlotDefs();
  }

  /** Own hotbar: slot → published def for the player's class. */
  private rebuildSlotDefs(): void {
    this.slotDefs.clear();
    for (const def of this.abilityDefs.values()) {
      if (def.classId === this.classId && def.binding.kind === 'slot') {
        this.slotDefs.set(def.binding.slot, def);
      }
    }
  }

  /** Any class's slot def — remote players' ability anims resolve through this. */
  abilityDefFor(classId: ClassId, slot: number): AbilityDef | undefined {
    for (const def of this.abilityDefs.values()) {
      if (def.classId === classId && def.binding.kind === 'slot' && def.binding.slot === slot) {
        return def;
      }
    }
    return undefined;
  }

  /**
   * Press hotbar key 1–8: the EXACT evaluate → commit the server runs, against
   * predicted state. Accepted → request on the wire + the def back so the
   * caller animates NOW; refused → the reject reason for the §3 red-seam pulse
   * (no round trip — same rules, same verdict).
   */
  requestSlotAbility(
    slot: number,
    aimYaw: number,
    aimPitch: number,
    target: { id: number; radius: number } | null,
  ):
    | { ok: true; def: AbilityDef; phase: 'instant' | 'cast' | 'channel'; contactDelayMs: number }
    | { ok: false; reason: AbilityRejectReason | null } {
    const def = this.slotDefs.get(slot);
    if (!def) return { ok: false, reason: null };
    if (this.status !== 'playing') return { ok: false, reason: null };
    if (this.predicted.rollTimeLeft > 0 || this.predicted.swimming) {
      return { ok: false, reason: AbilityRejectReason.BadState };
    }
    const targetId = target?.id ?? 0;
    const verdict = evaluateUse(this.abilityMachine, def, {
      level: this.selfLevel,
      alive: !this.selfDead,
      resource: this.resource,
      hasTarget: targetId > 0,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    // Mirror the server's order exactly: finisher CP measured before commit.
    if (def.comboFinisher) spendComboPoints(this.resource);
    const commit = commitUse(this.abilityMachine, def, this.resource, {
      yaw: aimYaw,
      pitch: aimPitch,
      targetId,
    });
    // Snapshots that predate the server consuming this request must not
    // bounce the paid cost back onto the globe (one round trip + slack).
    this.resourceHoldUntilMs = performance.now() + Math.max(120, this.rttMs * 1.5) + 150;

    const now = performance.now();
    let contactDelayMs = commit.contactDelayMs;
    if (def.targeting.kind === 'dash') {
      // Charge: the dash lives in the shared movement state, so prediction
      // carries the body exactly like the server will. Replay can't re-trigger
      // it (it's not an input), so corrections hold for the flight.
      beginDash(
        this.predicted,
        Math.sin(aimYaw),
        Math.cos(aimYaw),
        def.targeting.distance,
        def.targeting.speed,
      );
      contactDelayMs = this.predicted.dashTimeLeft * 1000;
      this.correctionHoldUntilMs = now + contactDelayMs + this.rttMs + 150;
    } else if (def.targeting.kind === 'blink_behind') {
      this.predictBlink(def.targeting.maxRange, aimYaw, target);
      this.correctionHoldUntilMs = now + this.rttMs + 150;
    }

    // Swing-time move slow (Whirlwind-style): the server keeps it up while the
    // ability is pending — for pulse trains that spans the whole train.
    if (def.anim.moveSpeedMult < 1 && commit.phase === 'instant') {
      const pulses =
        def.targeting.kind === 'pbaoe'
          ? (def.targeting.ticks.count - 1) * def.targeting.ticks.everyMs
          : 0;
      this.abilityMoveMult = def.anim.moveSpeedMult;
      this.abilityMoveMultUntilMs = now + contactDelayMs + pulses;
    }

    if (this.isOpen) {
      this.attackSeq = (this.attackSeq + 1) & 0xffff;
      this.sendRaw(
        encodeAbilityRequest({
          seq: this.attackSeq,
          action: actionForSlot(slot),
          aimYaw,
          aimPitch,
          targetId,
          groundAim: null, // ground_aoe aim wiring lands with the P6-D reticle
        }),
      );
    }
    return { ok: true, def, phase: commit.phase, contactDelayMs };
  }

  /**
   * Predict Shadowstep's teleport against the interpolated view of the target
   * (same fallback rules as the server). The enemy the server sees is up to an
   * interpolation delay ahead of ours — for our walking-speed grunts that is
   * centimetres, and the post-blink correction hold absorbs it.
   */
  private predictBlink(
    maxRange: number,
    aimYaw: number,
    target: { id: number; radius: number } | null,
  ): void {
    const m = this.predicted;
    let destX = m.x + Math.sin(aimYaw) * Math.min(4, maxRange);
    let destZ = m.z + Math.cos(aimYaw) * Math.min(4, maxRange);
    const remote = target ? this.remotes.get(target.id) : undefined;
    if (remote && target) {
      const dist = Math.hypot(remote.render.x - m.x, remote.render.z - m.z);
      if (dist <= maxRange) {
        const back = target.radius + 0.7;
        destX = remote.render.x - Math.sin(remote.render.yaw) * back;
        destZ = remote.render.z - Math.cos(remote.render.yaw) * back;
      }
    }
    if (!this.terrain.walkableAt || this.terrain.walkableAt(destX, destZ)) {
      m.x = destX;
      m.z = destZ;
      m.y = this.terrain.heightAt(destX, destZ);
      m.vx = 0;
      m.vz = 0;
    }
  }

  /**
   * The movement modifiers in force right now — the client half of the
   * server's per-intent computation (effects × Evasive × swing slow). Stored
   * per pending input so replays step identically.
   */
  private modifiersNow(secondaryHeld: boolean): MovementModifiers {
    const now = performance.now();
    let speedMult = 1;
    let dodgeCostDelta = 0;
    const effects = this.effectLists.get(this.selfId);
    if (effects) {
      for (const effect of effects) {
        const pct = this.effectSpeedPct.get(effect.effectId);
        if (pct !== undefined) speedMult *= 1 + pct / 100;
        const delta = this.effectDodgeDelta.get(effect.effectId);
        if (delta !== undefined) dodgeCostDelta += delta;
      }
    }
    const evasive = secondaryHeld && this.classId === 'rogue' && this.resource.value >= 1;
    if (evasive) {
      speedMult *= 1 + EVASIVE_MOVE_SPEED_PCT / 100;
      dodgeCostDelta -= EVASIVE_DODGE_DISCOUNT;
    }
    if (now < this.abilityMoveMultUntilMs) speedMult *= this.abilityMoveMult;
    return { speedMult, dodgeCostDelta };
  }

  // --- HUD state (polled per frame) ----------------------------------------

  /** Hotbar slot view-model: def, cooldown, GCD, affordability, lock. */
  slotView(slot: number): SlotView {
    const def = this.slotDefs.get(slot) ?? null;
    if (!def) {
      return {
        slot,
        def: null,
        cooldownMs: 0,
        cooldownTotalMs: 0,
        gcdMs: 0,
        affordable: false,
        lockedUntilLevel: 0,
      };
    }
    const machine = this.abilityMachine;
    return {
      slot,
      def,
      cooldownMs: cooldownRemainingMs(machine, def.id),
      cooldownTotalMs: def.cooldownMs,
      gcdMs: def.onGcd ? Math.max(0, machine.gcdUntilMs - machine.nowMs) : 0,
      affordable:
        canAfford(this.resource, def.cost.type, def.cost.amount) &&
        (!def.comboFinisher || this.resource.comboPoints > 0),
      lockedUntilLevel: this.selfLevel < def.unlockLevel ? def.unlockLevel : 0,
    };
  }

  /** Active cast for the bar (null = none; all P5 kits are instants). */
  castView(): { name: string; fraction: number; remainingMs: number } | null {
    const cast = this.abilityMachine.cast;
    if (!cast) return null;
    const elapsed = this.abilityMachine.nowMs - cast.startedAtMs;
    return {
      name: this.abilityDefs.get(cast.abilityId)?.name ?? '',
      fraction: Math.min(1, elapsed / cast.castMs),
      remainingMs: Math.max(0, cast.castMs - elapsed),
    };
  }

  /** Authoritative buff/debuff list for an entity (self, target plates). */
  effectsFor(entityId: number): readonly EffectSyncEntry[] {
    return this.effectLists.get(entityId) ?? [];
  }

  /** Whether the predicted stamina covers a dodge right now (V indicator). */
  dodgeReady(secondaryHeld: boolean): boolean {
    const cost = DODGE_STAMINA_COST + (this.modifiersNow(secondaryHeld).dodgeCostDelta ?? 0);
    return !this.selfDead && this.predicted.stamina >= cost;
  }

  /** Client mirror of the server's OOC window (COMBAT.md §6.6). */
  inCombat(): boolean {
    return performance.now() - this.lastCombatAtMs <= OOC_AFTER_MS;
  }

  /** Soul-screen button: ask to respawn (valid only while dead). */
  requestRespawn(): void {
    if (!this.isOpen || !this.selfDead) return;
    this.attackSeq = (this.attackSeq + 1) & 0xffff;
    this.sendRaw(
      encodeAbilityRequest({
        seq: this.attackSeq,
        action: ActionId.Respawn,
        aimYaw: 0,
        aimPitch: 0,
        targetId: 0,
        groundAim: null,
      }),
    );
  }

  /** Enemy identity for an entity id, once its EnemyMeta arrived. */
  enemyMetaFor(id: number): EnemyMetaEntry | undefined {
    return this.enemyMetas.get(id);
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

    // 1b. Vitals + death are authoritative-only — never predicted (v6).
    this.selfHp = self.hp;
    this.selfMaxHp = self.maxHp;
    this.selfFlags = self.flags;
    const deadNow = (self.flags & EntityFlag.Dead) !== 0;
    if (deadNow && !this.selfDead) this.cancelPredictedCombo();
    this.selfDead = deadNow;

    // 1b-ii. Resource re-base (v7). The wire carries the floor; adopting it
    // blindly every 50 ms would discard the fractional regen the prediction
    // accumulates between snapshots (0.6 energy/tick can never reach 1). So
    // adopt only when the FLOORS disagree — that's a real server-side change
    // (a hit built Rage, a rider fired, a cost we didn't predict) — and never
    // adopt UP while a predicted spend is still in flight (see the hold doc).
    const holdingSpend = performance.now() < this.resourceHoldUntilMs;
    const predictedFloor = Math.floor(this.resource.value);
    if (predictedFloor !== self.resource && !(holdingSpend && self.resource > predictedFloor)) {
      this.resource.value = self.resource;
    }
    if (!(holdingSpend && self.comboPoints > this.resource.comboPoints)) {
      this.resource.comboPoints = self.comboPoints;
    }

    // 1c. While dead the server parks the body and ignores inputs — predicting
    // would only rubber-band. Adopt verbatim; run-world stops the sim too.
    if (deadNow) {
      this.pendingInputs.length = 0;
      cloneInto(this.predicted, this.authoritative);
      this.correction.x = 0;
      this.correction.y = 0;
      this.correction.z = 0;
      this.correction.remainingMs = 0;
      this.bufferRemotes(snapshot);
      return;
    }

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

    // 3. Replay what it hasn't consumed yet, from the authoritative state —
    // each input with the modifiers it was originally predicted under.
    cloneInto(this.replayScratch, this.authoritative);
    for (const pending of this.pendingInputs) {
      stepMovement(this.replayScratch, pending.intent, TICK_DT, this.terrain, pending.modifiers);
    }

    // 4. Compare with what we predicted and correct smoothly (or snap).
    const errorX = this.replayScratch.x - this.predicted.x;
    const errorY = this.replayScratch.y - this.predicted.y;
    const errorZ = this.replayScratch.z - this.predicted.z;
    const error = Math.sqrt(errorX * errorX + errorY * errorY + errorZ * errorZ);
    this.stats.lastCorrectionM = error;

    // 4b. Dash/blink hold: ability-initiated movement isn't in the replayed
    // inputs, so for one round trip the replay disagrees by design. Trust the
    // prediction unless the gap is beyond anything a kit can move us (a real
    // desync or a server-side teleport we didn't predict).
    if (performance.now() < this.correctionHoldUntilMs && error < 8) {
      this.bufferRemotes(snapshot);
      return;
    }

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

    // 6. Buffer remote entities for interpolation (players and enemies alike).
    const time = snapshot.serverTimeMs;
    for (const entity of snapshot.entities) {
      let remote = this.remotes.get(entity.id);
      if (!remote) {
        const meta = this.enemyMetas.get(entity.id);
        remote = {
          id: entity.id,
          kind: entity.kind,
          name: meta?.name ?? this.nameFor(entity.id),
          samples: [],
          render: {
            x: entity.x,
            y: entity.y,
            z: entity.z,
            yaw: entity.yaw,
            flags: entity.flags,
            hpFraction: entity.hpFraction,
          },
          ...(meta ? { enemyMeta: meta } : {}),
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
        hpFraction: entity.hpFraction,
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
    // The exact modifier math the server runs per intent (world.step §1),
    // captured with the input so replays walk the same ground.
    const secondaryHeld = (intent.buttons & InputButton.SecondaryAction) !== 0;
    const modifiers = this.modifiersNow(secondaryHeld);
    // Evasive drains predicted Energy exactly like the server (re-based from
    // every snapshot, so a mispredict self-heals within 50 ms).
    if (secondaryHeld && this.classId === 'rogue' && this.resource.value >= 1) {
      this.resource.value = Math.max(0, this.resource.value - EVASIVE_ENERGY_PER_S * TICK_DT);
    }

    this.inputSeq = (this.inputSeq + 1) & 0xffff;
    const record: PendingInput = { seq: this.inputSeq, intent: { ...intent }, modifiers };
    this.pendingInputs.push(record);
    // Bound the buffer: a very long stall should not replay thousands of steps.
    if (this.pendingInputs.length > 120) this.pendingInputs.shift();

    const result = stepMovement(this.predicted, intent, TICK_DT, this.terrain, modifiers);
    if (result.dodged) {
      // Dodge cancels the chain AND an active cast for half its cost back —
      // the same §4.5 rule the server applies in its step.
      this.cancelPredictedCombo();
      const casting = this.abilityMachine.cast;
      if (casting) {
        const castDef = this.abilityDefs.get(casting.abilityId);
        const interrupted = interruptCast(this.abilityMachine, 'dodge', castDef?.cost.amount ?? 0);
        if (interrupted.refund > 0) gainResource(this.resource, interrupted.refund, true);
      }
    }

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

    // Ability machine time: cooldown refills, GCD, cast completion — the same
    // tick the server runs at 20 Hz, here at frame rate (both sides only
    // compare against accumulated nowMs, so the cadence difference is safe).
    if (this.status === 'playing') {
      const moving = Math.abs(this.predicted.vx) > 0.05 || Math.abs(this.predicted.vz) > 0.05;
      tickAbilityMachine(this.abilityMachine, dtMs, moving);
      // Resource regen/decay between snapshots — same shared formula, with a
      // client-tracked combat clock (resolves/flinches mark it below). The
      // floor re-base on every snapshot keeps any drift under one unit.
      tickResource(this.resource, dtMs, this.inCombat());
    }

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
        remote.render.hpFraction = only.hpFraction;
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
      remote.render.hpFraction = newer.hpFraction;
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
