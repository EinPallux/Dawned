#!/usr/bin/env bash
#
# Dawned — build the world on this box.
#
#   sudo bash /opt/dawned/game/deploy/WORLD.sh [--yes] [--from N] [--admin-user NAME]
#
# UPDATE.sh deploys CODE. This deploys the WORLD, and they are different things
# that travel by different roads:
#
#   * Code is in git, so `git pull` carries it.
#   * The world is not. A published map bake (`assets_baked/map/map-<epoch>/`)
#     is machine state — deliberately git-ignored since A2, so that a `git pull`
#     on the VPS can never repoint the live world at a bake from somebody's dev
#     checkout — and the content rows behind it (enemies, items, quests, NPCs,
#     node definitions) live in Postgres, published through the panel.
#
# So a box that has only ever run UPDATE.sh has every feature P12 built and none
# of the world P12 authored: it keeps serving whatever bake `current.json` points
# at, which on a fresh box is the committed `dev-2` dev island. That is not a bug
# in the update — it is the missing half of the deploy, and this is it.
#
# What it does: runs the panel's own authoring scripts, in order, against the
# panel running on this box. Nothing here reimplements placement or validation —
# every step goes through the same publish rail the owner's own edits go through
# (validate → diff → bake → version → notify), so what lands is what the panel
# would land, and a bad step is refused rather than published.
#
# It is SAFE TO RE-RUN. Every script prunes drafts that already match, so a
# second run reports "nothing to publish" rather than churning the world, and
# `--from N` resumes a chain that failed halfway.
#
# It is NOT safe to run while people are playing: the terrain is regenerated
# under them and the world is republished six times on the way through. Do it
# when the server is quiet.
set -euo pipefail

APP_DIR=/opt/dawned
ETC_DIR=/etc/dawned
GAME_DIR="$APP_DIR/game"
ADMIN_DIR="$APP_DIR/admin"
PANEL_URL="http://127.0.0.1:8082"
GAME_URL="http://127.0.0.1:8081"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ASSUME_YES=0
FROM=1
ADMIN_USER=""

log() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m! %s\033[0m\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --from) FROM="${2:-1}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) warn "unknown option: $1"; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { warn "WORLD.sh must run as root (use sudo)."; exit 1; }

# ---------------------------------------------------------------- preflight
log "Preflight"

[[ -d "$GAME_DIR/.git" ]] || { warn "no game checkout at $GAME_DIR"; exit 1; }
[[ -d "$ADMIN_DIR/.git" ]] || { warn "no admin checkout at $ADMIN_DIR — run UPDATE.sh admin first"; exit 1; }
[[ -d "$ADMIN_DIR/dist/server" ]] || { warn "the panel is not built — run UPDATE.sh admin first"; exit 1; }

DATABASE_URL="$(grep '^DATABASE_URL=' "$ETC_DIR/admin.env" 2>/dev/null | cut -d= -f2- || true)"
[[ -n "$DATABASE_URL" ]] || { warn "no DATABASE_URL in $ETC_DIR/admin.env"; exit 1; }
OPS_SECRET="$(grep '^OPS_SECRET=' "$ETC_DIR/game.env" 2>/dev/null | cut -d= -f2- || true)"

systemctl is-active --quiet dawned-admin || { warn "dawned-admin is not running — the authoring scripts talk to it"; exit 1; }
systemctl is-active --quiet dawned-game || warn "dawned-game is not running; the world will still be built, but nothing will hot-reload onto it"
# Any HTTP status means the panel is listening — every one of its endpoints is
# behind auth, so a 401 here is a healthy panel and `curl -f` would call it a
# failure. What is being tested is that something answers on the port at all.
PANEL_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$PANEL_URL/api/health" 2>/dev/null || echo 000)"
[[ "$PANEL_CODE" != "000" ]] || { warn "the panel did not answer on $PANEL_URL"; exit 1; }
ok "panel up, database configured"

# The authoring scripts run under tsx, which is a devDependency: an install that
# skipped dev packages leaves them unrunnable, and the error you get instead is
# an unhelpful "command not found" three steps into a long chain.
sudo -u dawned -H bash -c "cd '$ADMIN_DIR' && pnpm exec tsx --version" >/dev/null 2>&1 || {
  warn "tsx is missing in $ADMIN_DIR — run: sudo -u dawned pnpm --dir $ADMIN_DIR install"
  exit 1
}
ok "authoring toolchain present"

