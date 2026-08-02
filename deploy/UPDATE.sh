#!/usr/bin/env bash
#
# Dawned — deploy an update.
#
#   sudo bash /opt/dawned/game/deploy/UPDATE.sh [game|admin|all] [--ref <branch|tag>] [--no-announce]
#
# Pulls, installs, builds, migrates and restarts. Announces the restart in-game
# first when the server is up, and takes a quick backup before touching anything.
set -euo pipefail

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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# The admin repo pins @dawned/shared as a GitHub git dependency, which pnpm
# fetches as a codeload.github.com tarball — a private repo needs the PAT for
# that fetch. Reuse the token already embedded in the clone's origin remote
# (FIRST_DEPLOY.md) by writing it into the dawned user's ~/.npmrc before the
# install. No-op when the remote carries no token (public repos).
write_npmrc_for_git_deps() {
  local dir="$1"
  local token
  token="$(git -C "$dir" remote get-url origin 2>/dev/null \
    | sed -n 's|https://[^:/@]*:\([^@]*\)@github.com/.*|\1|p')"
  if [[ -n "$token" ]]; then
    sudo -u dawned -H bash -c \
      "umask 077; printf '//codeload.github.com/:_authToken=%s\n' '$token' > ~/.npmrc"
  fi
}

update_repo() {
  local dir="$1" service="$2" label="$3" envfile="$4"
  [[ -d "$dir/.git" ]] || { warn "$label: $dir is not a git clone — skipping"; return 0; }

  [[ "$label" == "admin" ]] && write_npmrc_for_git_deps "$dir"

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
  admin) update_repo "$APP_DIR/admin" dawned-admin "admin" admin.env ;;
  all)
    update_repo "$APP_DIR/game" dawned-game "game" game.env
    [[ -f "$APP_DIR/admin/package.json" ]] && update_repo "$APP_DIR/admin" dawned-admin "admin" admin.env
    ;;
  *) warn "unknown target '$TARGET' (expected game|admin|all)"; exit 2 ;;
esac

# The client bundle is content-hashed, so browsers pick up the new build on reload;
# the protocol version check tells anyone still on an old bundle to refresh.
sed "s/{{DOMAIN}}/${DAWNED_DOMAIN:-play.pathlands.cc}/g" "$APP_DIR/game/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || true

log "Health check"
if curl -fsS --max-time 5 http://127.0.0.1:8081/api/health; then
  echo
  log "Update complete."
else
  warn "game server did not answer after update"
  exit 1
fi
