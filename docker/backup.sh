#!/bin/sh
# EmergencyPlus automatic backups (runs in the "backup" container).
# One file per backup: eplus-backup-YYYY-MM-DD_HHMMSS.tar = db.dump (pg_dump custom format) + uploads/.
#   - once a day at BACKUP_TIME (local time, default 02:00), or right after start-up if that time was missed
#   - whenever the app (or backup-now.bat) drops a ".request" file in the backups folder
# Manual use:  backup.sh now  |  backup.sh restore <file name>   (restore: stop the app first)
# Backups older than BACKUP_KEEP_DAYS are pruned, but only after a new backup succeeded.
set -u
DIR="${BACKUP_ROOT:-/backups}"
APPDATA="${APPDATA_ROOT:-/appdata}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
AT="${BACKUP_TIME:-02:00}"
export PGPASSWORD="$POSTGRES_PASSWORD"
DB_ARGS="-h ${DB_HOST:-db} -U ${POSTGRES_USER:-eplus} -d ${POSTGRES_DB:-eplus}"
mkdir -p "$DIR"

fail() {
  echo "$(date '+%F %T') $1" > "$DIR/.last-error"
  echo "BACKUP FAILED: $1" >&2
  rm -rf "$work"
  return 1
}

backup() {
  stamp=$(date +%Y-%m-%d_%H%M%S)
  name="eplus-backup-$stamp.tar"
  work=$(mktemp -d)
  pg_dump $DB_ARGS -Fc -f "$work/db.dump" || { fail "database dump failed"; return 1; }
  mkdir -p "$APPDATA"/uploads
  # Written under a hidden name, then renamed, so a half-written file never looks like a backup.
  tar -cf "$DIR/.$name.part" -C "$work" db.dump -C "$APPDATA" uploads || { rm -f "$DIR/.$name.part"; fail "archive failed (disk full?)"; return 1; }
  mv "$DIR/.$name.part" "$DIR/$name"
  rm -rf "$work" "$DIR/.last-error"
  find "$DIR" -maxdepth 1 -name 'eplus-backup-*.tar' -mtime +"$KEEP" -delete
  echo "$(date '+%F %T') backup ok: $name ($(du -h "$DIR/$name" | cut -f1))"
}

until pg_isready $DB_ARGS -q; do sleep 3; done
echo "Backups → $DIR every day at $AT, keeping $KEEP days."

restore() {
  file="$DIR/$(basename "$1")"
  [ -f "$file" ] || { echo "Backup file not found: $file" >&2; exit 1; }
  tar -tf "$file" db.dump >/dev/null 2>&1 || { echo "Not an EmergencyPlus backup: $file" >&2; exit 1; }
  echo "Saving the current data first (safety copy)..."
  backup || exit 1
  work=$(mktemp -d)
  tar -xf "$file" -C "$work" || exit 1
  echo "Restoring database from $(basename "$file")..."
  psql $DB_ARGS -q -v ON_ERROR_STOP=1 -c 'SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;' || exit 1
  pg_restore $DB_ARGS --no-owner --exit-on-error "$work/db.dump" || exit 1
  echo "Restoring uploaded files..."
  rm -rf "$APPDATA"/uploads.old && mv "$APPDATA"/uploads "$APPDATA"/uploads.old 2>/dev/null
  mkdir -p "$APPDATA"/uploads && cp -a "$work/uploads/." "$APPDATA"/uploads/ && rm -rf "$APPDATA"/uploads.old || exit 1
  rm -rf "$work"
  echo "Restore complete."
}

case "${1:-}" in
  now) backup; exit $? ;;
  restore) restore "${2:?usage: backup.sh restore <file>}"; exit 0 ;;
esac

# A backup is due when today's BACKUP_TIME has passed and no backup was made since then.
# If the computer was off at that time, the backup runs as soon as it is back on.
while true; do
  touch -d "$(date +%F) $AT" /tmp/due-since
  due=""
  [ "$(date +%s)" -ge "$(date -r /tmp/due-since +%s)" ] && [ -z "$(find "$DIR" -maxdepth 1 -name 'eplus-backup-*.tar' -newer /tmp/due-since | head -n1)" ] && due=1
  if [ -e "$DIR/.request" ]; then rm -f "$DIR/.request"; due=1; fi
  if [ -n "$due" ]; then backup || sleep 600; fi
  sleep 20
done
