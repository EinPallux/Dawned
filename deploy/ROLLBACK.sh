#!/usr/bin/env bash
#
# Dawned — roll back to a previous build.
#
#   sudo bash ROLLBACK.sh game <git-ref> [--db <backup-file>]
#   sudo bash ROLLBACK.sh list
#
# Code rollback is cheap and safe. A DATABASE rollback throws away player progress
# since that backup and is double-confirmed. For content mistakes, prefer
# re-activating an earlier publish version in Dawned-Admin over restoring the DB.
set -euo pipefail

APP_DIR=/opt/dawned
BACKUP_DIR=/var/lib/dawned/backups

log() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m! %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  warn "ROLLBACK.sh must run as root (use sudo)."
  exit 1
fi

TARGET="${1:-}"

if [[ "$TARGET" == "list" ]]; then
  log "Recent game builds"
  sudo -u dawned git -C "$APP_DIR/game" log --oneline -15
  log "Available database backups"
  ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null || echo "  (none)"
  exit 0
fi

REF="${2:-}"
DB_FILE=""
[[ "${3:-}" == "--db" ]] && DB_FILE="${4:-}"

if [[ -z "$TARGET" || -z "$REF" ]]; then
  warn "usage: ROLLBACK.sh game|admin <git-ref> [--db <backup-file>]   |   ROLLBACK.sh list"
  exit 2
fi

case "$TARGET" in
  game)  DIR="$APP_DIR/game";  SERVICE=dawned-game ;;
  admin) DIR="$APP_DIR/admin"; SERVICE=dawned-admin ;;
  *) warn "unknown target '$TARGET'"; exit 2 ;;
esac

log "Rolling $TARGET back to $REF"
sudo -u dawned -H bash -euo pipefail <<EOSU
  cd "$DIR"
  git fetch --tags origin
  git checkout "$REF"
  pnpm install --frozen-lockfile
  pnpm build
EOSU

if [[ -n "$DB_FILE" ]]; then
  [[ -f "$DB_FILE" ]] || { warn "backup file not found: $DB_FILE"; exit 1; }
  warn "You are about to REPLACE the live database with $DB_FILE."
  warn "Every character change since that backup will be lost."
  read -r -p "Type RESTORE to continue: " confirm1
  [[ "$confirm1" == "RESTORE" ]] || { echo "aborted"; exit 1; }
  read -r -p "Are you certain? Type the backup filename to confirm: " confirm2
  [[ "$confirm2" == "$(basename "$DB_FILE")" ]] || { echo "aborted"; exit 1; }

  log "Stopping services and restoring the database"
  systemctl stop dawned-game || true
  systemctl stop dawned-admin || true
  sudo -u postgres pg_dump -Fc dawned > "$BACKUP_DIR/pre-restore-$(date -u +%Y%m%d-%H%M%S).dump" || true
  sudo -u postgres dropdb --if-exists dawned
  sudo -u postgres createdb dawned -O dawned
  sudo -u postgres pg_restore -d dawned "$DB_FILE"
  log "Database restored"
fi

systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  log "Rollback complete — $SERVICE is running at $REF"
else
  warn "$SERVICE failed to start — journalctl -u $SERVICE -n 50"
  exit 1
fi
