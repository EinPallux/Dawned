/**
 * Client networking: handshake, clock sync, prediction/reconciliation and remote
 * entity interpolation (docs/tech/NETWORKING.md §3–§4).
 *
 * The golden rule: this module never invents authoritative state. It predicts with
 * the shared movement step, then corrects itself against every snapshot.
 */

import {
  createReelState,
  encodeGatherOp,
  encodeInteractOp,
  encodeQuestOp,
  fishPosition,
  reelStep,
  type FishingStateMessage,
  type GatherOp,
  type GatherStateMessage,
  type DialogueStateMessage,
  type DiscoverySyncMessage,
  type InteractOp,
  type InteractStateMessage,
  type NodeStatesMessage,
  type QuestNoticeMessage,
  type QuestOp,
  type QuestSyncMessage,
  type ProfessionSyncMessage,
  type ReelState,
} from '@dawned/shared';
import {
  AbilityRejectReason,
  ActionId,
  ARCANE_SURGE_EFFECT,
  ATTUNEMENT_EVERY,
  BASIC_COMBOS,
  BinaryReader,
  DODGE_STAMINA_COST,
  dodgeCostOf,
  dodgeRefusal,
  FLURRY_EFFECT,
  EVASIVE_DODGE_DISCOUNT,
  EVASIVE_ENERGY_PER_S,
  EVASIVE_MOVE_SPEED_PCT,
  FOCUS_MOVE_SPEED_MULT,
  GRACE_CAST_REDUCTION_MS,
  GRACE_CONSUMER_ABILITY,
  GRACE_EFFECT_ID,
  InputButton,
  type DodgeRefusal,
  OOC_AFTER_MS,
  SPRINT_STAMINA_PER_SEC,
  actionForSlot,
  aggregateNodeEffects,
  beginDash,
  buildBasicChains,
  buildEffectiveDefs,
  canAfford,
  canAllocateNode,
  commitUse,
  cooldownRemainingMs,
  createAbilityMachine,
  createResourceState,
  decodeLevelUp,
  decodeXpGained,
  emptyNodeAggregates,
  encodeAllocateSkill,
  encodeAllocateStats,
  encodeRespec,
  evaluateUse,
  gainResource,
  importCooldowns,
  interruptCast,
  neutralResourceMods,
  playerStats,
  rebuildResourceMax,
  respecCost,
  RespecWireKind,
  slotForAction,
  spendComboPoints,
  tickAbilityMachine,
  tickResource,
  zeroAttributes,
  COMBO_LINK_WINDOW_FRACTION,
  COMBO_RESET_MS,
  EntityEventKind,
  EntityFlag,
  GCD_MS,
  INTERP_DELAY_MS,
  NoticeCode,
  PROTOCOL_VERSION,
  ProtocolError,
  ServerOp,
  TICK_DT,
  cloneMovementState,
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
  encodeItemOp,
  encodePing,
  noticeTextFor,
  peekOpcode,
  stepMovement,
  type AbilityDef,
  type AbilityResolveMessage,
  type AbilityStartMessage,
  type AbilityStateMessage,
  type AttributeSpread,
  type ComboChain,
  type EffectSyncEntry,
  type EffectSyncMessage,
  type InventorySyncMessage,
  type ItemDef,
  type ItemNoticeMessage,
  type ItemOp,
  type LootBagsMessage,
  type VendorPanelMessage,
  type WireLootBag,
  type LevelUpMessage,
  type NodeAggregates,
  type ProgressSyncMessage,
  type RespecKind,
  type ResourceMods,
  type ResourceState,
  type SkillNodeDef,
  type XpGainedMessage,
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
  // --- progression (protocol v9) --------------------------------------------
  /** An XP award landed on us — FCT "+N XP" + bar tick (run-world). */
  onXpGained?: (message: XpGainedMessage) => void;
  /** Somebody leveled: self runs the §1.3 juice, remotes get the pillar. */
  onLevelUp?: (message: LevelUpMessage, oldLevel: number) => void;
  // --- items (protocol v10) -------------------------------------------------
  /** Bag traffic worth a toast: pickups, sales, refusals in words. */
  onItemNotice?: (message: ItemNoticeMessage) => void;
  /** The bags we can see changed — the world re-props them. */
  onLootBags?: (message: LootBagsMessage) => void;
  /** A vendor opened (or closed, when null) — the React panel follows. */
  onVendorPanel?: (panel: VendorPanelMessage | null) => void;
  // --- gathering (protocol v13) ---------------------------------------------
  /** Which nearby nodes are taken — the world swaps their models. */
  onNodeStates?: (message: NodeStatesMessage) => void;
  /** Our gather channel opened, finished, was cancelled or refused. */
  onGatherState?: (message: GatherStateMessage) => void;
  /** Our fishing attempt moved on — cast, bite, reel, caught, lost. */
  onFishingState?: (message: FishingStateMessage) => void;
  /** Profession levels and codex changed (level-up, first-ever material). */
  onProfessionSync?: (message: ProfessionSyncMessage) => void;
  // --- quests, POIs & interactables (protocol v14) --------------------------
  /** A quest beat worth saying out loud: accepted, step done, turned in. */
  onQuestNotice?: (message: QuestNoticeMessage) => void;
  /** The conversation opened, moved on, or closed (`open: null`). */
  onDialogueState?: (message: DialogueStateMessage) => void;
  /**
   * Something was discovered — a POI ring entered for the first time. Fired
   * with the NEW ids only, because the banner is about what just happened and
   * `DiscoverySync` carries the whole set for the map's fog.
   */
  onDiscovered?: (kind: 'poi' | 'zone' | 'shrine', ids: readonly string[]) => void;
  /** A read or a refusal from the last `F` — the HUD line. */
  onInteractNotice?: (notice: { objectId: string; text: string; kind: string }) => void;
  /**
   * The whole spent/attuned set, EVERY time it changes.
   *
   * Separate from `onInteractNotice` because a notice is optional: the message
   * that tells you a chest is now empty, or that a respawn has un-emptied it,
   * usually carries no line at all.
   */
  onInteractState?: (message: InteractStateMessage) => void;
  /**
   * The quest log changed. Separate from the panel subscription because the
   * HUD tracker and the NPC glyphs are not React — they need a callback, not a
   * `useSyncExternalStore` snapshot, and re-deriving them per frame to avoid
   * one callback would be paying 60 Hz for a message that lands twice a minute.
   */
  onQuestSyncChanged?: () => void;
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

/**
 * Something the shared machine did between frames (P6): a cast released, a
 * channel ticked/ended, or movement broke the cast. Drained once per frame by
 * run-world, which owns the presentation (release anim, VFX, refusal words) —
 * the connection only times.
 */
export interface MachineEvent {
  kind: 'released' | 'channel-tick' | 'channel-ended' | 'move-canceled';
  def: AbilityDef | null;
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
  /** Own character level (Welcome/LevelUp/ProgressSync) — unlock gating mirrors the server. */
  selfLevel = 1;

  // --- progression (protocol v9) --------------------------------------------
  /**
   * The authoritative self sheet (ProgressSync), plus the optimistic edits an
   * allocation click applies while its request is in flight. Every arriving
   * sync adopts wholesale — mispredictions live for one round trip at most.
   */
  sheet: ProgressSyncMessage | null = null;
  /** Published skill-node defs (fetched from /api/content/skill-nodes). */
  readonly skillNodeDefs = new Map<string, SkillNodeDef>();
  /** Own allocated ranks as a Map (the shared helpers' shape). */
  private readonly nodeRanks = new Map<string, number>();
  /** Folded tree: the same aggregates the server folds server-side. */
  aggregates: NodeAggregates = emptyNodeAggregates();
  /** Node-rewritten defs for OWN abilities (buildEffectiveDefs — both sides). */
  private effectiveDefs = new Map<string, AbilityDef>();
  /** Derived stats at (class, level, allocation) — stamina regen, INT pool. */
  private selfStats = playerStats('warrior', 1);
  /** effectId → attack-speed % (Flurry, Killer's Rhythm — basics timing). */
  private readonly effectAttackSpeedPct = new Map<string, number>();
  /** Panels re-render on any progression change (React subscribes here). */
  private readonly progressListeners = new Set<() => void>();
  // --- items (protocol v10) --------------------------------------------------
  /**
   * The authoritative pack. There is no client-side prediction here: a drag
   * asks, the server answers with a whole new sync, and 20 Hz is fast enough
   * that the grid feels immediate without a rollback layer to get wrong.
   */
  inventory: InventorySyncMessage | null = null;
  /** Loot bags we hold a share in, as the server last described them. */
  lootBags: WireLootBag[] = [];
  /** The open vendor panel, or null when no conversation is running. */
  vendorPanel: VendorPanelMessage | null = null;
  /** Published item defs (fetched from /api/content/items). */
  readonly itemDefs = new Map<string, ItemDef>();
  private readonly itemListeners = new Set<() => void>();
  itemVersion = 0;
  /** Monotonic change counter — the React panels' useSyncExternalStore
   * snapshot (the sheet object itself mutates in place between syncs). */
  progressVersion = 0;
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
  /** Machine happenings since the last frame (see {@link MachineEvent}). */
  private readonly machineEvents: MachineEvent[] = [];
  /**
   * Mage Attunement mirror: landed basic bolts mod 3 (COMBAT/CLASSES P6).
   * Cosmetic pips only — the mana refund itself arrives via snapshot re-base,
   * so a rare miscount never desyncs anything that matters.
   */
  attunementCount = 0;
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
    this.abilityMachine.channel = null;
    this.machineEvents.length = 0;
    this.attunementCount = 0;
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

  // --- gathering (protocol v13) --------------------------------------------
  /** Our open gather channel; null between holds. */
  private gather: GatherStateMessage | null = null;
  /** Our fishing attempt; null between casts. */
  private fishing: FishingStateMessage | null = null;
  /** The reel bar's marker/progress — ours to simulate, the server corrects. */
  private reel: ReelState = createReelState();
  private reelSteppedAt = 0;
  /** Which reel the local bar belongs to, so a correction never restarts it. */
  private reelStartedAtMs = 0;
  /** Four profession levels + the codex, from the last ProfessionSync. */
  private professions: ProfessionSyncMessage | null = null;
  /** The depleted-node exception list, from the last NodeStates. */
  private nodeStates: NodeStatesMessage | null = null;

  // --- quests (protocol v14) ------------------------------------------------
  /**
   * The whole quest log, the open conversation, what we have discovered and
   * which objects are spent — all of it straight from the server.
   *
   * There is deliberately no derived state here and no optimistic anything: a
   * quest log is the single thing a player would most like to author
   * themselves, so every op is a request and the next sync is the answer. That
   * is P8's item rule, for the same reason.
   */
  private quests: QuestSyncMessage | null = null;
  private dialogue: DialogueStateMessage | null = null;
  private discovery: DiscoverySyncMessage | null = null;
  private interactState: InteractStateMessage | null = null;
  private readonly questListeners = new Set<() => void>();
  private questVersion = 0;

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
        // Resource pool sized like the server sizes it (class + INT at level);
        // the ProgressSync right behind this refines it with allocation+nodes.
        Object.assign(
          this.resource,
          createResourceState(this.classId, playerStats(this.classId, this.selfLevel).int),
        );
        this.rebuildProgressionFolds();
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
        // Attunement pips: the server counts our LANDED basic bolts the same
        // way (combat.ts) — every third one refunds mana + shaves cooldowns.
        if (
          this.classId === 'mage' &&
          resolve.attackerId === this.selfId &&
          resolve.action === (ActionId.BasicAttack as number) &&
          resolve.hits.length > 0
        ) {
          this.attunementCount = (this.attunementCount + 1) % ATTUNEMENT_EVERY;
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
            // A rejected CAST/CHANNEL press must also drop the predicted bar —
            // otherwise the client "casts" a spell the server never started
            // and the release fires pure fiction (P6).
            if (
              this.abilityMachine.cast?.abilityId === def.id ||
              this.abilityMachine.channel?.abilityId === def.id
            ) {
              interruptCast(this.abilityMachine, 'stun', 0);
            }
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
          if (message.event === (EntityEventKind.Interrupted as number)) {
            // A stun broke our cast server-side (P6): mirror it on the local
            // machine — no refund, the server kept the cost — and drop the
            // predicted chain like the server's applyCcToPlayer does.
            interruptCast(this.abilityMachine, 'stun', 0);
            this.cancelPredictedCombo();
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
      case ServerOp.ProgressSync: {
        // The authoritative sheet: initial state AND the correction that heals
        // any mispredicted allocation click. Adopt wholesale, re-fold.
        const sync = decodeJsonEnvelope<ProgressSyncMessage>(reader);
        this.sheet = sync;
        this.selfLevel = sync.level;
        this.nodeRanks.clear();
        for (const [nodeId, rank] of Object.entries(sync.nodes)) {
          if (rank > 0) this.nodeRanks.set(nodeId, rank);
        }
        this.rebuildProgressionFolds();
        this.notifyProgress();
        return;
      }
      case ServerOp.XpGained: {
        const gained = decodeXpGained(reader);
        // The message carries the ABSOLUTE bar position — a dropped packet can
        // never desync the bar, and level here always trails LevelUp's own.
        if (this.sheet) {
          this.sheet.xp = gained.xp;
          this.sheet.level = gained.level;
        }
        this.events.onXpGained?.(gained);
        this.notifyProgress();
        return;
      }
      case ServerOp.LevelUp: {
        const levelUp = decodeLevelUp(reader);
        const oldLevel = levelUp.entityId === this.selfId ? this.selfLevel : 0;
        if (levelUp.entityId === this.selfId) {
          this.selfLevel = levelUp.level;
          if (this.sheet) this.sheet.level = levelUp.level;
          // Derived pools resize now (the follow-up ProgressSync brings the
          // banked points; HP/stamina/resource refills ride the snapshot).
          this.rebuildProgressionFolds();
          this.notifyProgress();
        }
        this.events.onLevelUp?.(levelUp, oldLevel);
        return;
      }
      // --- items (protocol v10) ---------------------------------------------
      case ServerOp.InventorySync: {
        // Adopt wholesale: this is both the initial pack and the correction
        // that heals a drag the server refused.
        this.inventory = decodeJsonEnvelope<InventorySyncMessage>(reader);
        this.notifyItems();
        return;
      }
      case ServerOp.LootBags: {
        const message = decodeJsonEnvelope<LootBagsMessage>(reader);
        this.lootBags = message.bags;
        this.events.onLootBags?.(message);
        this.notifyItems();
        return;
      }
      case ServerOp.VendorPanel: {
        const panel = decodeJsonEnvelope<VendorPanelMessage>(reader);
        this.vendorPanel = panel.open ? panel : null;
        this.events.onVendorPanel?.(this.vendorPanel);
        this.notifyItems();
        return;
      }
      case ServerOp.ItemNotice: {
        this.events.onItemNotice?.(decodeJsonEnvelope<ItemNoticeMessage>(reader));
        return;
      }
      case ServerOp.NodeStates: {
        const message = decodeJsonEnvelope<NodeStatesMessage>(reader);
        this.nodeStates = message;
        this.events.onNodeStates?.(message);
        return;
      }
      case ServerOp.GatherState: {
        const message = decodeJsonEnvelope<GatherStateMessage>(reader);
        // `start` is the only phase that leaves a channel standing; every
        // other one closes it, so the bar can never outlive the hold.
        this.gather = message.phase === 'start' ? message : null;
        this.events.onGatherState?.(message);
        return;
      }
      case ServerOp.FishingState: {
        const message = decodeJsonEnvelope<FishingStateMessage>(reader);
        this.fishing = message.phase === 'caught' || message.phase === 'escaped' ? null : message;
        // Restart the local bar when a NEW reel opens — keyed on the reel's
        // start time, not on the seed being present. The periodic correction
        // carries the seed as well, so keying on the seed reset the marker to
        // the middle and the progress to zero several times a second: the bar
        // could not be won at all, which is the same failure the shared
        // fishing tests were written for, on this side of the wire.
        if (message.phase === 'reeling' && message.startedAtMs !== this.reelStartedAtMs) {
          this.reelStartedAtMs = message.startedAtMs ?? 0;
          this.reel = createReelState();
          this.reelSteppedAt = performance.now();
        }
        this.events.onFishingState?.(message);
        return;
      }
      case ServerOp.ProfessionSync: {
        const message = decodeJsonEnvelope<ProfessionSyncMessage>(reader);
        this.professions = message;
        this.events.onProfessionSync?.(message);
        return;
      }
      case ServerOp.QuestSync: {
        this.quests = decodeJsonEnvelope<QuestSyncMessage>(reader);
        this.events.onQuestSyncChanged?.();
        this.notifyQuests();
        return;
      }
      case ServerOp.QuestNotice: {
        this.events.onQuestNotice?.(decodeJsonEnvelope<QuestNoticeMessage>(reader));
        return;
      }
      case ServerOp.DialogueState: {
        const message = decodeJsonEnvelope<DialogueStateMessage>(reader);
        this.dialogue = message.open ? message : null;
        this.events.onDialogueState?.(message);
        this.notifyQuests();
        return;
      }
      case ServerOp.DiscoverySync: {
        const message = decodeJsonEnvelope<DiscoverySyncMessage>(reader);
        // Diff against what we already knew so the BANNER is about what just
        // happened. The message itself is the whole set — it has to be, because
        // it is also the map's fog — so a client that announced everything it
        // received would replay every discovery on relog.
        const previous = this.discovery;
        this.discovery = message;
        if (previous) {
          const fresh = (before: readonly string[], after: readonly string[]): string[] => {
            const seen = new Set(before);
            return after.filter((id) => !seen.has(id));
          };
          const pois = fresh(previous.pois, message.pois);
          const zones = fresh(previous.zones, message.zones);
          const shrines = fresh(previous.shrines, message.shrines);
          if (pois.length > 0) this.events.onDiscovered?.('poi', pois);
          if (zones.length > 0) this.events.onDiscovered?.('zone', zones);
          if (shrines.length > 0) this.events.onDiscovered?.('shrine', shrines);
        }
        this.notifyQuests();
        return;
      }
      case ServerOp.InteractState: {
        const message = decodeJsonEnvelope<InteractStateMessage>(reader);
        this.interactState = message;
        this.events.onInteractState?.(message);
        if (message.notice) this.events.onInteractNotice?.(message.notice);
        this.notifyQuests();
        return;
      }
      default:
        console.warn(`[net] ignoring unknown opcode 0x${opcode.toString(16)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Progression (protocol v9) — the client half of the P7 fold
  // -------------------------------------------------------------------------

  /** Adopt the published skill-node defs (fetched once per world entry). */
  setSkillNodeContent(defs: readonly SkillNodeDef[]): void {
    this.skillNodeDefs.clear();
    for (const def of defs) this.skillNodeDefs.set(def.id, def);
    this.rebuildProgressionFolds();
    this.notifyProgress();
  }

  /** Panels/HUD subscribe for re-render on any progression change. */
  subscribeProgress(listener: () => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private notifyProgress(): void {
    this.progressVersion++;
    for (const listener of this.progressListeners) listener();
  }

  /** Adopt the published item catalogue (fetched once per world entry). */
  setItemContent(defs: ReadonlyMap<string, ItemDef>): void {
    this.itemDefs.clear();
    for (const [id, def] of defs) this.itemDefs.set(id, def);
    this.notifyItems();
  }

  /** The bag/vendor panels subscribe here (same shape as progression). */
  subscribeItems(listener: () => void): () => void {
    this.itemListeners.add(listener);
    return () => this.itemListeners.delete(listener);
  }

  private notifyItems(): void {
    this.itemVersion++;
    for (const listener of this.itemListeners) listener();
  }

  /**
   * Send one item intent. Every op is a REQUEST — the answer is the next
   * InventorySync, which is also how a refused drag heals itself.
   */
  sendItemOp(op: ItemOp): void {
    this.sendRaw(encodeItemOp(op));
  }

  /**
   * Send one gathering intent (P10). Same contract as an item op: a REQUEST,
   * never a prediction. Nothing about a gather is predicted — the claim, the
   * tier gate and the range are all the server's to decide, and the
   * GatherState that comes back is the answer.
   */
  sendGatherOp(op: GatherOp): void {
    this.sendRaw(encodeGatherOp(op));
  }

  /**
   * Send one interaction intent (v14) — press `F`, or take a shrine hop.
   *
   * A REQUEST, like every other op since P8. Note what the client does NOT
   * send: the verb. "Use this object" is the whole message; whether that opens
   * a chest, attunes a shrine or starts a conversation is the object's answer,
   * because a client that named the verb would be choosing it.
   */
  sendInteractOp(op: InteractOp): void {
    this.sendRaw(encodeInteractOp(op));
  }

  /** Send one quest intent (v14): accept, turn in, abandon, pin, or a choice. */
  sendQuestOp(op: QuestOp): void {
    this.sendRaw(encodeQuestOp(op));
  }

  /** Panels/HUD subscribe here for any quest, dialogue or discovery change. */
  subscribeQuests(listener: () => void): () => void {
    this.questListeners.add(listener);
    return () => this.questListeners.delete(listener);
  }

  private notifyQuests(): void {
    this.questVersion++;
    for (const listener of this.questListeners) listener();
  }

  questsVersion(): number {
    return this.questVersion;
  }

  /** The whole quest log, or null before the first sync. */
  get questLog(): QuestSyncMessage | null {
    return this.quests;
  }

  /** The open conversation, or null when nobody is talking. */
  get dialogueState(): DialogueStateMessage | null {
    return this.dialogue;
  }

  /** Zones, POIs and shrines this character has found — the map's fog. */
  get discoveryState(): DiscoverySyncMessage | null {
    return this.discovery;
  }

  /** Which objects are spent for us, and which shrines we are attuned to. */
  get interactStateMessage(): InteractStateMessage | null {
    return this.interactState;
  }

  /** Our open gather channel, or null. The HUD draws its bar from `endsAtMs`. */
  get gatherChannel(): GatherStateMessage | null {
    return this.gather;
  }

  /** Our fishing attempt, or null between casts. */
  get fishingState(): FishingStateMessage | null {
    return this.fishing;
  }

  /** The reel bar's local state — marker, progress, and the peak it reached. */
  get reelState(): ReelState {
    return this.reel;
  }

  /** Our four professions and their codex, or null before the first sync. */
  get professionState(): ProfessionSyncMessage | null {
    return this.professions;
  }

  /** The depleted-node exception list, for the world's model swaps. */
  get nodeStateMessage(): NodeStatesMessage | null {
    return this.nodeStates;
  }

  /**
   * Advance the reel bar one frame.
   *
   * Run from the render loop rather than the 20 Hz tick because it is what the
   * player is LOOKING at: a marker that moves five times a second reads as
   * broken input. The server steps the same function on its own tick with the
   * held-button state off the input stream and sends `progress` as a
   * correction, so this can be smooth without being authoritative.
   */
  stepReel(holding: boolean, nowMs: number): void {
    const state = this.fishing;
    if (!state || state.phase !== 'reeling' || state.startedAtMs === undefined) return;
    const sinceMs = Math.min(1000, nowMs - this.reelSteppedAt);
    this.reelSteppedAt = nowMs;
    if (sinceMs <= 0) return;
    const drift = {
      driftSpeed: state.driftSpeed ?? 0.18,
      markerHalf: state.markerHalf ?? 0.16,
    };
    // Sub-step long frames instead of clamping them away. The FISH moves on
    // wall-clock time, so a client that clamped a 250 ms frame to 120 ms
    // advanced its marker at half speed and fell behind a fish it could see —
    // the bar stops being winnable below roughly 8 fps, which is a hitch
    // costing a catch rather than the player missing one. Slicing keeps the
    // physics stable AND the elapsed time honest.
    const slices = Math.max(1, Math.ceil(sinceMs / 40));
    const sliceMs = sinceMs / slices;
    const endedAt = this.serverNow() - state.startedAtMs;
    for (let i = slices; i >= 1; i--) {
      const fish = fishPosition(state.seed ?? 0, endedAt - sliceMs * (i - 1), drift);
      this.reel = reelStep(this.reel, holding, sliceMs, fish, drift);
    }
    // The marker stays ours (it is input); the PROGRESS is the server's. But
    // converge on it rather than cloning it: the correction only arrives every
    // few ticks, so by the time it lands it describes a bar that has since
    // moved on, and snapping to it dragged a filling bar BACKWARDS at every
    // sync — a visible stutter, and a player watching their progress lurch
    // down while they are dead on the fish. A big divergence still snaps,
    // because that is a genuine disagreement rather than staleness.
    if (state.progress !== undefined) {
      const error = state.progress - this.reel.progress;
      if (Math.abs(error) > 0.3) this.reel = { ...this.reel, progress: state.progress };
      else if (Math.abs(error) > 0.02) {
        this.reel = { ...this.reel, progress: this.reel.progress + error * 0.25 };
      }
    }
  }

  /** Where the fish is right now, 0..1, or null when no bar is up. */
  get fishPositionNow(): number | null {
    const state = this.fishing;
    if (!state || state.phase !== 'reeling' || state.startedAtMs === undefined) return null;
    return fishPosition(state.seed ?? 0, this.serverNow() - state.startedAtMs, {
      driftSpeed: state.driftSpeed ?? 0.18,
      markerHalf: state.markerHalf ?? 0.16,
    });
  }

  /** Allocated attribute points (zero spread until the first sync). */
  get allocated(): AttributeSpread {
    return this.sheet?.allocated ?? zeroAttributes();
  }

  /** Own allocated ranks, in the shared helpers' Map shape. */
  get ranks(): ReadonlyMap<string, number> {
    return this.nodeRanks;
  }

  /**
   * Re-fold the allocated tree exactly like the server's rebuildNodeFolds:
   * aggregates → effective defs → derived stats (maxStamina, resource pool)
   * → the effect-mod indexes prediction reads per intent. Runs on sync,
   * content load, level-up and optimistic allocation clicks.
   */
  private rebuildProgressionFolds(): void {
    this.aggregates = aggregateNodeEffects(this.skillNodeDefs, this.nodeRanks);
    this.effectiveDefs = buildEffectiveDefs(this.abilityDefs, this.aggregates.abilityMods);
    this.selfStats = playerStats(this.classId, this.selfLevel, this.allocated);
    // Client-owned movement pool: the server sizes stamina the same way.
    this.predicted.maxStamina = this.selfStats.maxStamina;
    this.predicted.stamina = Math.min(this.predicted.stamina, this.predicted.maxStamina);
    // Resource pool: INT + node mods resize it (rebuildPlayerDerived mirror);
    // the VALUE stays put — refills arrive via snapshot re-base.
    rebuildResourceMax(
      this.resource,
      this.classId,
      this.selfStats.int,
      this.resourceModsNow(),
      false,
    );
    this.rebuildEffectModIndexes();
    this.rebuildSlotDefs();
  }

  /** Node resource mods, exactly as the server's resourceModsOf folds them. */
  private resourceModsNow(): ResourceMods | undefined {
    const stats = this.aggregates.stats;
    const mods = neutralResourceMods();
    if (this.resource.type === 'energy') {
      mods.maxFlat = stats.maxEnergyDelta;
      mods.regenFlat = stats.energyRegenDelta;
    } else if (this.resource.type === 'mana') {
      mods.maxPct = stats.maxManaPct;
      mods.regenPct = stats.manaRegenPct;
    }
    if (mods.maxFlat === 0 && mods.maxPct === 0 && mods.regenFlat === 0 && mods.regenPct === 0) {
      return undefined;
    }
    return mods;
  }

  /**
   * effectId → movement/attack-speed mods, scanned from the EFFECTIVE defs
   * (node addEffects included) plus node-granted buffs (on-kill/on-spend
   * procs, on-use grants) — so a Killer's Rhythm stack speeds the predicted
   * combo exactly like the server's.
   */
  private rebuildEffectModIndexes(): void {
    this.effectSpeedPct.clear();
    this.effectDodgeDelta.clear();
    this.effectAttackSpeedPct.clear();
    const index = (
      effectId: string,
      mods: {
        moveSpeedPct?: number | undefined;
        dodgeCostDelta?: number | undefined;
        attackSpeedPct?: number | undefined;
      },
    ): void => {
      if (mods.moveSpeedPct !== undefined) this.effectSpeedPct.set(effectId, mods.moveSpeedPct);
      if (mods.dodgeCostDelta !== undefined) {
        this.effectDodgeDelta.set(effectId, mods.dodgeCostDelta);
      }
      if (mods.attackSpeedPct !== undefined) {
        this.effectAttackSpeedPct.set(effectId, mods.attackSpeedPct);
      }
    };
    for (const def of this.abilityDefs.values()) {
      const effective = this.effectiveDefs.get(def.id) ?? def;
      for (const effect of effective.effects) {
        if (effect.kind === 'apply_effect') index(effect.effectId, effect.mods);
      }
    }
    for (const { proc } of this.aggregates.procs) {
      if (
        proc.proc === 'on_kill_buff' ||
        proc.proc === 'resource_spent_stacks' ||
        proc.proc === 'on_self_heal_buff'
      ) {
        index(proc.effectId, proc.mods);
      }
    }
    // Flurry (capstone): the server applies FLURRY_EFFECT with the node's
    // attackSpeedPct — index it so empowered basics predict at full speed.
    for (const modsList of this.aggregates.abilityMods.values()) {
      for (const mods of modsList) {
        if (mods.empowerBasics) {
          index(FLURRY_EFFECT, { attackSpeedPct: mods.empowerBasics.attackSpeedPct });
        }
      }
    }
  }

  /** The def OUR press runs: node-rewritten, else authored (server parity). */
  private effectiveDefOf(abilityId: string): AbilityDef | undefined {
    return this.effectiveDefs.get(abilityId) ?? this.abilityDefs.get(abilityId);
  }

  /** Attack-speed multiplier from live self effects (server attackSpeedMultOf). */
  private attackSpeedMultNow(): number {
    let mult = 1;
    const effects = this.effectLists.get(this.selfId);
    if (effects) {
      for (const effect of effects) {
        const pct = this.effectAttackSpeedPct.get(effect.effectId);
        if (pct !== undefined) mult *= 1 + pct / 100;
      }
    }
    return Math.max(0.25, mult);
  }

  /**
   * Spend banked attribute points (the C panel's Confirm). Optimistic: the
   * sheet and folds update NOW; the server validates with the same shared
   * rules and its ProgressSync confirms (or corrects) one round trip later.
   */
  sendAllocateStats(deltas: AttributeSpread): void {
    const total = deltas.str + deltas.agi + deltas.int + deltas.vit + deltas.end;
    if (!this.sheet || total < 1 || total > this.sheet.unspentStatPoints) return;
    if (!this.isOpen) return;
    this.sheet.unspentStatPoints -= total;
    this.sheet.allocated = {
      str: this.sheet.allocated.str + deltas.str,
      agi: this.sheet.allocated.agi + deltas.agi,
      int: this.sheet.allocated.int + deltas.int,
      vit: this.sheet.allocated.vit + deltas.vit,
      end: this.sheet.allocated.end + deltas.end,
    };
    this.rebuildProgressionFolds();
    this.sendRaw(encodeAllocateStats(deltas));
    this.notifyProgress();
  }

  /**
   * Put one rank into a node (the K panel's click). Runs the SAME shared
   * gate check the server enforces — a locally-refused click never hits the
   * wire; an accepted one folds immediately and syncs behind.
   */
  sendAllocateSkill(nodeId: string): { ok: boolean; reason?: string } {
    if (!this.sheet || !this.isOpen) return { ok: false, reason: 'no_sheet' };
    const verdict = canAllocateNode(
      this.skillNodeDefs,
      this.nodeRanks,
      nodeId,
      this.selfLevel,
      this.sheet.unspentSkillPoints,
    );
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    this.sheet.unspentSkillPoints -= 1;
    const next = (this.nodeRanks.get(nodeId) ?? 0) + 1;
    this.nodeRanks.set(nodeId, next);
    this.sheet.nodes[nodeId] = next;
    this.rebuildProgressionFolds();
    this.sendRaw(encodeAllocateSkill({ nodeId }));
    this.notifyProgress();
    return { ok: true };
  }

  /**
   * Mirror of Dawn respec (PROGRESSION.md §6). Not predicted — gold and the
   * full refund come back on the authoritative ProgressSync (rare, and a
   * wrongly-predicted wipe would feel far worse than 50 ms of waiting).
   */
  sendRespec(kind: RespecKind): void {
    if (!this.sheet || !this.isOpen) return;
    if (this.sheet.gold < respecCost(kind, this.selfLevel)) return;
    this.sendRaw(
      encodeRespec({ kind: kind === 'skills' ? RespecWireKind.Skills : RespecWireKind.Stats }),
    );
  }

  /**
   * Press LMB: mirror the server's shared chain rules against the predicted
   * state. Accepted → the request is sent and the caller gets the step to
   * animate NOW (prediction); dropped (too early / GCD) → null, exactly as
   * the server would drop or reject it.
   */
  requestBasicAttack(
    aimYaw: number,
    aimPitch: number,
  ): { step: number; def: ComboStep; durationMs: number } | null {
    if (this.status !== 'playing' || this.selfDead) return null;
    if (this.predicted.rollTimeLeft > 0 || this.predicted.swimming) return null;
    // Stunned gates attacks at request level, same as the server (P6).
    if ((this.selfFlags & EntityFlag.Stunned) !== 0) return null;
    // Content-sourced chain (P5): the SAME rows the server validates with —
    // panel-tuned step timing stays predicted correctly. Attack-speed buffs
    // (P7: Flurry, Killer's Rhythm) shrink every step duration server-side
    // (combat.ts handleAttackRequest) — the same fold times this mirror.
    const combo = this.basicChains[this.classId];
    const speedMult = this.attackSpeedMultNow();
    const now = performance.now();
    let step = 0;
    if (this.comboStep >= 0 && this.comboStartedAtMs > 0) {
      const current = combo.steps[this.comboStep]!;
      const stepMs = current.durationMs / speedMult;
      const since = now - this.comboStartedAtMs;
      if (since < stepMs * (1 - COMBO_LINK_WINDOW_FRACTION)) return null;
      if (since <= stepMs + COMBO_RESET_MS) step = (this.comboStep + 1) % combo.steps.length;
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
    const def = combo.steps[step]!;
    return { step, def, durationMs: Math.round(def.durationMs / speedMult) };
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
    for (const def of defs) this.abilityDefs.set(def.id, def);
    const chains = buildBasicChains(defs);
    if (chains) this.basicChains = chains;
    // Effective defs, slot map and the effect-mod indexes all derive from the
    // authored defs × the allocated tree — one rebuild covers every path.
    this.rebuildProgressionFolds();
  }

  /**
   * Own hotbar: slot → published def for the player's class — the EFFECTIVE
   * def when allocated nodes rewrite it (P7): predicted costs, cooldowns and
   * cast bars must match what the server will actually charge and time.
   */
  private rebuildSlotDefs(): void {
    this.slotDefs.clear();
    for (const def of this.abilityDefs.values()) {
      if (def.classId === this.classId && def.binding.kind === 'slot') {
        this.slotDefs.set(def.binding.slot, this.effectiveDefs.get(def.id) ?? def);
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
    groundAim: { x: number; z: number } | null = null,
  ):
    | { ok: true; def: AbilityDef; phase: 'instant' | 'cast' | 'channel'; contactDelayMs: number }
    | { ok: false; reason: AbilityRejectReason | null } {
    const def = this.slotDefs.get(slot);
    if (!def) return { ok: false, reason: null };
    if (this.status !== 'playing') return { ok: false, reason: null };
    if (this.predicted.rollTimeLeft > 0 || this.predicted.swimming) {
      return { ok: false, reason: AbilityRejectReason.BadState };
    }
    // Stunned refuses every slot press at request level (server parity, P6).
    if ((this.selfFlags & EntityFlag.Stunned) !== 0) {
      return { ok: false, reason: AbilityRejectReason.BadState };
    }
    // Ground casts need their point (run-world's reticle always supplies one
    // in-range; a missing point is the server's NoTarget refusal).
    if (def.targeting.kind === 'ground_aoe' && !groundAim) {
      return { ok: false, reason: AbilityRejectReason.NoTarget };
    }
    const targetId = target?.id ?? 0;
    const verdict = evaluateUse(this.abilityMachine, def, {
      level: this.selfLevel,
      alive: !this.selfDead,
      resource: this.resource,
      hasTarget: targetId > 0,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    // Cleric Grace (P6): banked stacks shave the Mend bar. The stacks are a
    // synced self-effect, so this computes the SAME delta the server applies
    // at commit — the predicted bar and the authoritative release agree.
    let castMsDelta = 0;
    if (this.classId === 'cleric' && def.id === GRACE_CONSUMER_ABILITY) {
      const grace = this.effectLists
        .get(this.selfId)
        ?.find((effect) => effect.effectId === GRACE_EFFECT_ID);
      if (grace) castMsDelta = -GRACE_CAST_REDUCTION_MS * grace.stacks;
    }
    // Archmage surge (P7): a banked instant-cast window collapses the next
    // real cast — the effect is synced, so this predicts the same collapse
    // the server applies at commit (abilities.ts).
    if (
      def.castMs > 0 &&
      this.effectLists.get(this.selfId)?.some((effect) => effect.effectId === ARCANE_SURGE_EFFECT)
    ) {
      castMsDelta = -def.castMs;
    }

    // Mirror the server's order exactly: finisher CP measured before commit.
    if (def.comboFinisher) spendComboPoints(this.resource);
    const commit = commitUse(
      this.abilityMachine,
      def,
      this.resource,
      {
        yaw: aimYaw,
        pitch: aimPitch,
        targetId,
      },
      { castMsDelta },
    );
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
    } else if (def.targeting.kind === 'teleport') {
      // Mage Blink: the same forward hop the server executes at commit.
      this.predictTeleport(def.targeting.distance, aimYaw);
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
          groundAim: def.targeting.kind === 'ground_aoe' ? groundAim : null,
        }),
      );
    }
    return { ok: true, def, phase: commit.phase, contactDelayMs };
  }

  /**
   * Predict Mage Blink's forward hop — the exact server rule (abilities.ts):
   * a straight jump along aim, landing only where the walkgrid allows.
   */
  private predictTeleport(distance: number, aimYaw: number): void {
    const m = this.predicted;
    const destX = m.x + Math.sin(aimYaw) * distance;
    const destZ = m.z + Math.cos(aimYaw) * distance;
    if (!this.terrain.walkableAt || this.terrain.walkableAt(destX, destZ)) {
      m.x = destX;
      m.z = destZ;
      m.y = this.terrain.heightAt(destX, destZ);
      m.vx = 0;
      m.vz = 0;
    }
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
    // Focus stance (P6): the mage's held slow-strafe, same fold as world.step.
    if (secondaryHeld && this.classId === 'mage') speedMult *= FOCUS_MOVE_SPEED_MULT;
    // Node stat folds (P7): Fleet/Traveler/Pilgrim speed, Acrobat dodges,
    // Marathon sprints, END-scaled regen — world.step folds the same numbers.
    const nodeStats = this.aggregates.stats;
    speedMult *= 1 + nodeStats.moveSpeedPct / 100;
    dodgeCostDelta += nodeStats.dodgeStaminaCostDelta;
    // Casting/channeling with a fractional castWhileMoving walks slower — the
    // def is the same row the server reads (node-rewritten alike), so both
    // sides slow identically.
    const activeCastId =
      this.abilityMachine.cast?.abilityId ?? this.abilityMachine.channel?.abilityId ?? null;
    if (activeCastId !== null) {
      const castMove = this.effectiveDefOf(activeCastId)?.castWhileMoving;
      if (typeof castMove === 'number') speedMult *= castMove;
    }
    if (now < this.abilityMoveMultUntilMs) speedMult *= this.abilityMoveMult;
    // Hard CC (P6): both sides read the flags the server stamped — the shared
    // step pins the feet (root) or freezes everything (stun) identically. The
    // one-RTT window before the flag lands resolves through normal corrections.
    const stunned = (this.selfFlags & EntityFlag.Stunned) !== 0;
    const rooted = stunned || (this.selfFlags & EntityFlag.Rooted) !== 0;
    return {
      speedMult,
      dodgeCostDelta,
      staminaRegenPerS: this.selfStats.staminaRegenPerS,
      sprintStaminaPerS: SPRINT_STAMINA_PER_SEC + nodeStats.sprintStaminaPerSDelta,
      rooted,
      controlsLocked: stunned,
    };
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

  /**
   * Active cast OR channel for the bar (null = none). Casts fill toward
   * release; channels drain toward their end with a pip per tick (P6).
   */
  castView(): {
    kind: 'cast' | 'channel';
    name: string;
    fraction: number;
    remainingMs: number;
    ticks: number;
    ticksDone: number;
  } | null {
    const machine = this.abilityMachine;
    const cast = machine.cast;
    if (cast) {
      const elapsed = machine.nowMs - cast.startedAtMs;
      return {
        kind: 'cast',
        name: this.abilityDefs.get(cast.abilityId)?.name ?? '',
        fraction: Math.min(1, elapsed / cast.castMs),
        remainingMs: Math.max(0, cast.castMs - elapsed),
        ticks: 0,
        ticksDone: 0,
      };
    }
    const channel = machine.channel;
    if (channel) {
      const elapsed = machine.nowMs - channel.startedAtMs;
      return {
        kind: 'channel',
        name: this.abilityDefs.get(channel.abilityId)?.name ?? '',
        fraction: Math.min(1, elapsed / channel.durationMs),
        remainingMs: Math.max(0, channel.durationMs - elapsed),
        ticks: Math.floor(channel.durationMs / channel.tickEveryMs),
        ticksDone: Math.floor(
          (channel.nextTickAtMs - channel.startedAtMs) / channel.tickEveryMs - 1,
        ),
      };
    }
    return null;
  }

  /** Drain machine happenings since last frame (run-world's anim/VFX layer). */
  takeMachineEvents(): MachineEvent[] {
    if (this.machineEvents.length === 0) return this.machineEvents;
    const drained = [...this.machineEvents];
    this.machineEvents.length = 0;
    return drained;
  }

  /** Authoritative buff/debuff list for an entity (self, target plates). */
  effectsFor(entityId: number): readonly EffectSyncEntry[] {
    return this.effectLists.get(entityId) ?? [];
  }

  /**
   * Why the last dodge press did nothing, or null. Cleared when the key is
   * released so a held V does not spam the same complaint.
   */
  dodgeRefusal: DodgeRefusal | null = null;

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
    // The roll, authoritative since v11. This USED to be left at zero, and
    // that single omission is what made the dodge look broken: a roll runs
    // 550 ms but its input is acked within a round trip, so once the press
    // left the replay buffer every snapshot rebuilt a not-rolling state and
    // step 4 cloned it over the prediction. The Roll clip died two frames in
    // and the character slid the remaining 4 m in its walk cycle — worst
    // while moving, where the gait resumed instantly and hid it completely.
    this.authoritative.rollTimeLeft = self.rollTimeLeftMs / 1000;
    this.authoritative.rollDirX = Math.sin(self.rollDirYaw);
    this.authoritative.rollDirZ = Math.cos(self.rollDirYaw);
    this.authoritative.rollCooldownMs = self.rollCooldownMs;

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

    const rollingBefore = this.predicted.rollTimeLeft > 0;
    const dodgePressed = (intent.buttons & InputButton.Dodge) !== 0;
    const result = stepMovement(this.predicted, intent, TICK_DT, this.terrain, modifiers);
    // A dodge press that produced no roll is the single most common "the game
    // ignored me" moment: 25 stamina at 15/s behind a 1 s delay means a second
    // roll is ~2.7 s away, and nothing on screen said so. Record WHY so the
    // HUD can answer (run-world reads this on the edge).
    if (dodgePressed && !rollingBefore && !result.dodged) {
      // Same question `stepMovement` just answered — asked again for the words.
      this.dodgeRefusal = dodgeRefusal(
        this.predicted,
        modifiers.rooted === true || modifiers.controlsLocked === true,
        dodgeCostOf(modifiers),
      );
    } else if (!dodgePressed) {
      this.dodgeRefusal = null;
    }
    if (result.dodged) {
      // Dodge cancels the chain AND an active cast/channel for half its cost
      // back — the same §4.5 rule the server applies in its step. The refund
      // reads the EFFECTIVE cost (node cost discounts, P7), like the server.
      this.cancelPredictedCombo();
      const casting = this.abilityMachine.cast ?? this.abilityMachine.channel;
      if (casting) {
        const castDef = this.effectiveDefOf(casting.abilityId);
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
      const ticked = tickAbilityMachine(this.abilityMachine, dtMs, moving);
      // Machine happenings → the per-frame event queue run-world drains for
      // presentation (release anim at cast end, channel tick flashes, the
      // "moved" cancel words). The defs resolve here so the drain stays dumb.
      if (ticked.released) {
        this.machineEvents.push({
          kind: 'released',
          def: this.effectiveDefOf(ticked.released.abilityId) ?? null,
        });
      }
      for (const tick of ticked.channelTicks) {
        this.machineEvents.push({
          kind: 'channel-tick',
          def: this.effectiveDefOf(tick.abilityId) ?? null,
        });
      }
      if (ticked.channelEnded) this.machineEvents.push({ kind: 'channel-ended', def: null });
      if (ticked.moveCanceled) this.machineEvents.push({ kind: 'move-canceled', def: null });
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
