#!/usr/bin/env bash
#
# Dawned — deploy an update.
#
#   sudo bash /opt/dawned/game/deploy/UPDATE.sh [game|admin|all] [--ref <branch|tag>] [--no-announce]
#
# Pulls, installs, builds, migrates and restarts. Announces the restart in-game
# first when the server is up, and takes a quick backup before touching anything.
set -euo pipefail

# Re-exec from a temp copy first: this script pulls the very repo it lives in,
# and bash reads script files lazily — a mid-run update of the file would splice
# new bytes into the running execution. The copy is immune; the ORIGINAL
# location is remembered so sibling scripts (BACKUP.sh) still resolve.
if [[ -z "${DAWNED_UPDATE_RELOCATED:-}" ]]; then
  export DAWNED_SCRIPT_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  export DAWNED_UPDATE_RELOCATED=1
  _tmp="$(mktemp /tmp/dawned-update.XXXXXX.sh)"
  cp "${BASH_SOURCE[0]}" "$_tmp"
  exec bash "$_tmp" "$@"
fi

TARGET="${1:-all}"
REF=""
ANNOUNCE=1
ANNOUNCE_SECONDS="${DAWNED_ANNOUNCE_SECONDS:-60}"

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --no-announce) ANNOUNCE=0; shift ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done

APP_DIR=/opt/dawned
ETC_DIR=/etc/dawned
SCRIPT_DIR="${DAWNED_SCRIPT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

log() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m! %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  warn "UPDATE.sh must run as root (use sudo)."
  exit 1
fi

announce() {
  [[ $ANNOUNCE -eq 1 ]] || return 0
  local secret
  secret="$(grep '^OPS_SECRET=' "$ETC_DIR/game.env" 2>/dev/null | cut -d= -f2- || true)"
  [[ -n "$secret" ]] || return 0
  if curl -fsS --max-time 3 -X POST http://127.0.0.1:8081/ops/announce \
      -H "content-type: application/json" \
      -H "x-ops-secret: $secret" \
      -d "{\"text\":\"Server update in ${ANNOUNCE_SECONDS}s — the game will reload to the login screen; hop back in right after.\"}" \
      >/dev/null 2>&1; then
    log "Announced restart in-game; waiting ${ANNOUNCE_SECONDS}s"
    sleep "$ANNOUNCE_SECONDS"
  fi
}

# The admin panel consumes @dawned/shared as `file:../Dawned/packages/shared` —
# the SIBLING game checkout, no network fetch, no tokens. On the VPS the game
# clone lives at $APP_DIR/game, so a `Dawned` symlink provides the expected
# sibling name, and the shared package must be BUILT (dist/) before the panel
# installs — the game update normally guarantees that; this guard covers
# admin-only runs on a fresh box.
prepare_admin_shared_link() {
  ln -sfn "$APP_DIR/game" "$APP_DIR/Dawned"
  chown -h dawned:dawned "$APP_DIR/Dawned" 2>/dev/null || true
  if [[ ! -d "$APP_DIR/game/packages/shared/dist" ]]; then
    log "admin: building @dawned/shared first (game repo)"
    sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -euo pipefail <<EOSU
      cd "$APP_DIR/game"
      pnpm install --frozen-lockfile
      pnpm --filter @dawned/shared build
EOSU
  fi
}

# The admin repo may be missing entirely: its first deploy predated any code, so
# DEPLOY.sh's clone of the (then nonexistent) main branch failed and was skipped.
# Derive its URL from the game clone's origin (same host/owner/token) and clone
# main — falling back to the remote's default branch until main exists.
ensure_admin_clone() {
  local dir="$1"
  [[ -d "$dir/.git" ]] && return 0
  local admin_url
  admin_url="$(git -C "$APP_DIR/game" remote get-url origin | sed 's|/Dawned\(\.git\)\?$|/Dawned-Admin.git|')"
  log "admin: cloning $dir"
  sudo -u dawned -H bash -euo pipefail <<EOSU
    if ! git clone -b main "$admin_url" "$dir" 2>/dev/null; then
      echo "  (no main branch yet — cloning the default branch; create main when ready)"
      git clone "$admin_url" "$dir"
    fi
EOSU
}

