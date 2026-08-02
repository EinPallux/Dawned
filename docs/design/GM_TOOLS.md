# Dawned — GM Commands & In-Game Moderation Suite

> In-game tooling for Game Masters and Admins. The web-side counterpart (player management,
> live dashboard) lives in Dawned-Admin (docs/ADMIN_DESIGN.md there). Everything here is
> server-enforced by **account role**, never client-hidden-only. All actions are audit-logged.

## 1. Roles

| Role | Grants |
|---|---|
| `player` | none of this doc |
| `gm` | all GM commands except account/role management and content reload; GM panel |
| `admin` | everything: bans at account level, role grant/revoke, `/reloadcontent`, world settings |

Role lives on the **account** (`accounts.role`); GM visual tag in chat + optional `<GM>` nameplate
prefix (toggleable via `/gmtag`). GM characters are otherwise normal characters (test on separate
accounts encouraged; see Dawned-Admin for creating them).

## 2. Command Grammar
- Chat-prefixed `/command args`; autocompletes for GM+ (command palette in chat input with inline
  syntax hints); name args accept partial-unique matches; `@target` = current soft-target,
  `@self` allowed anywhere a name is.
- Every command echoes a system-line result (success gold / failure red with reason).
- Destructive commands (`/ban`, `/wipe...` none exist, `/despawnall`) require `confirm` suffix.

## 3. Command Reference (0.1.0 complete set)

### Movement & self
| Command | Effect |
|---|---|
| `/tp <x> <z>` or `/tp <poiName>` | teleport self (POI/shrine/settlement names resolve) |
| `/tpto <player>` / `/bring <player>` | go to / summon player |
| `/where [player]` | position + zone readout |
| `/speed <1–5>` | move-speed multiplier (resets on logout) |
| `/fly` | toggle noclip-fly (GM ghost; invisible implied off) |
| `/god` | toggle invulnerability |
| `/invis` | toggle invisible to players & AI |

### Character & progression
| `/heal [target]` · `/kill @target` (enemies only) · `/revive <player>` |
| `/setlevel <n> [player]` · `/addxp <n> [player]` · `/setprof <prof> <lvl> [player]` |
| `/item <itemId> [qty] [player]` (autocomplete on item ids) · `/gold <n> [player]` |
| `/resetcooldowns` · `/learnall` (own char, testing) · `/respec [player]` (free, logged) |

### World & spawns
| `/spawn <enemyId> [n] [rank]` at reticle point · `/despawn @target` · `/despawnall <radius> confirm` |
| `/respawnnodes [zone]` (force resource respawn) · `/resetcamp <campId>` |
| `/settime <0–24>` (visual clock; inert until P14 day/night, reserved now) |
| `/xprate <mult> [minutes]` (event rate, world-wide, announces itself) |

### Players & moderation
| `/who` (online list + zones) · `/inspect <player>` (level, gear, quests, position, session) |
| `/mute <player> <minutes> [reason]` · `/unmute` · `/kick <player> [reason]` |
| `/ban <player|account> [days|perm] <reason> confirm` · `/unban <account>` (admin) |
| `/announce <msg>` (world broadcast banner + chat) · `/msg <player> <text>` (system whisper) |

### System (admin)
| `/reloadcontent` (hot-reload published content: items/enemies/loot/quests — see tech notes) |
| `/setrole <account> <player|gm|admin>` (admin, logged loudly) |
| `/save` (force world/character checkpoint) · `/uptime` · `/perf` (tick time, entities, msg rates) |

## 4. GM Panel (`F10`)
A docked side panel (UI language per UI_UX.md, gold-seamed "GM" header):
- **Dashboard tab:** online players list (click → inspect/tp-to/bring buttons), server perf strip
  (tick p95, entity count, net out), uptime.
- **Commands tab:** all commands as searchable cards with form inputs (no syntax memorization —
  fill fields, Run). Recent commands re-run list.
- **Spawner tab:** searchable enemy list with thumbnails → click-to-place at reticle (count/rank
  options) — GM events made easy.
- **Item tab:** item search with icons → grant to self/target.
- **Help tab:** this doc rendered in-game (`/help gm` opens it too). `/help` for players lists
  player commands (emotes, `/w`, `/played`, `/stuck`).

`/stuck` (player-available): 10 s channel → teleport to nearest shrine, 5 min cooldown — support
valve that saves GM pings.

## 5. Audit & Safety
- Every GM/admin command → `audit_log` row: actor account, command, args, target, result, world
  position, timestamp. Viewable in Dawned-Admin (filterable); admins notified in-panel of role
  grants and bans.
- GM item/gold grants tag the items (`grantedBy` metadata) — visible on inspect, keeps the friend
  economy honest.
- Rate/spam guard even for GMs on world-affecting commands (2/s), and `/xprate` caps at 3×.
- Bans: account-level with reason string shown at login; character-level never (accounts are the
  unit). IP notes recorded for admins but no auto IP-bans (small community, human judgment).
