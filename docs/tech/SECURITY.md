# Dawned — Security & Anti-Cheat

> Threat model: a small friends server, but on the public internet — so: protect accounts and the
> VPS like production, protect gameplay like a game (server authority + sanity checks), skip
> paranoid enterprise theater. "User data has to be secure" is the requirement; this is the plan.

## 1. Account Security

| Concern | Measure |
|---|---|
| Passwords | argon2id (`@node-rs/argon2`), m=64 MB t=3 p=1 (tuned for the 1-core box at ~80 ms), per-hash salt; min length 8, no composition rules (length > rules), zxcvbn-lite hint meter client-side |
| Account names | CITEXT unique, 3–20 `[a-z0-9_]`, reserved list (admin, gm, system, dawned…) |
| Sessions | 128-bit random opaque token; DB stores SHA-256 of it; game: bearer in `Hello` packet (kept in memory, sessionStorage only — survives F5 via "remember me" localStorage opt-in); admin: httpOnly Secure SameSite=Strict cookie; game sessions 30 d sliding, admin 12 h |
| Login rate limits | per-IP: 10/min + exponential lockout per-account (5 fails → 1 min, doubling to 1 h cap, resets on success); constant-time compares; identical error for wrong-name vs wrong-pass |
| Registration | open by default, `world_settings.inviteCode` optional toggle (friends-server switch); per-IP 3 accounts/day |
| Transport | HTTPS/WSS only (Caddy TLS, HSTS); HTTP→HTTPS redirect; no mixed content |
| Secrets | `.env` on VPS root-owned 0600 (DB creds, session pepper); never in git; DEPLOY.sh generates strong defaults |

No email in the design (spec) → **account recovery is human**: admins can reset passwords via
Dawned-Admin (sets must-change-at-next-login flag, action audited). Communicated at registration
("no email — remember your password; an admin can reset it").

## 2. Server Authority (the real anti-cheat)

The client is a *renderer with opinions*. Server-side truth for everything that matters:

| Vector | Enforcement |
|---|---|
| Speed/teleport hacks | Movement intents are **inputs, not positions**: server integrates with authoritative speed (buffs/sprint known server-side), slope/collision checks, per-tick displacement cap (`maxSpeed × dt × 1.15` tolerance); violations → clamp + counter++ (see §4) |
| Fly/noclip | Server grounds vertical motion to terrain+gravity; walkability grid denies out-of-bounds; teleports only via server verbs (shrine, GM, dodge/charge paths validated) |
| Ability cheats (cooldown/cost/range) | Full re-validation server-side per COMBAT.md §4 pipeline; client numbers are never read — only *requests* with aim |
| Damage hacks | Damage computed only server-side from content data; client never sends damage values, ever |
| Radar/ESP | AOI means the client only ever receives ~96 m of world — there is nothing beyond it to reveal (wallhacks at ≤96 m are unfixable and irrelevant PvE) |
| Item dupes | All inventory mutations are single DB transactions with row locks + idempotent op ids from client (retry-safe); server-side quantity/slot validation; loot bags are server objects with claim checks |
| Gold/XP injection | Server-computed only; client `StateDelta` is display data |
| Gathering/quest cheats | Interact verbs validated: range ≤4 m, node not depleted, profession gate, channel timer server-tracked (movement cancels), counters server-side |
| Packet abuse | Per-opcode rate limits (input 40/s, ability 10/s, chat 2/s + burst, interact 5/s); payload size caps; malformed packet → disconnect + log (never crash: codec is fuzz-tested) |
| Replay/session theft | WSS only; tokens opaque + hashed at rest; single-session-per-account enforcement; IP change on live session → re-auth challenge (soft: token revalidation) |

## 3. Admin & GM Security
- Dawned-Admin: served on a separate hostname/path behind Caddy with its own session cookie;
  role check on every request (server-side, not menu-hiding); optional IP allowlist in Caddyfile
  (commented block ready); admin panel actions ALL audited (`audit_log`).
- Ops API (`/ops/*` on game server): bound to localhost only — reachable exclusively by the admin
  process on the same box; shared-secret header as second factor (generated at deploy).
- GM commands: role-gated server-side at the command router (a `player` sending `GmCommand`
  opcode = logged incident, silent no-op); destructive commands need `confirm`; grants tagged
  (`granted_by`) per GM_TOOLS.md.
- Content publish: zod + referential validation before any bake; published bundles hashed; the
  game server refuses bundles whose hash mismatches the DB publish row (tamper check).

## 4. Anomaly Handling (proportionate for friends-scale)
Per-session violation counters (movement clamps, invalid requests, rate trips). Thresholds:
log → warn in server log → auto-kick at 20/min → GM notification line in admin dashboard. **No
auto-bans** — humans decide (20 players; false positives cost more than cheaters). All counters
visible per player in Dawned-Admin live view.

## 5. VPS Hardening (executed by DEPLOY.sh, documented in DEPLOYMENT.md)
- SSH: key-only, root login off, fail2ban sshd jail. UFW: allow 22/80/443 only (Postgres bound to
  localhost; ops API localhost).
- Services run as unprivileged `dawned` user; systemd sandboxing (`ProtectSystem=strict`,
  `PrivateTmp`, `NoNewPrivileges`, RW only where needed).
- Unattended-upgrades (security) on; Caddy auto-TLS; weekly `BACKUP.sh` off-box copy reminder
  (manual scp/rclone hook left as TODO for the owner — question in USER_QUESTIONS.md).
- Node deps: lockfile-pinned, `pnpm audit` in `pnpm check`, minimal dependency policy (every new
  dep is a review item in phase DoD).

## 6. Privacy & Data Care
Stored PII: account name, password hash, IPs (login/audit), chat logs (7-day retention). No email,
no real names, no analytics/telemetry, no third-party calls from client at runtime (fonts/icons
self-hosted). `docs/` includes a one-paragraph player-facing privacy note rendered on the register
screen. Friends deserve the same care as customers.

## 7. Phase Gates (security is roadmapped, not vibes)
- P1 exit: auth flow pen-checklist (rate limits, timing, token handling, session fixation) ✔
- P4 exit: movement/ability validation suite green (scripted cheat-client harness in `tools/cheatbot/`) ✔
- P8 exit: inventory transaction fuzz (parallel op storm, zero dupes) ✔
- P14: full checklist re-run + `cheatbot` regression + dependency audit + backup restore drill ✔