update_repo() {
  local dir="$1" service="$2" label="$3" envfile="$4"
  [[ -d "$dir/.git" ]] || { warn "$label: $dir is not a git clone — skipping"; return 0; }

  [[ "$label" == "admin" ]] && prepare_admin_shared_link

  log "$label: pulling"
  sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -euo pipefail <<EOSU
    cd "$dir"
    git fetch --tags --prune origin
    if [[ -n "$REF" ]]; then
      git checkout "$REF"
      git pull --ff-only origin "$REF" 2>/dev/null || true
    else
      git pull --ff-only
    fi
EOSU

  # Check AFTER the pull: the first admin update is exactly the pull that brings
  # package.json into a docs-only clone (the old pre-check deadlocked on that).
  if [[ ! -f "$dir/package.json" ]]; then
    warn "$label: no package.json on this branch — nothing to build, skipping"
    return 0
  fi

  log "$label: build"
  sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -euo pipefail <<EOSU
    cd "$dir"
    pnpm install --frozen-lockfile
    pnpm build
EOSU

  # Migrations run as the dawned user, which cannot read /etc/dawned/*.env —
  # inject DATABASE_URL explicitly (read here, as root). A migration failure must
  # ABORT the update: restarting the service onto missing tables would take the
  # whole login flow down while /api/health still looks green.
  if grep -q '"db:migrate"' "$dir/package.json"; then
    log "$label: migrations"
    local database_url
    database_url="$(grep '^DATABASE_URL=' "$ETC_DIR/$envfile" 2>/dev/null | cut -d= -f2- || true)"
    if [[ -z "$database_url" ]]; then
      warn "$label: no DATABASE_URL in $ETC_DIR/$envfile — cannot migrate. Aborting."
      exit 1
    fi
    sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 DATABASE_URL="$database_url" \
      bash -euo pipefail <<EOSU
    cd "$dir"
    pnpm db:migrate
EOSU
  else
    log "$label: migrations — repo has no db:migrate script, skipping"
  fi

  log "$label: restarting $service"
  # enable: the admin unit ships installed-but-disabled until its first build.
  systemctl enable "$service" >/dev/null 2>&1 || true
  systemctl restart "$service"
  sleep 2
  if systemctl is-active --quiet "$service"; then
    echo "  $service is running"
  else
    warn "$service failed to start — journalctl -u $service -n 50"
    exit 1
  fi
}

log "Pre-update backup"
bash "$SCRIPT_DIR/BACKUP.sh" --quick || warn "backup failed — continuing (see BACKUP.sh output)"

announce

case "$TARGET" in
  game)  update_repo "$APP_DIR/game"  dawned-game  "game"  game.env ;;
  admin)
    ensure_admin_clone "$APP_DIR/admin"
    update_repo "$APP_DIR/admin" dawned-admin "admin" admin.env
    ;;
  all)
    update_repo "$APP_DIR/game" dawned-game "game" game.env
    ensure_admin_clone "$APP_DIR/admin"
    update_repo "$APP_DIR/admin" dawned-admin "admin" admin.env
    ;;
  *) warn "unknown target '$TARGET' (expected game|admin|all)"; exit 2 ;;
esac

# The client bundle is content-hashed, so browsers pick up the new build on reload;
# the protocol version check tells anyone still on an old bundle to refresh.
sed "s/{{DOMAIN}}/${DAWNED_DOMAIN:-play.pathlands.cc}/g" "$APP_DIR/game/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || true

log "Health check"
if HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:8081/api/health)"; then
  echo "$HEALTH"
  echo
  log "Update complete."
else
  warn "game server did not answer after update"
  exit 1
fi

# UPDATE.sh deploys CODE. The WORLD does not travel with it: a published map
# bake is git-ignored machine state (A2 — so a `git pull` here can never
# repoint the live world at somebody's dev checkout) and the content rows behind
# it live in Postgres. A box still serving the committed `dev-2` dev island has
# every feature the new code ships and none of the world it was built for, which
# looks exactly like "the update did nothing" — say so rather than let it be
# discovered by walking around.
if [[ "$HEALTH" == *'"mapVersion":"dev-2"'* ]] && [[ -f "$APP_DIR/game/deploy/WORLD.sh" ]]; then
  printf '\n\033[1;33m▶ This box is still on the dev island (map dev-2).\033[0m\n'
  echo "  The world is deployed separately — code travels in git, a published map does not:"
  echo "     sudo bash $APP_DIR/game/deploy/WORLD.sh"
  echo "  See docs/tech/DEPLOYMENT.md §5.1."
fi
