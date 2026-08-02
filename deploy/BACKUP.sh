#!/usr/bin/env bash
#
# Dawned — backups.
#
#   sudo bash BACKUP.sh            nightly backup + rotation (14 daily, 8 weekly)
#   sudo bash BACKUP.sh --quick    pre-update snapshot (keeps the last 5)
#   sudo bash BACKUP.sh --verify   restore the newest dump into a scratch DB and check it
#
# Off-box copies are the owner's job via the Hostinger hPanel (decision 2026-08-02).
# Set AFTER_BACKUP_CMD in /etc/dawned/backup.env to automate that later.
set -euo pipefail

DATA_DIR=/var/lib/dawned
BACKUP_DIR="$DATA_DIR/backups"
ETC_DIR=/etc/dawned
MODE="${1:-nightly}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

log() { printf '\033[1;33m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m! %s\033[0m\n' "$*"; }

[[ -f "$ETC_DIR/backup.env" ]] && . "$ETC_DIR/backup.env"

install -d -o dawned -g dawned "$BACKUP_DIR"

dump_db() {
  local target="$1"
  if sudo -u postgres pg_dump -Fc dawned > "$target" 2>/dev/null; then
    log "database → $target ($(du -h "$target" | cut -f1))"
  else
    warn "pg_dump failed (is the database created yet?)"
    rm -f "$target"
    return 1
  fi
}

archive_published() {
  local target="$1"
  if [[ -d "$DATA_DIR/published" ]]; then
    tar -czf "$target" -C "$DATA_DIR" published
    log "published artifacts → $target ($(du -h "$target" | cut -f1))"
  fi
}

case "$MODE" in
  --quick)
    dump_db "$BACKUP_DIR/pre-update-$STAMP.dump" || true
    # Keep only the five most recent pre-update snapshots.
    ls -1t "$BACKUP_DIR"/pre-update-*.dump 2>/dev/null | tail -n +6 | xargs -r rm -f
    ;;

  --verify)
    NEWEST="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1 || true)"
    [[ -n "$NEWEST" ]] || { warn "no backups to verify"; exit 1; }
    log "verifying $NEWEST"
    sudo -u postgres dropdb --if-exists dawned_verify
    sudo -u postgres createdb dawned_verify
    if sudo -u postgres pg_restore -d dawned_verify "$NEWEST" >/dev/null 2>&1; then
      TABLES="$(sudo -u postgres psql -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" dawned_verify)"
      log "restore ok — $TABLES table(s) in the scratch database"
      sudo -u postgres dropdb dawned_verify
    else
      sudo -u postgres dropdb --if-exists dawned_verify
      warn "RESTORE FAILED for $NEWEST — investigate immediately"
      exit 1
    fi
    ;;

  nightly)
    dump_db "$BACKUP_DIR/db-$STAMP.dump" || true
    archive_published "$BACKUP_DIR/published-$STAMP.tar.gz"

    # Rotation: keep 14 daily, plus one per week for 8 weeks.
    ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | tail -n +15 | while read -r old; do
      # Keep Sunday dumps as the weekly series.
      if [[ "$(date -u -d "$(basename "$old" | sed 's/db-\([0-9]\{8\}\).*/\1/')" +%u 2>/dev/null)" == "7" ]]; then
        continue
      fi
      rm -f "$old"
    done
    ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | tail -n +71 | xargs -r rm -f
    ls -1t "$BACKUP_DIR"/published-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

    log "backup dir now $(du -sh "$BACKUP_DIR" | cut -f1)"
    ;;

  *)
    warn "unknown mode '$MODE' (expected --quick, --verify or nightly)"
    exit 2
    ;;
esac

if [[ -n "${AFTER_BACKUP_CMD:-}" ]]; then
  log "running AFTER_BACKUP_CMD"
  bash -c "$AFTER_BACKUP_CMD" || warn "AFTER_BACKUP_CMD failed"
fi

chown -R dawned:dawned "$BACKUP_DIR"