# ------------------------------------------------------- can it write a bake?
# Checked HERE rather than discovered at the publish, because step 1 spends
# minutes regenerating 1024 chunks before it tries to write anything — and the
# failure it produces from inside a systemd sandbox is a bare ENOENT naming a
# path that plainly exists, which is about as unhelpful as an error gets.
#
# `dawned-admin.service` runs under ProtectSystem=strict: everything outside
# ReadWritePaths is read-only. The panel bakes into the GAME checkout's
# assets_baked/map (DEPLOYMENT.md §6), which is NOT under /var/lib/dawned. The
# unit was written at P0, months before A2 gave the panel a map to publish, so
# this had been broken since the map editor shipped and nothing had ever tried
# it in production.
MAP_BAKE_DIR="$GAME_DIR/assets_baked/map"
ln -sfn "$GAME_DIR" "$APP_DIR/Dawned"
chown -h dawned:dawned "$APP_DIR/Dawned" 2>/dev/null || true
install -d -o dawned -g dawned "$MAP_BAKE_DIR"

if ! systemctl show dawned-admin -p ReadWritePaths 2>/dev/null | grep -q 'assets_baked'; then
  log "Granting the panel write access to the map bake directory"
  install -d /etc/systemd/system/dawned-admin.service.d
  cat > /etc/systemd/system/dawned-admin.service.d/10-map-writes.conf <<'EOF'
# Added by deploy/WORLD.sh — see deploy/systemd/dawned-admin.service for why.
# The publish pipeline writes baked maps into the game checkout; ProtectSystem=
# strict would otherwise make that directory read-only to the panel.
[Service]
ReadWritePaths=-/opt/dawned/game/assets_baked
EOF
  systemctl daemon-reload
  systemctl restart dawned-admin
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    systemctl is-active --quiet dawned-admin && break
    sleep 1
  done
  systemctl is-active --quiet dawned-admin || { warn "dawned-admin did not come back after the restart"; exit 1; }
  ok "drop-in installed, panel restarted"
fi

# The gate: what the RUNNING unit is configured with, not what the repo ships.
if ! systemctl show dawned-admin -p ReadWritePaths 2>/dev/null | grep -q 'assets_baked'; then
  warn "dawned-admin still has no write access to $MAP_BAKE_DIR — the map publish will fail."
  warn "Inspect with:  systemctl show dawned-admin -p ReadWritePaths -p ProtectSystem"
  exit 1
fi

# And the proof on top of it: a probe under the SAME sandbox the live unit has —
# its own ReadWritePaths, read back from systemd — creating a directory where the
# bake will. Advisory only: a systemd too old for `--wait`/`--collect` must not
# block a deploy whose configuration has already been verified above.
PROBE=0
probe_write() {
  command -v systemd-run >/dev/null 2>&1 || return 1
  local rw
  rw="$(systemctl show dawned-admin -p ReadWritePaths --value 2>/dev/null || true)"
  systemd-run --quiet --wait --collect \
    --property=User=dawned --property=ProtectSystem=strict --property=ProtectHome=true \
    --property="ReadWritePaths=$rw" \
    /bin/mkdir -p "$MAP_BAKE_DIR/.world-sh-probe" >/dev/null 2>&1
}
probe_write || PROBE=$?
rmdir "$MAP_BAKE_DIR/.world-sh-probe" 2>/dev/null || true
if [[ $PROBE -eq 0 ]]; then
  ok "the panel can write $MAP_BAKE_DIR (proven under its own sandbox)"
else
  ok "map bake directory configured (sandbox probe skipped)"
fi

# ------------------------------------------------------------- credentials
# The scripts used to mint an admin account with a password that is a literal in
# a public repository. They take real credentials now (DAWNED_ADMIN_USER /
# DAWNED_ADMIN_PASS) and touch the accounts table only when none are supplied —
# so on this box they must be supplied. Using the owner's own login also means
# every row this run publishes is attributed to a person in `audit_log`.
if [[ -z "$ADMIN_USER" ]]; then
  read -r -p "Panel admin account: " ADMIN_USER
fi
[[ -n "$ADMIN_USER" ]] || { warn "an admin account name is required"; exit 1; }
read -r -s -p "Password for ${ADMIN_USER}: " ADMIN_PASS; echo
[[ -n "$ADMIN_PASS" ]] || { warn "a password is required"; exit 1; }

# Passed through a 0600 file rather than `env VAR=…`, which would put the
# password in this box's process list for the length of every step.
CREDS_FILE="$(umask 077 && mktemp /tmp/dawned-world-creds.XXXXXX)"
cleanup() { rm -f "$CREDS_FILE"; }
trap cleanup EXIT
{
  printf 'export DAWNED_ADMIN_USER=%q\n' "$ADMIN_USER"
  printf 'export DAWNED_ADMIN_PASS=%q\n' "$ADMIN_PASS"
  printf 'export DATABASE_URL=%q\n' "$DATABASE_URL"
} > "$CREDS_FILE"
chown dawned:dawned "$CREDS_FILE"
unset ADMIN_PASS

