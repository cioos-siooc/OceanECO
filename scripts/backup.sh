#!/usr/bin/env bash
# Nightly backup of the API machine to another host: ClickHouse tables + SSC image tiles.
# Online: tables are FREEZE'd (hardlinks), and parts are immutable, so rsync sends only parts
# created since the last run (plus parts rewritten by merges). Images: plain rsync mirror.
#
# Usage (as root on B):  scripts/backup.sh [ENV_FILE]   (DRY=1: rsync --dry-run, prints what would change)
#   Normally run by the backup-scheduler service (backup/flows.py), which passes everything as
#   env vars and reaches db-ch over HTTP (CH_HOST set). Run by hand, values not in the
#   environment come from ENV_FILE (default .env.prod.api) and queries go through
#   `docker compose exec`. Needs BACKUP_DEST (user@host:/path) and BACKUP_SSH (ssh command,
#   e.g. "ssh -p 22 -i /path/key").
#
# Layout on the destination:
#   ch/<table>/<part>/   active parts     schema/<table>.sql   CREATE TABLE
#   images/              copy of SSC_IMAGE_DIR (hourly tiles pruned on B are pruned here too)
#
# Restore one table into a running ClickHouse:
#   1. clickhouse-client < schema/<table>.sql
#   2. copy ch/<table>/* into <CH data>/store/<uuid[:3]>/<uuid>/detached/  (uuid from
#      SELECT uuid FROM system.tables WHERE name='<table>'), chown to the clickhouse UID
#   3. for each part: ALTER TABLE <table> ATTACH PART '<part>'
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=${1:-.env.prod.api}
NAME=nightly

# The environment first, else the env file, read without sourcing it (it holds tokens and
# isn't guaranteed shell-safe).
val() {
  if [ -n "${!1:-}" ]; then echo "${!1}"
  elif [ -f "$ENV_FILE" ]; then grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- | sed -E "s/^\"(.*)\"\$|^'(.*)'\$/\1\2/" || true
  fi
}
DEST=$(val BACKUP_DEST);  : "${DEST:?set BACKUP_DEST}"
RSYNC_RSH=$(val BACKUP_SSH); export RSYNC_RSH=${RSYNC_RSH:?set BACKUP_SSH}
CH_DATA_DIR=$(val CH_DATA_DIR); CH_DATA_DIR=${CH_DATA_DIR:-/opt/OceanECO/DATA/clickhouse_data}
DATA_DIR=$(val DATA_DIR);       DATA_DIR=${DATA_DIR:-/opt/OceanECO/DATA}
IMG=$(val SSC_IMAGE_DIR);       IMG=${IMG:-/opt/data/SSC/images}
[[ $IMG == /opt/data/* ]] || { echo "SSC_IMAGE_DIR ($IMG) must be under /opt/data" >&2; exit 1; }
IMG_HOST=$DATA_DIR${IMG#/opt/data}   # container path → host path (DATA_DIR is mounted at /opt/data)
# Totals per rsync; a dry run gets the full stats (files to create / delete).
RS=(rsync -a --delete --mkpath --info=stats${DRY:+2} ${DRY:+--dry-run})

# ch QUERY [FORMAT]
if [ -n "${CH_HOST:-}" ]; then
  ch() { curl -sS --fail-with-body -u "${CH_USER:-default}:${CH_PASSWORD:-}" \
           --data-binary "$1${2:+ FORMAT $2}" "http://$CH_HOST:${CH_PORT:-8123}/"; }
else
  ch() { docker compose -f docker-compose.prod.api.yml --env-file "$ENV_FILE" exec -T db-ch \
           clickhouse-client -q "$1" ${2:+--format "$2"}; }
fi
# Not `mapfile < <(ch …)`: a failed query there would back up zero tables and report success.
LIST=$(ch "SELECT name FROM system.tables WHERE database='default' AND engine LIKE '%MergeTree'")
[ -n "$LIST" ] || { echo "no MergeTree tables in default" >&2; exit 1; }
mapfile -t TABLES <<< "$LIST"

# Always drop the hardlinks, or merged-away parts stay on B's disk.
unfreeze() { for t in "${TABLES[@]}"; do ch "ALTER TABLE default.\`$t\` UNFREEZE WITH NAME '$NAME'" >/dev/null || true; done; }
unfreeze   # leftovers from a run that died

STAGE=$(mktemp -d); trap 'unfreeze; rm -rf "$STAGE"' EXIT
for t in "${TABLES[@]}"; do
  ch "SHOW CREATE TABLE default.\`$t\`" TSVRaw > "$STAGE/$t.sql"
  ch "ALTER TABLE default.\`$t\` FREEZE WITH NAME '$NAME'" >/dev/null
done
"${RS[@]}" "$STAGE/" "$DEST/schema/"

for t in "${TABLES[@]}"; do
  uuid=$(ch "SELECT uuid FROM system.tables WHERE database='default' AND name='$t'")
  src="$CH_DATA_DIR/shadow/$NAME/store/${uuid:0:3}/$uuid/"
  # UNFREEZE leaves empty dirs behind, so test for contents: rsync --delete from an empty dir
  # would wipe the table's copy on the backup host.
  if [ -z "$(ls -A "$src" 2>/dev/null)" ]; then
    [ "$(ch "SELECT count() FROM system.parts WHERE active AND database='default' AND table='$t'")" = 0 ] && continue
    echo "$t has parts but none frozen under $src: wrong CH_DATA_DIR, or not running as root" >&2; exit 1
  fi
  "${RS[@]}" "$src" "$DEST/ch/$t/"
done

# Same relative path as on B (e.g. images/SSC), so --delete can't touch anything beside it.
"${RS[@]}" "$IMG_HOST/" "$DEST/${IMG#/opt/data/}/"
echo "backup to $DEST done: ${#TABLES[@]} tables + images"
