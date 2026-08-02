# Dawned — Networking & Netcode

> Server-authoritative simulation with client prediction — the make-or-break layer for "smooth
> action combat in a browser". This doc fixes the timing model, the wire protocol, prediction/
> reconciliation, lag compensation, and interest management. Anti-cheat validation rules live in
> [SECURITY.md](SECURITY.md); server loop in [ARCHITECTURE.md](ARCHITECTURE.md) §3.

## 1. Timing Model

| Constant                             | Value                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Server simulation tick               | **20 Hz** (50 ms), fixed, drift-corrected                                                 |
| Snapshot send                        | every tick (20 Hz), delta-compressed, per-client AOI                                      |
| Client input send                    | 30 Hz coalesced intent packets (or immediately with an ability/interact request)          |
| Client interpolation delay (remotes) | 100 ms (2 snapshots buffered; adaptive +50 ms on loss)                                    |
| Lag-compensation rewind window       | ≤ 250 ms (5 ticks of position history)                                                    |
| Clock sync                           | ping/pong every 2 s, EWMA offset+RTT; client renders server-time − interp delay           |
| Disconnect grace                     | 15 s entity lingers (combat-loggable? — character stays in world 15 s, standard MMO rule) |

Transport: **WSS** (via Caddy) → `ws` on Node. Nagle disabled by WS framing anyway; one WS message
per tick per client (batched), permessage-deflate **off** (CPU on 1 core; our binary is small).

## 2. Protocol

Binary little-endian, hand-rolled writer/reader in `@dawned/shared/protocol` (unit-tested
round-trip). Every message: `u8 opcode` + payload. Cold-path messages (login handshake, chat,
inventory ops, quest text) use `opcode=JSON_ENVELOPE` + msgpack-free plain JSON string (they're
rare; readability wins). Hot path is pure binary.

### 2.1 Client → Server

| Op   | Message                                | Payload (packed)                                                                                                                                      |
| ---- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0x01 | `Hello`                                | protocolVersion u16, sessionToken (16B), characterId u32                                                                                              |
| 0x02 | `InputIntent`                          | seq u16, tickEcho u16, moveX/moveZ i8 (−127..127 normalized), facing u16 (radians×10430), buttons u8 bitfield (sprint, jump, dodge, rmb), aimPitch i8 |
| 0x03 | `AbilityRequest`                       | seq u16, slot u8, aimYaw u16, aimPitch i8, targetEntity u32?, groundX/Y/Z f32? (per targeting type)                                                   |
| 0x04 | `InteractRequest`                      | entityId u32, verb u8                                                                                                                                 |
| 0x05 | `LootRequest`                          | bagId u32, itemIndex u8 (0xFF = all)                                                                                                                  |
| 0x06 | `EquipRequest` / `InventoryOp`         | JSON envelope (move/split/use/sell…)                                                                                                                  |
| 0x07 | `ChatSend`                             | JSON envelope { channel, text, to? }                                                                                                                  |
| 0x08 | `Ping`                                 | clientTime f64                                                                                                                                        |
| 0x09 | `RespawnRequest` / `FastTravelRequest` | shrineId u16                                                                                                                                          |
| 0x0A | `CancelCast`                           | —                                                                                                                                                     |
| 0x0B | `GmCommand`                            | JSON envelope (role-gated server-side)                                                                                                                |

### 2.2 Server → Client

| Op   | Message                                                           | Payload                                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0x81 | `Welcome`                                                         | JSON: character full state, world settings, content version hash, spawn pos, server tick                                                                                                                                                                                                          |
| 0x82 | `Snapshot`                                                        | tick u16, lastInputSeq u16, **self block** (pos f32×3, vel, stamina, hp, resource, states), entity sections: ENTER (full: id, type, contentId, pos, yaw, hp%, rank, name idx…), UPDATE (bit-masked deltas: pos quantized i16 cell-relative, yaw u8, hp% u8, anim state u8, speed u8), LEAVE (ids) |
| 0x83 | `AbilityStart`                                                    | caster u32, abilityId u16, castMs u16, aim, predicted flag                                                                                                                                                                                                                                        |
| 0x84 | `AbilityResolve`                                                  | caster u32, abilityId u16, results[]: target u32, kind u8 (dmg/heal/shield/miss/immune), amount u24, crit flag, killed flag                                                                                                                                                                       |
| 0x85 | `EffectApply/Remove`                                              | target u32, effectId u16, stacks u8, durMs u16                                                                                                                                                                                                                                                    |
| 0x86 | `TelegraphSpawn`                                                  | shape u8, params (pos, radius/angle/len), durMs u16, hostileFlag                                                                                                                                                                                                                                  |
| 0x87 | `ProjectileSpawn/Despawn`                                         | id u32, kind u16, origin, dir, speed                                                                                                                                                                                                                                                              |
| 0x88 | `EntityEvent`                                                     | id u32, event u8 (death, levelup, dodge, jump, gatherStart/End, emote id…)                                                                                                                                                                                                                        |
| 0x89 | `StateDelta` (self)                                               | JSON envelope: xp, level, points, quest counters, inventory diffs, gold, cooldown corrections                                                                                                                                                                                                     |
| 0x8A | `LootBagContents` / `VendorList` / `DialogueNode` / `QuestUpdate` | JSON envelopes                                                                                                                                                                                                                                                                                    |
| 0x8B | `ChatMessage`                                                     | JSON { channel, from, text, gmFlag, ts }                                                                                                                                                                                                                                                          |
| 0x8C | `Pong`                                                            | clientTime f64, serverTime f64                                                                                                                                                                                                                                                                    |
| 0x8D | `SystemNotice`                                                    | code u16 + JSON params (toasts, errors, announce)                                                                                                                                                                                                                                                 |
| 0x8E | `ContentInvalidate`                                               | new content hash (client refetches bundle lazily)                                                                                                                                                                                                                                                 |
| 0x8F | `WeatherState`                                                    | scope u8 (world/zone), zoneIdx u16, weather u8 (clear/overcast/rain/storm/rainbow), transitionMs u16                                                                                                                                                                                              |