# ------------------------------------------------------------------- steps
# Order is a dependency chain, not a preference: terrain before anything that
# stands on it, items before the loot tables and vendors that name them, and
# quests last because every hint circle is DERIVED from the camps, nodes, NPCs
# and chests the earlier steps placed.
STEPS=(
  "the terrain — six isles, straits, zones|pnpm world:author"
  "settlements, shrines and causeways|pnpm world:settle"
  "the bestiary — 50 types, 124 camps|pnpm world:bestiary"
  "items, loot tables and vendors|node tools/content/author-items.mjs"
  "the gathering ladder — 21 kinds, ~362 nodes|pnpm world:nodes"
  "POIs, chests, signposts and town dressing|pnpm world:places"
  "the people — NPC definitions and bodies|pnpm world:folk"
  "quests — 28 in 5 chains, hints derived|pnpm world:quests"
)

if [[ $ASSUME_YES -ne 1 ]]; then
  cat <<BANNER

  This rebuilds the live world on this box:

    · regenerates all 1024 terrain chunks in the map draft
    · republishes enemies, spawners, items, loot, vendors, node definitions,
      NPCs and quests
    · publishes the map several times, repointing the live world each time

  Player characters, inventories, levels and progress are NOT touched — those
  are their own tables. Hand-placed map edits in layers the scripts own
  (zone, npc, spawner, node) WILL be replaced.

  It takes a while on one core. Do it when nobody is playing.

BANNER
  read -r -p "  Type the world's name to continue (dawnlands): " CONFIRM
  [[ "$CONFIRM" == "dawnlands" ]] || { warn "aborted"; exit 1; }
fi

log "Pre-run backup"
bash "$SCRIPT_DIR/BACKUP.sh" --quick || warn "backup failed — continuing (see BACKUP.sh output)"

if [[ -n "$OPS_SECRET" ]] && systemctl is-active --quiet dawned-game; then
  curl -fsS --max-time 3 -X POST "$GAME_URL/ops/announce" \
    -H 'content-type: application/json' -H "x-ops-secret: $OPS_SECRET" \
    -d '{"text":"The world is being rebuilt — expect the ground to move. Back shortly."}' \
    >/dev/null 2>&1 && ok "announced in-game"
fi

# --------------------------------------------------------------------- run
TOTAL=${#STEPS[@]}
STARTED_AT=$(date +%s)
for i in "${!STEPS[@]}"; do
  n=$((i + 1))
  [[ $n -ge $FROM ]] || continue
  label="${STEPS[$i]%%|*}"
  cmd="${STEPS[$i]#*|}"
  log "[$n/$TOTAL] $label"
  if ! sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -euo pipefail <<EOSU
    source "$CREDS_FILE"
    cd "$ADMIN_DIR"
    $cmd "$PANEL_URL"
EOSU
  then
    warn "step $n ($label) failed."
    warn "Fix it, then resume with:  sudo bash $SCRIPT_DIR/WORLD.sh --from $n"
    exit 1
  fi
done

# ------------------------------------------------------------------ verify
# From the GAME, not from the publish button. A publish saying "ok" is the
# panel's account of its own work; the only line that proves content crossed the
# repo boundary is the server counting what it seeded — which is the same
# argument every phase since P9 has closed on.
log "Verifying from the game"
if [[ -z "$OPS_SECRET" ]] || ! systemctl is-active --quiet dawned-game; then
  warn "game server down or no OPS_SECRET — skipping verification"
  warn "Start it and run: node $GAME_DIR/tools/smoke/p12-dod.mjs $GAME_URL"
  exit 0
fi

ops() { curl -fsS --max-time 20 -H "x-ops-secret: $OPS_SECRET" "$@" 2>/dev/null || echo '{}'; }
health="$(curl -fsS --max-time 5 "$GAME_URL/api/health" 2>/dev/null || echo '{}')"
camps="$(ops "$GAME_URL/ops/camps")"
objects="$(ops "$GAME_URL/ops/worldobjects")"
nodes="$(ops -X POST "$GAME_URL/ops/respawnnodes")"

jqish() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p" | head -1; }
printf '\n'
printf '  live map      %s\n' "$(printf '%s' "$health" | sed -n 's/.*"mapVersion":"\([^"]*\)".*/\1/p')"
printf '  camps         %s spawners, %s enemies alive\n' "$(jqish "$camps" spawners)" "$(jqish "$camps" alive)"
printf '  world objects %s NPCs, %s interactables, %s POIs\n' \
  "$(jqish "$objects" npcs)" "$(jqish "$objects" interactables)" "$(jqish "$objects" pois)"
printf '  resource nodes %s total, %s orphans\n' "$(jqish "$nodes" total)" "$(jqish "$nodes" orphans)"
printf '\n'

ELAPSED=$(( $(date +%s) - STARTED_AT ))
log "World deployed in $((ELAPSED / 60))m $((ELAPSED % 60))s."
echo "  Full audit:  node $GAME_DIR/tools/smoke/p12-dod.mjs $GAME_URL"
echo "  Players still in a browser tab will be told to reload."
