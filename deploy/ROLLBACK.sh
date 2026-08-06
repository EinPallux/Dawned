#!/usr/bin/env bash
#
# Dawned — roll back to a previous build.
#
#   sudo bash ROLLBACK.sh game <git-ref> [--db <backup-file>] [--map <archive>|--no-map]
#   sudo bash ROLLBACK.sh list
#
# Code rollback is cheap and safe. A DATABASE rollback throws away player progress
# since that backup and is double-confirmed. For content mistakes, prefer
# re-activating an earlier publish version in Dawned-Admin over restoring the DB.
#
# A database restore also restores the WORLD by default, and that pairing is the
# point: the map bake is not in the database and not in git, so restoring one
# without the other leaves yesterday's content pointing at today's terrain —
# spawners, nodes and quest markers referencing rows that no longer exist. The
# nightly backup has archived the live bake since 2026-08-05 and nothing used it
# until now. `--map <archive>` picks one explicitly; `--no-map` keeps the live
# world (right when you are rolling back CODE only).
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
MAP_FILE=""
RESTORE_MAP=1
MAP_DIR="${MAP_DIR:-$APP_DIR/game/assets_baked/map}"

shift 2 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_FILE="${2:-}"; shift 2 ;;
    --map) MAP_FILE="${2:-}"; RESTORE_MAP=1; shift 2 ;;
    --no-map) RESTORE_MAP=0; shift ;;
    *) warn "unknown option: $1"; exit 2 ;;
  esac
done

# The map archive taken closest to (and not after) the database dump: restoring
# a world NEWER than the data would recreate the mismatch this exists to avoid.
map_archive_for() {
  local dump="$1" stamp best
  stamp="$(basename "$dump" | sed -n 's/.*-\([0-9]\{8\}-[0-9]\{6\}\)\.dump/\1/p')"
  [[ -n "$stamp" ]] || { ls -1 "$BACKUP_DIR"/map-*.tar.gz 2>/dev/null | sort -r | head -1; return; }
  best=""
  while read -r candidate; do
    local cstamp
    cstamp="$(basename "$candidate" | sed -n 's/map-\([0-9]\{8\}-[0-9]\{6\}\)\.tar\.gz/\1/p')"
    [[ -n "$cstamp" ]] || continue
    [[ "$cstamp" > "$stamp" ]] && continue
    best="$candidate"
    break
    # Sorted by the timestamp in the NAME, not by mtime: the comparison above is
    # on the name, and a copied or restored file carries a new mtime while its
    # name still says when it was taken. Mixing the two picks the wrong archive.
  done < <(ls -1 "$BACKUP_DIR"/map-*.tar.gz 2>/dev/null | sort -r)
  printf '%s' "$best"
}

if [[ -z "$TARGET" || -z "$REF" ]]; then
  warn "usage: ROLLBACK.sh game|admin <git-ref> [--db <file>] [--map <archive>|--no-map]"
  warn "       ROLLBACK.sh list"
  exit 2
fi

case "$TARGET" in
  game)  DIR="$APP_DIR/game";  SERVICE=dawned-game ;;
  admin) DIR="$APP_DIR/admin"; SERVICE=dawned-admin ;;
  *) warn "unknown target '$TARGET'"; exit 2 ;;
esac

log "Rolling $TARGET back to $REF"
sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -euo pipefail <<EOSU
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

  if [[ $RESTORE_MAP -eq 1 ]]; then
    [[ -n "$MAP_FILE" ]] || MAP_FILE="$(map_archive_for "$DB_FILE")"
    if [[ -z "$MAP_FILE" || ! -f "$MAP_FILE" ]]; then
      warn "No map archive found to pair with this dump — the LIVE world is unchanged."
      warn "The restored data may reference a world that is not on disk. Check with:"
      warn "  curl -s localhost:8081/api/health   and   BACKUP.sh --report"
    else
      log "Restoring the world from $(basename "$MAP_FILE")"
      # Extract beside the live bakes, then repoint: current.json is written by
      # the tar itself, and it is the last thing the game reads, so an aborted
      # extract cannot leave the pointer aimed at a half-written directory.
      install -d -o dawned -g dawned "$MAP_DIR"
      tar -xzf "$MAP_FILE" -C "$MAP_DIR"
      chown -R dawned:dawned "$MAP_DIR"
      log "World restored — now on $(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MAP_DIR/current.json" 2>/dev/null)"
    fi
  else
    warn "--no-map: the live world is unchanged. If the restored data is older than"
    warn "the world, expect content referencing placements that no longer exist."
  fi
fi

systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  log "Rollback complete — $SERVICE is running at $REF"
else
  warn "$SERVICE failed to start — journalctl -u $SERVICE -n 50"
  exit 1
fi
