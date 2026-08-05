/**
 * Wire opcodes (docs/tech/NETWORKING.md §2).
 *
 * Opcode numbers are frozen once shipped: adding a message means adding a number,
 * never renumbering an existing one. Changing any message's payload shape requires
 * bumping {@link PROTOCOL_VERSION}.
 */

/** Bumped on any wire-format change; mismatched clients are told to reload. */
export const PROTOCOL_VERSION = 13; // v13 (P10): gathering nodes + professions

/** Client → server opcodes. */
export const ClientOp = {
  Hello: 0x01,
  InputIntent: 0x02,
  AbilityRequest: 0x03,
  /** Spend banked attribute points (staged deltas, confirmed in one send — v9). */
  AllocateStats: 0x04,
  /** Put one rank into a skill-tree node (v9). */
  AllocateSkill: 0x05,
  /** Mirror of Dawn respec: refund skills or re-open attributes (v9). */
  Respec: 0x06,
  Ping: 0x08,
  Chat: 0x07,
  /**
   * Every inventory/loot/vendor intent (v10) as one zod-validated JSON
   * envelope — these are UI clicks, not per-tick traffic, and the shapes are
   * heterogeneous (slots, item ids, quantities). The server re-validates and
   * re-prices everything; the client's copy is a prediction.
   */
  ItemOp: 0x09,
  /**
   * Start/stop a gather hold (v13). JSON envelope for the same reason ItemOp
   * is one — ids rather than fixed-width fields — and zod-gated at the
   * boundary. Held inputs do NOT come this way; they ride InputIntent.
   */
  GatherOp: 0x0a,
} as const;
export type ClientOp = (typeof ClientOp)[keyof typeof ClientOp];

/** Server → client opcodes. */
export const ServerOp = {
  Welcome: 0x81,
  Snapshot: 0x82,
  ChatBroadcast: 0x8a,
  Roster: 0x8b,
  Pong: 0x8c,
  SystemNotice: 0x8d,
  AbilityStart: 0x8e,
  AbilityResolve: 0x8f,
  AbilityReject: 0x90,
  EntityEvent: 0x91,
  Telegraph: 0x92,
  ProjectileSpawn: 0x93,
  ProjectileEnd: 0x94,
  EnemyMeta: 0x95,
  /** Authoritative buff/debuff list for one entity (JSON envelope, v7). */
  EffectSync: 0x96,
  /** Authoritative cooldown/resource correction for SELF (JSON envelope, v7). */
  AbilityState: 0x97,
  /** Authoritative progression state for SELF (JSON envelope, v9). */
  ProgressSync: 0x98,
  /** An XP award landed (bar tick + FCT; binary, v9). */
  XpGained: 0x99,
  /** An entity leveled up (self: juice + refill; others: pillar VFX; v9). */
  LevelUp: 0x9a,
  /** Authoritative bag + paper-doll + gold for SELF (JSON envelope, v10). */
  InventorySync: 0x9b,
  /** Loot bags this player can see, with THEIR instanced contents (v10). */
  LootBags: 0x9c,
  /** A vendor panel opened: stock, prices, buyback (JSON envelope, v10). */
  VendorPanel: 0x9d,
  /** Something entered/left the bag: toast + juice (JSON envelope, v10). */
  ItemNotice: 0x9e,
  /**
   * Which nearby resource nodes are STANDING and which are taken (v13).
   *
   * Positions are not in here — the client already has every node from the
   * baked `placements.json`, the same way it has props. This carries the one
   * thing a bake cannot: whether someone chopped it thirty seconds ago.
   */
  NodeStates: 0x9f,
  /** SELF's gather channel: started, finished, or refused with a reason (v13). */
  GatherState: 0xa0,
  /** SELF's four profession levels + the discovered-material codex (v13). */
  ProfessionSync: 0xa1,
} as const;
export type ServerOp = (typeof ServerOp)[keyof typeof ServerOp];

/** Input button bitfield carried by {@link ClientOp.InputIntent}. */
export const InputButton = {
  Sprint: 1 << 0,
  Jump: 1 << 1,
  Dodge: 1 << 2,
  PrimaryAction: 1 << 3,
  SecondaryAction: 1 << 4,
} as const;
export type InputButton = (typeof InputButton)[keyof typeof InputButton];

/** Entity state flags carried in snapshots (u16 on the wire since v6). */
export const EntityFlag = {
  Grounded: 1 << 0,
  Sprinting: 1 << 1,
  Moving: 1 << 2,
  Swimming: 1 << 3,
  /** Mid dodge-roll (remote clients play the Roll clip). */
  Dodging: 1 << 4,
  /** Enemy posture: in the COMBAT FSM state (client shows combat idle/plates). */
  InCombat: 1 << 5,
  /** Stagger stun playing (COMBAT.md §6.4 HitReact window). */
  Staggered: 1 << 6,
  /** Dead but still visible (death anim / corpse until despawn). */
  Dead: 1 << 7,
  /** Leash RETURN sprint — invulnerable, client tints/ignores as a target. */
  Leashing: 1 << 8,
  /** RMB stance held (Warrior/Cleric shield up) — remotes loop the stance clip (v7). */
  Blocking: 1 << 9,
  /** Rooted in place (v8) — remotes pin locomotion; soft-target unaffected. */
  Rooted: 1 << 10,
  /** Stunned: full control loss (v8) — remotes play the dazed hold. */
  Stunned: 1 << 11,
  /** Untargetable window (Blink) — AI drops target, soft-target skips (v8). */
  Untargetable: 1 << 12,
} as const;
export type EntityFlag = (typeof EntityFlag)[keyof typeof EntityFlag];

