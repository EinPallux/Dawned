#!/usr/bin/env bash
#
# Dawned — backups.
#
#   sudo bash BACKUP.sh            nightly backup + rotation (14 daily, 8 weekly)
#   sudo bash BACKUP.sh --quick    pre-update snapshot (keeps the last 5)
#   sudo bash BACKUP.sh --verify   restore the newest dump into a scratch DB and check it
#   sudo bash BACKUP.sh --report   what the backups cost right now, and free space
#
# Off-box copies are the owner's job via the Hostinger hPanel (decision 2026-08-02).
# Set AFTER_BACKUP_CMD in /etc/dawned/backup.env to automate that later.
set -euo pipefail

DATA_DIR=/var/lib/dawned
BACKUP_DIR="$DATA_DIR/backups"
ETC_DIR=/etc/dawned
# Must match DEPLOY.sh / UPDATE.sh / ROLLBACK.sh.
APP_DIR=/opt/dawned
# The map bakes the admin panel publishes (A2) land in the game checkout, next
# to the committed `dev-2` fallback — they are not in git and not in the
# database, so without this they are the one piece of the world a restore would
# not bring back.
MAP_DIR="${MAP_DIR:-$APP_DIR/game/assets_baked/map}"
MODE="${1:-nightly}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

log() { printf '\033[1;33m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m! %s\033[0m\n' "$*"; }

free_mb() { df -Pm "$1" | awk 'NR==2 {print $4}'; }
used_mb() { du -sm "$1" 2>/dev/null | cut -f1; }

# Below this, refuse to write another backup. A backup that fills the disk takes
# the GAME down with it — Postgres stops accepting writes long before anyone
# notices the retention policy was too generous, and the retention here was:
# up to 70 daily dumps, at a dump size that went 11 MB → 65 MB the day the
# Dawnlands landed and grows with the world. Nothing on disk is deleted by this
# check; it stops ADDING while there is no room, and says so.
MIN_FREE_MB="${DAWNED_MIN_FREE_MB:-2048}"

# Above this the backup directory is trimmed BEFORE the run rather than after,
# so a box that has been quietly filling recovers on its own instead of waiting
# for someone to read a log.
BACKUP_BUDGET_MB="${DAWNED_BACKUP_BUDGET_MB:-8192}"

[[ -f "$ETC_DIR/backup.env" ]] && . "$ETC_DIR/backup.env"

install -d -o dawned -g dawned "$BACKUP_DIR"

# Trim oldest-first until the directory is inside its budget, never touching the
# newest of a series: a box with no room still needs yesterday's dump.
trim_to_budget() {
  local used victim
  used="$(used_mb "$BACKUP_DIR")"
  [[ -n "$used" ]] || return 0
  [[ "$used" -le "$BACKUP_BUDGET_MB" ]] && return 0
  warn "backups use ${used} MB (budget ${BACKUP_BUDGET_MB} MB) — trimming oldest first"
  while [[ "$(used_mb "$BACKUP_DIR")" -gt "$BACKUP_BUDGET_MB" ]]; do
    victim="$(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | tail -n +4 | tail -1 || true)"
    [[ -z "$victim" ]] && victim="$(ls -1t "$BACKUP_DIR"/published-*.tar.gz 2>/dev/null | tail -n +2 | tail -1 || true)"
    [[ -z "$victim" ]] && victim="$(ls -1t "$BACKUP_DIR"/map-*.tar.gz 2>/dev/null | tail -n +2 | tail -1 || true)"
    [[ -z "$victim" ]] && { warn "nothing left that is safe to delete — investigate by hand"; break; }
    log "  trimming $(basename "$victim") ($(du -h "$victim" | cut -f1))"
    rm -f "$victim"
  done
}

have_room() {
  local free
  free="$(free_mb "$BACKUP_DIR")"
  [[ -n "$free" ]] || return 0
  if [[ "$free" -lt "$MIN_FREE_MB" ]]; then
    warn "only ${free} MB free on $(df -P "$BACKUP_DIR" | awk 'NR==2 {print $6}') —"
    warn "refusing to write another backup (want ${MIN_FREE_MB} MB)."
    warn "The game keeps running. Free space and re-run; oldest files here:"
    ls -1t "$BACKUP_DIR" 2>/dev/null | tail -5 | sed 's/^/    /'
    return 1
  fi
  return 0
}

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

archive_live_map() {
  local target="$1"
  [[ -d "$MAP_DIR" ]] || return 0
  local live
  live="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$MAP_DIR/current.json" 2>/dev/null || true)"
  if [[ -z "$live" || ! -d "$MAP_DIR/$live" ]]; then
    # No pointer yet: the game is on the committed dev fallback, which git has.
    return 0
  fi
  # The LIVE bake only — older ones are a rollback window the publish sweeps,
  # not history worth 8 MB a night.
  tar -czf "$target" -C "$MAP_DIR" current.json "$live"
  log "live map bake ($live) → $target ($(du -h "$target" | cut -f1))"
}

case "$MODE" in
  --quick)
    trim_to_budget
    have_room || exit 1
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
    trim_to_budget
    have_room || exit 1
    dump_db "$BACKUP_DIR/db-$STAMP.dump" || true
    archive_published "$BACKUP_DIR/published-$STAMP.tar.gz"
    archive_live_map "$BACKUP_DIR/map-$STAMP.tar.gz"

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
    ls -1t "$BACKUP_DIR"/map-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

    log "backup dir now $(du -sh "$BACKUP_DIR" | cut -f1), $(free_mb "$BACKUP_DIR") MB free"
    if [[ "$(free_mb "$BACKUP_DIR")" -lt $((MIN_FREE_MB * 2)) ]]; then
      warn "disk getting tight: $(free_mb "$BACKUP_DIR") MB free. Lower DAWNED_BACKUP_BUDGET_MB in"
      warn "/etc/dawned/backup.env, or copy older dumps off the box."
    fi
    ;;

  --report)
    printf '  backups   %s\n' "$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
    printf '  free      %s MB (new backups refused under %s MB)\n' "$(free_mb "$BACKUP_DIR")" "$MIN_FREE_MB"
    printf '  budget    %s MB\n' "$BACKUP_BUDGET_MB"
    for series in db pre-update published map; do
      count="$(ls -1 "$BACKUP_DIR"/$series-* 2>/dev/null | wc -l)"
      size="$(du -shc "$BACKUP_DIR"/$series-* 2>/dev/null | tail -1 | cut -f1 || echo 0)"
      printf '    %-11s %3s file(s)  %s\n' "$series" "$count" "$size"
    done
    ;;

  *)
    warn "unknown mode '$MODE' (expected --quick, --verify, --report or nightly)"
    exit 2
    ;;
esac

if [[ -n "${AFTER_BACKUP_CMD:-}" ]]; then
  log "running AFTER_BACKUP_CMD"
  bash -c "$AFTER_BACKUP_CMD" || warn "AFTER_BACKUP_CMD failed"
fi

chown -R dawned:dawned "$BACKUP_DIR"
