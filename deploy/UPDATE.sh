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
      -d "{\"text\":\"Server update in ${ANNOUNCE_SECONDS}s — you will be reconnected automatically.\"}" \
      >/dev/null 2>&1; then
    log "Announced restart in-game; waiting ${ANNOUNCE_SECONDS}s"
    sleep "$ANNOUNCE_SECONDS"
  fi
}

update_repo() {
  local dir="$1" service="$2" label="$3"
  [[ -d "$dir/.git" ]] || { warn "$label: $dir is not a git clone — skipping"; return 0; }

  log "$label: pulling"
  sudo -u dawned -H bash -euo pipefail <<EOSU
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

  log "$label: migrations"
  sudo -u dawned -H bash -euo pipefail <<EOSU || echo "  (no migrations to run)"
    cd "$dir"
    pnpm db:migrate
EOSU

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
  game)  update_repo "$APP_DIR/game"  dawned-game  "game" ;;
  admin) update_repo "$APP_DIR/admin" dawned-admin "admin" ;;
  all)
    update_repo "$APP_DIR/game" dawned-game "game"
    [[ -f "$APP_DIR/admin/package.json" ]] && update_repo "$APP_DIR/admin" dawned-admin "admin"
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