/** Actions a client may request (COMBAT.md §3–4). */
export const ActionId = {
  BasicAttack: 0,
  /** Soul-screen "return to shrine" (COMBAT.md §10); valid only while dead. */
  Respawn: 1,
} as const;
export type ActionId = (typeof ActionId)[keyof typeof ActionId];

/** Hotbar slot s (1..8) rides AbilityRequest.action as SLOT_ACTION_BASE+s−1. */
export const SLOT_ACTION_BASE = 2;
export const actionForSlot = (slot: number): number => SLOT_ACTION_BASE + slot - 1;
export const slotForAction = (action: number): number | null => {
  const slot = action - SLOT_ACTION_BASE + 1;
  return slot >= 1 && slot <= 8 ? slot : null;
};

/** Why an AbilityRequest was refused (client rolls back its prediction). */
export const AbilityRejectReason = {
  Dead: 1,
  OnCooldown: 2,
  NoStamina: 3,
  BadState: 4,
  /** Slot ability rejects (P5, protocol v7). */
  Locked: 5,
  OnGcd: 6,
  NoResource: 7,
  NoComboPoints: 8,
  AlreadyCasting: 9,
  NoTarget: 10,
} as const;
export type AbilityRejectReason = (typeof AbilityRejectReason)[keyof typeof AbilityRejectReason];

/** Per-entity combat happenings (ServerOp.EntityEvent payload kinds). */
export const EntityEventKind = {
  /** Enemy noticed a player: 0.5 s alert beat ('No' clip + tell). */
  Alert: 1,
  /** Stagger triggered: full-body HitReact for `a` ms. */
  Stagger: 2,
  /** Death. Corpse lingers; client plays Death clip + desaturate + sink. */
  Death: 3,
  /** (Re)spawned or leash-reset to full — client refreshes plates. */
  Respawn: 4,
  /** Leash RETURN began (invulnerable sprint home). */
  Leash: 5,
  /** Knockback displacement: (a,b) = world dx,dz applied over `c` ms (snap window). */
  Knockback: 6,
  /** The "Dawned" respawn debuff applied to a player for `a` ms (COMBAT.md §10). */
  Dawned: 7,
  /** Light-hit flinch on a victim (upper-body blend on remotes). */
  Flinch: 8,
  /** A cast/channel was broken (stun/interrupt) — cast bar shatters (v8). */
  Interrupted: 9,
  /**
   * A boss crossed an HP threshold into phase `a` (v12, P9). The fight visibly
   * changes here — the client flashes the boss frame and the announce line
   * rides the normal chat/bubble path right behind it.
   */
  Phase: 10,
} as const;
export type EntityEventKind = (typeof EntityEventKind)[keyof typeof EntityEventKind];

/** Telegraph decal shapes (COMBAT.md §8; rect ships for P9 chargers). */
export const TelegraphShape = {
  Circle: 1,
  Cone: 2,
  Rect: 3,
} as const;
export type TelegraphShape = (typeof TelegraphShape)[keyof typeof TelegraphShape];

/** Where an XP award came from ({@link ServerOp.XpGained}, PROGRESSION.md §1.1). */
export const XpSource = {
  Kill: 1,
  Discovery: 2,
  Quest: 3,
  Gather: 4,
  /** GM grant (/setlevel, events). */
  Gm: 5,
} as const;
export type XpSource = (typeof XpSource)[keyof typeof XpSource];

/** Respec flavors on the wire ({@link ClientOp.Respec}, PROGRESSION.md §6). */
export const RespecWireKind = {
  Skills: 1,
  Stats: 2,
} as const;
export type RespecWireKind = (typeof RespecWireKind)[keyof typeof RespecWireKind];

/**
 * Coded reasons the server rejects or ends something. The client maps these to
 * friendly strings — never render the raw code (docs/tech/ARCHITECTURE.md §6).
 */
export const NoticeCode = {
  ProtocolMismatch: 1,
  InvalidHello: 2,
  NameTaken: 3,
  NameInvalid: 4,
  RateLimited: 5,
  ServerFull: 6,
  Kicked: 7,
  ServerShuttingDown: 8,
  MalformedPacket: 9,
  AuthFailed: 10,
  CharacterUnavailable: 11,
  ReplacedByNewLogin: 12,
} as const;
export type NoticeCode = (typeof NoticeCode)[keyof typeof NoticeCode];

/**
 * Friendly text per notice code. Codes arrive off the wire, so always look them up
 * through {@link noticeTextFor} rather than indexing this directly — an unknown code
 * must degrade to a sensible message, not `undefined`.
 */
export const noticeText: Record<NoticeCode, string> = {
  [NoticeCode.ProtocolMismatch]: 'This client is out of date — reload the page to update.',
  [NoticeCode.InvalidHello]: 'Handshake rejected by the server.',
  [NoticeCode.NameTaken]: 'That name is already in the world right now.',
  [NoticeCode.NameInvalid]: 'Names are 2–16 characters: letters, digits and underscore.',
  [NoticeCode.RateLimited]: 'Slow down — too many messages.',
  [NoticeCode.ServerFull]: 'The world is full. Try again shortly.',
  [NoticeCode.Kicked]: 'You were disconnected by a game master.',
  [NoticeCode.ServerShuttingDown]: 'The server is restarting — reconnecting shortly.',
  [NoticeCode.MalformedPacket]: 'Connection closed: malformed packet.',
  [NoticeCode.AuthFailed]: 'Your session has expired — please log in again.',
  [NoticeCode.CharacterUnavailable]: 'That character is not available on this account.',
  [NoticeCode.ReplacedByNewLogin]: 'This account logged in from somewhere else.',
};

/** Safe lookup for a code that came off the wire (may be unknown to this client). */
export const noticeTextFor = (code: number): string =>
  (noticeText as Partial<Record<number, string>>)[code] ?? 'Disconnected by the server.';
