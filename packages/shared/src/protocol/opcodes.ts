/**
 * Wire opcodes (docs/tech/NETWORKING.md §2).
 *
 * Opcode numbers are frozen once shipped: adding a message means adding a number,
 * never renumbering an existing one. Changing any message's payload shape requires
 * bumping {@link PROTOCOL_VERSION}.
 */

/** Bumped on any wire-format change; mismatched clients are told to reload. */
export const PROTOCOL_VERSION = 5; // v5 (P3 fix): downhill ground snap in the shared step

/** Client → server opcodes. */
export const ClientOp = {
  Hello: 0x01,
  InputIntent: 0x02,
  Ping: 0x08,
  Chat: 0x07,
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

/** Entity state flags carried in snapshots. */
export const EntityFlag = {
  Grounded: 1 << 0,
  Sprinting: 1 << 1,
  Moving: 1 << 2,
  Swimming: 1 << 3,
} as const;
export type EntityFlag = (typeof EntityFlag)[keyof typeof EntityFlag];

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