Quantization: entity positions sent as cell-relative i16 (1/64 m precision within AOI cell) — full
f32 only on ENTER. Bandwidth estimate @20 players clustered worst-case: self 40 B + 25 entities × ~14 B
avg deltas + events ≈ **~450 B/tick ≈ 9 kB/s**; typical exploration ≈ 2–4 kB/s. Comfortably inside
budget; no compression needed.

### 2.3 Versioning

`protocolVersion` bumps on any wire change → server rejects stale clients with `UpdateRequired`
notice (client shows reload screen — deploys are seamless because the client is a static bundle).

## 3. Movement: Prediction & Reconciliation

- Shared, deterministic-enough step function `stepMovement(state, intent, dt, terrain)` lives in
  `@dawned/shared/formulas` — identical code on both sides (same TS, same order of ops; floats are
  fine at our tolerances).
- Client: applies intents immediately (0-latency feel), stores ring buffer of (seq, intent,
  predicted state).
- Server: applies the same intents on arrival (validated: §SECURITY caps), snapshots include
  `lastInputSeq` + authoritative self state.
- Client reconcile: drop acked inputs, compare authoritative vs predicted-at-that-seq; error ≤2 cm
  ignore, ≤1.5 m exponential-smooth correction over ≤80 ms, larger = snap (teleport/knockback path
  sets an explicit flag so it never rubber-smooths).
- Server-driven displacement (knockback, charge, fast travel) sends `EntityEvent` + authoritative
  pos with snap flag; client suppresses prediction during the displacement window.
- Jump/fall: vertical is fully deterministic from terrain + gravity, predicted like the rest.
- Dodge: client starts roll anim instantly + sends intent; server validates stamina/cooldown; a
  rejection (rare, only desync/cheat) snaps state back — honest clients never see it.

## 4. Combat Latency Model

- **Ability start:** client plays wind-up/FX at press (prediction), server validates & broadcasts
  `AbilityStart` (others see it delayed by their interp — correct and fair).
- **Hit resolution:** server-side at resolve tick, testing hit shapes against the **rewound**
  positions of victims at `resolveTime − (attacker RTT/2 + interp delay)`, clamped to 250 ms — the
  attacker hits what they saw, the classic lag-comp contract. PvE-only softens fairness stakes;
  enemies get NO rewind against players (server-true positions) which is strictly player-favorable.
- **I-frames:** dodge invulnerability windows are evaluated in rewound time too (your roll counts
  if it was rolling on your screen — the fairness rule that makes dodging feel right online).
- **Damage numbers/kill feed:** client renders on `AbilityResolve` only (never predicted) — feel
  comes from predicted anim/FX/hit-stop; truth comes from the server. Predicted hit-stop uses a
  50 ms optimistic window canceled if no resolve arrives (imperceptible at our RTTs).
- Cooldowns/resources: predicted client-side, corrected by `StateDelta` (drift ≤1 tick in practice).

## 5. Interest Management (AOI)

- World grid 64 m cells (matches terrain chunks). Subscription = 3×3 cells (~96 m radius effective)
  for entities; 5×5 for terrain residency (client streams meshes ahead).
- Enter/leave hysteresis: +8 m leave margin (no flicker at borders). Per-client entity cap 80
  (priority: players > combat-relevant > proximity; beyond cap = culled with nameplate-only ghosts
  for players). At our scale this cap should never bind — it's the storm-drain.
- Events (`AbilityStart`, telegraphs, chat-local) route through the same grid; global channels
  (chat global/system, announces) bypass.

## 6. Connection Lifecycle

1. HTTPS `POST /api/auth/login` → session token (see SECURITY.md) → character list.
2. `WSS /game` + `Hello` (token) → validate, single-session enforce (kick older with notice),
   `Welcome` + spawn into AOI.
3. Heartbeat: server expects any packet per 10 s (client pings at 2 s); miss → grace →
   despawn+save. Reconnect within grace resumes the entity seamlessly (token re-auth).
4. Logout: explicit → immediate save + despawn. Character-switch returns to select screen over the
   same socket (session re-`Hello`).

## 7. Server Performance Practices

- Zero per-tick allocations on the hot path: preallocated snapshot writers per client, pooled
  event objects, typed arrays for position history rings.
- Spatial hash rebuilt incrementally (entities update cell on crossing only).
- Per-client send budget: if socket backpressure (`bufferedAmount` > 64 kB) → degrade to
  10 Hz snapshots for that client, drop non-essential events, log; hard cut at 512 kB (client
  likely dead).
- Everything measurable: per-system tick timings in the metrics ring (visible in Admin dashboard +
  `/perf` GM command).

## 8. Testing Strategy

- Codec: property-based round-trip tests (fuzz values, truncation, malformed input safety).
- Prediction: headless sim test — scripted intents through client-step and server-step must match
  within tolerance across 10k ticks including slope/collision cases.
- Lag lab: dev-mode artificial latency/jitter/loss injection (50/100/200 ms presets) — combat feel
  signoff at 100 ms is a phase gate (P4).
- Load: bot harness (Node script driving N=25 fake clients with wander+combat scripts) against a
  staging boot on the VPS — p95 tick budget gate before release (P14).
