# Dawned — Deployment & Operations (VPS)

> Target: Ubuntu 24.04 LTS VPS, 4 GB RAM / 1 CPU core, domain `play.pathlands.cc` already pointed
> at the box. Goal per spec: **deploying and updating must be dead simple** — one script to install,
> one to update, one to back up, one to roll back. The scripts below are the reviewed drafts; they
> land as real files in `deploy/` during Phase 0 and are validated on the actual VPS as that
> phase's Definition of Done. (Admin panel hosting: **decided — `/admin` path**, IP allowlist off
> for now; the subdomain variant stays documented below in case it is ever wanted.)

## 1. Topology on the box

| Unit                         | What                                                                                                                                       | Resources (steady)       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `caddy.service` (distro pkg) | TLS (auto Let's Encrypt), static files, reverse proxy                                                                                      | ~40 MB                   |
| `dawned-game.service`        | Node 22: game server (REST+WSS, world sim)                                                                                                 | ≤700 MB, most of the CPU |
| `dawned-admin.service`       | Node 22: admin API + SPA serving                                                                                                           | ≤300 MB                  |
| `postgresql@16-main`         | database (localhost only)                                                                                                                  | ~300 MB tuned            |
| `dawned-maintenance.timer`   | nightly: backups, session/chat purges, log rotation is journald's                                                                          | burst                    |
| Paths                        | app `/opt/dawned/{game,admin}` (git clones) · data `/var/lib/dawned/` (published maps, content bundles, backups) · env `/etc/dawned/*.env` |                          |

RAM budget total ≈ 1.4–1.6 GB steady → comfortable on 4 GB with OS cache. Single CPU core: the game
server is the priority — admin build steps are niced, Postgres tuned small, no other tenants.

## 2. Routing (Caddyfile draft)

> **As built (2026-08-04) — the cache contract, because getting it wrong looks
> like "the deploy did not happen":** hashed assets under `/assets/*` are
> immutable; `assets/manifest.json` is `no-cache` (stable name, new hashes
> inside after every bake); **everything else** the client handle serves is
> `no-cache`, matched by negation — the SPA fallback rewrites `/anything` to
> `/index.html` AFTER the header directives run, so a rule that matched only
> `/` left deep links with no cache header at all, and a browser without one
> may invent its own freshness lifetime. `/api/*` is `no-store`, set by the
> game server on every response (and by the panel on its own). The deployed
> Caddyfile is `deploy/Caddyfile`; `packages/server/src/deploy-contract.test.ts`
> pins these rules so they cannot silently regress.
>
> Both halves also carry a build id — the client bakes in the commit at build
> time, the server reads it at boot — and the client raises a reload notice
> when they disagree. That is the backstop for any cache rule we get wrong.

```caddy
play.pathlands.cc {
	encode zstd gzip

	# Game client static bundle (immutable hashed assets)
	root * /opt/dawned/game/packages/client/dist
	@static path /assets/* /favicon* /fonts/*
	header @static Cache-Control "public, max-age=31536000, immutable"

	# Published map/content artifacts (immutable by version path)
	handle_path /published/* {
		root * /var/lib/dawned/published
		file_server
		header Cache-Control "public, max-age=31536000, immutable"
	}

	# Game server: REST + WebSocket
	handle /api/* {
		reverse_proxy 127.0.0.1:8081
	}
	handle /game {
		reverse_proxy 127.0.0.1:8081   # WS upgrade passes through
	}

	# Admin panel under /admin (default option; subdomain variant below)
	handle_path /admin* {
		reverse_proxy 127.0.0.1:8082
		# Optional IP allowlist — uncomment & fill:
		# @notallowed not remote_ip 1.2.3.4 5.6.7.0/24
		# respond @notallowed 403
	}

	handle {
		try_files {path} /index.html   # SPA fallback for the game client
		file_server
	}
}

# --- Subdomain variant (needs DNS A record admin.play.pathlands.cc) ---
# admin.play.pathlands.cc {
# 	reverse_proxy 127.0.0.1:8082
# }
```

## 3. systemd units (drafts)

```ini
# /etc/systemd/system/dawned-game.service
[Unit]
Description=Dawned MMORPG game server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=dawned
Group=dawned
WorkingDirectory=/opt/dawned/game/packages/server
EnvironmentFile=/etc/dawned/game.env
ExecStart=/usr/bin/node --enable-source-maps dist/index.js
Restart=always
RestartSec=3
# Crash-loop backoff + hardening
StartLimitIntervalSec=60
StartLimitBurst=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/dawned
LimitNOFILE=16384
OOMScoreAdjust=-500          # prefer killing anything else first
MemoryHigh=900M
MemoryMax=1200M

[Install]
WantedBy=multi-user.target
```

`dawned-admin.service` mirrors it (port 8082 env, `MemoryHigh=400M`, `OOMScoreAdjust=0`).

## 4. `deploy/DEPLOY.sh` — one-time provisioning (draft)

Idempotent (safe to re-run); run as root on the fresh VPS: `bash DEPLOY.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail
DOMAIN="play.pathlands.cc"
REPO_GAME="https://github.com/EinPallux/Dawned.git"
REPO_ADMIN="https://github.com/EinPallux/Dawned-Admin.git"
BRANCH="${DAWNED_BRANCH:-main}"

log(){ printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }

log "System packages"
apt-get update && apt-get -y upgrade
apt-get -y install git curl ufw fail2ban unattended-upgrades postgresql-16 ca-certificates

log "Node 22 + pnpm"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get -y install nodejs
corepack enable && corepack prepare pnpm@9 --activate

log "Caddy"
apt-get -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy.list
sed -i 's|deb |deb [signed-by=/usr/share/keyrings/caddy.gpg] |' /etc/apt/sources.list.d/caddy.list
apt-get update && apt-get -y install caddy

log "Firewall + SSH hardening"
ufw allow OpenSSH; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/;s/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh
systemctl enable --now fail2ban

log "User & directories"
id -u dawned &>/dev/null || useradd -r -m -d /var/lib/dawned -s /usr/sbin/nologin dawned
install -d -o dawned -g dawned /opt/dawned /var/lib/dawned/{published,assets,backups}
install -d -m 0750 /etc/dawned

log "PostgreSQL"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='dawned'" | grep -q 1 || {
  DBPASS=$(openssl rand -hex 24)
  sudo -u postgres psql -c "CREATE ROLE dawned LOGIN PASSWORD '$DBPASS'"
  sudo -u postgres psql -c "CREATE DATABASE dawned OWNER dawned"
  echo "DATABASE_URL=postgres://dawned:$DBPASS@127.0.0.1:5432/dawned" > /etc/dawned/db.env
}
# small-box tuning
PGCONF=/etc/postgresql/16/main/conf.d/dawned.conf
cat > "$PGCONF" <<'EOF'
shared_buffers = 256MB
work_mem = 8MB
maintenance_work_mem = 64MB
max_connections = 40
effective_cache_size = 1GB
EOF
systemctl restart postgresql

log "Clone + build (game, admin)"
sudo -u dawned -H bash -c "
  set -e
  [ -d /opt/dawned/game ]  || git clone -b $BRANCH $REPO_GAME  /opt/dawned/game
  [ -d /opt/dawned/admin ] || git clone -b $BRANCH $REPO_ADMIN /opt/dawned/admin
  cd /opt/dawned/game  && pnpm install --frozen-lockfile && pnpm build
  cd /opt/dawned/admin && pnpm install --frozen-lockfile && pnpm build
"

log "Env files (generated once)"
[ -f /etc/dawned/game.env ] || cat > /etc/dawned/game.env <<EOF
NODE_ENV=production
PORT=8081
$(cat /etc/dawned/db.env)
SESSION_PEPPER=$(openssl rand -hex 32)
OPS_SECRET=$(openssl rand -hex 32)
PUBLISHED_DIR=/var/lib/dawned/published
EOF
[ -f /etc/dawned/admin.env ] || cat > /etc/dawned/admin.env <<EOF
NODE_ENV=production
PORT=8082
$(cat /etc/dawned/db.env)
OPS_SECRET=$(grep OPS_SECRET /etc/dawned/game.env | cut -d= -f2)
GAME_OPS_URL=http://127.0.0.1:8081
PUBLISHED_DIR=/var/lib/dawned/published
EOF
chmod 0640 /etc/dawned/*.env && chown root:dawned /etc/dawned/*.env

log "Migrations + seed world"
sudo -u dawned -H bash -c "cd /opt/dawned/game && pnpm db:migrate && pnpm db:seed --if-empty"

log "Services + Caddy"
cp /opt/dawned/game/deploy/dawned-game.service /opt/dawned/admin/deploy/dawned-admin.service /etc/systemd/system/
cp /opt/dawned/game/deploy/Caddyfile /etc/caddy/Caddyfile
cp /opt/dawned/game/deploy/dawned-maintenance.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dawned-game dawned-admin dawned-maintenance.timer
systemctl reload caddy

log "DONE — https://$DOMAIN  (admin: https://$DOMAIN/admin)"
```

## 5. `deploy/UPDATE.sh` — every deploy after that (draft)

`sudo bash /opt/dawned/game/deploy/UPDATE.sh [game|admin|all(default)] [--ref <branch|tag>]`

```bash
#!/usr/bin/env bash
set -euo pipefail
TARGET="${1:-all}"; REF="${3:-}"
update_repo () { # $1 dir  $2 service
  local d=$1 svc=$2
  sudo -u dawned -H bash -c "
    set -e; cd $d
    git fetch --tags origin
    git checkout ${REF:-\$(git rev-parse --abbrev-ref HEAD)} && git pull --ff-only
    pnpm install --frozen-lockfile
    pnpm build
  "
  sudo -u dawned -H bash -c "cd $d && pnpm db:migrate"   # no-op when none pending
  systemctl restart "$svc"
  systemctl --no-pager --quiet is-active "$svc" || { echo \"$svc failed — check journalctl -u $svc\"; exit 1; }
}
echo \"▶ Snapshot pre-update backup\" && bash \"$(dirname \"$0\")/BACKUP.sh\" --quick
[[ $TARGET == game  || $TARGET == all ]] && update_repo /opt/dawned/game  dawned-game
[[ $TARGET == admin || $TARGET == all ]] && update_repo /opt/dawned/admin dawned-admin
systemctl reload caddy
echo \"▶ Update complete. Client bundle hash changed → players get 'Update available — reload' toast.\"
```

Notes: player-facing downtime for a game-server restart is ~3–5 s (clients auto-reconnect with the
grace window); UPDATE.sh announces in-game 60 s prior via ops API when the server is up
(`curl -H \"X-Ops: $OPS_SECRET\" localhost:8081/ops/announce?text=...&in=60`) — wired in the real
script at Phase 0.

## 5.1 `deploy/WORLD.sh` — the world does not travel with the code

**Added 2026-08-06, after the owner ran `UPDATE.sh` on a P12 build and found themselves still
standing on the dev island.** That was not a failed update. It is the shape of the system, and it
had never been written down:

| What                                                         | Lives in                                                | Travels by     |
| ------------------------------------------------------------ | ------------------------------------------------------- | -------------- |
| Server, client, panel, shared formulas, migrations           | git                                                     | `UPDATE.sh`    |
| Abilities, XP curve, skill nodes (P5–P7)                     | Postgres, frozen into seed migrations 0006–0010         | `UPDATE.sh`    |
| P8–P11 items, bestiary, gathering, pilot quests              | Postgres, frozen into seed migrations 0012–0020         | `UPDATE.sh`    |
| **The Dawnlands: terrain, zones and every P12 placement**    | `assets_baked/map/map-<epoch>/` — **git-ignored**       | **`WORLD.sh`** |
| **P12's content rows** (50 enemies, 223 items, 28 quests, …) | Postgres `content_*`, published — **no seed migration** | **`WORLD.sh`** |

The bake is git-ignored on purpose (A2, 2026-08-05): the live pointer `current.json` must never be
overwritten by a `git pull` carrying a bake from somebody's dev checkout. The consequence is that a
freshly-updated box has every feature P12 built and none of the world P12 authored — it keeps
serving the committed `dev-2` dev island, which looks exactly like an update that did nothing.
`UPDATE.sh` now says so when it sees `mapVersion: dev-2`.

P12's content was deliberately **not** frozen into a seed migration the way P8–P11's was. Freezing
`content_*` would carry the definitions and still leave the terrain and all 900-odd placements
behind, so the box would end up with 50 enemy types and nowhere for them to stand. The world is one
thing and it moves in one piece.

```bash
sudo bash /opt/dawned/game/deploy/WORLD.sh              # asks before it starts
sudo bash /opt/dawned/game/deploy/WORLD.sh --from 5     # resume a chain that failed at step 5
```

It runs the panel's own authoring scripts against the panel on this box, in dependency order —
terrain → settlements → bestiary → items → gathering nodes → POIs/interactables → NPCs → quests —
and every one of them goes through the normal publish rail (validate → diff → bake → version →
notify). Nothing in the deploy path reimplements placement or validation, so what lands is what the
panel itself would land, and a bad step is refused rather than published. Quests come last because
every hint circle is derived from the camps, nodes, NPCs and chests the earlier steps placed.

Then it verifies **from the game** — `/ops/camps`, `/ops/worldobjects`, `/ops/respawnnodes` — for
the reason every phase since P9 has closed that way: a publish saying "ok" is the panel's account of
its own work, and the only line that proves content crossed the repo boundary is the server counting
what it seeded. `tools/smoke/p12-dod.mjs` is the full audit.

Operational notes:

- **Safe to re-run.** Every authoring script prunes drafts that already match, so a second run
  reports "nothing to publish" rather than churning the world.
- **Not safe to run with players on.** The terrain is regenerated under them and the world is
  republished several times on the way through. Characters, inventories, levels and quest progress
  are untouched — those are their own tables — but the ground moves.
- **Credentials.** The authoring scripts take `DAWNED_ADMIN_USER` / `DAWNED_ADMIN_PASS` and only
  touch the `accounts` table when neither is set. `WORLD.sh` prompts for the owner's own panel login
  and passes it through a 0600 file rather than `env VAR=…`, which would put the password in the
  box's process list. Using a real account also means every row the run publishes is attributed to a
  person in `audit_log`. Before this existed the scripts minted an admin account whose password is a
  literal in a public repository — fine in a throwaway dev container, a permanent backdoor anywhere
  else, and the whole reason it had to be fixed before this path could be recommended.
- **Disk.** Each bake is ~23 MB and a full run publishes several; a publish sweeps all but the
  newest five (`pruneOldBakes`), and `BACKUP.sh` archives the live one nightly (§6).

## 6. `deploy/BACKUP.sh` + maintenance (draft behavior)

- Nightly (timer 04:30 UTC): `pg_dump -Fc` → `/var/lib/dawned/backups/db-YYYYMMDD.dump` + tar of
  `/var/lib/dawned/published` → rotation **14 daily + 8 weekly**; `--quick` mode (pre-update) keeps
  last 5 separately; `--verify` (monthly timer) restores newest into `dawned_verify` scratch DB and
  runs row-count sanity, alerting into the admin dashboard on failure.
- **The live map bake too** (added 2026-08-05 with the panel's A2/A3). Published bakes land in the
  game checkout next to the committed `dev-2` fallback — they are in neither git nor `published/`,
  which made the world the one thing a restore would not have brought back. `archive_live_map`
  reads `current.json`, tars that version plus the pointer to `backups/map-YYYYMMDD.tar.gz`, and
  keeps the last 7 (each ~8.6 MB; a publish already sweeps all but the newest five bakes on disk).
  The DRAFT those bakes came from is in Postgres, so the pg_dump covers re-publishing; this covers
  the faster path of putting the live world straight back. Override the location with `MAP_DIR` if
  the checkout ever moves.
- Maintenance same timer: purge expired sessions, chat_log >7 d, metrics >14 d, `vacuumdb --analyze`.
- Off-box copies: owner's choice (2026-08-02) — manual snapshots via the Hostinger hPanel; the
  `AFTER_BACKUP_CMD` hook point in `/etc/dawned/backup.env` remains for future automation. Local
  nightly dumps + rotation still run regardless (they protect against app-level mistakes and bad
  publishes, which hPanel snapshots don't cover as granularly).

## 7. `deploy/ROLLBACK.sh` (draft behavior)

`ROLLBACK.sh game <git-ref> [--db <backup-file>]`: checks out ref, rebuilds, optionally restores DB
(with a loud double-confirm — restoring rolls back _player progress_, content publishes include
their own revert path via publish versions instead: prefer `content_publishes` re-activate in the
admin panel over DB restores).

## 8. Repository access (private repos)

`DEPLOY.sh`/`UPDATE.sh` clone and pull over HTTPS, which only works while the repositories are
public. If they are (or become) private, set up **read-only deploy keys** once:

```bash
# on the VPS, as root:
sudo -u dawned ssh-keygen -t ed25519 -N '' -f /var/lib/dawned/.ssh/id_ed25519
sudo -u dawned cat /var/lib/dawned/.ssh/id_ed25519.pub
# → add as a read-only Deploy Key on GitHub for BOTH repos (Settings → Deploy keys)
# then deploy with SSH URLs:
DAWNED_REPO_GAME=git@github.com:EinPallux/Dawned.git \
DAWNED_REPO_ADMIN=git@github.com:EinPallux/Dawned-Admin.git \
bash DEPLOY.sh
```

(One key can serve both repos only via a "machine user"; plain deploy keys are per-repo — generate
a second key with a distinct filename plus an `~/.ssh/config` host alias, or use a fine-grained
PAT in the HTTPS URL instead. Existing clones can be switched later with `git remote set-url`.)

## 9. Ops Runbook (quick reference)

| Task             | Command                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Logs (live)      | `journalctl -u dawned-game -f`                                                                      |
| Status/health    | `systemctl status dawned-game` · `curl localhost:8081/api/health`                                   |
| Restart game     | `systemctl restart dawned-game` (players see reconnect overlay)                                     |
| In-game announce | GM `/announce` or admin panel Live Ops                                                              |
| Metrics          | Admin panel dashboard (tick p95, RSS, players) — or `curl -H "X-Ops: …" localhost:8081/ops/metrics` |
| Disk check       | `df -h /` + backups dir size in nightly report line (admin dashboard)                               |
| TLS              | automatic (Caddy); `systemctl reload caddy` after Caddyfile edits                                   |

## 10. Update-flow UX contract

Deploys must never hard-strand a player: client detects protocol/content mismatch → toast with
reload button; server drains with 60 s announce for planned updates; abrupt restarts are survivable
(reconnect grace + ≤10 s movement rollback per ARCHITECTURE.md persistence rules). This contract is
tested as part of P14's release drill.
