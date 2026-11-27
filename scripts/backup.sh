#!/usr/bin/env bash
# Nightly backup of the API machine to another host: ClickHouse tables + SSC image tiles.
# Online: tables are FREEZE'd (hardlinks), and parts are immutable, so rsync sends only parts
# created since the last run (plus parts rewritten by merges). Images: plain rsync mirror.
#
# Usage (as root on B, from cron):  scripts/backup.sh [ENV_FILE]   (DRY=1: rsync --dry-run, prints what would change)
#   ENV_FILE defaults to .env.prod.api (the one B's stack is started with). It must set
#   BACKUP_DEST (user@host:/path) and BACKUP_SSH (ssh command, e.g. "ssh -p 22 -i /path/key").
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

# Read values without sourcing the file (it holds tokens and isn't guaranteed shell-safe).
envval() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- | sed -E "s/^\"(.*)\"\$|^'(.*)'\$/\1\2/" || true; }
DEST=$(envval BACKUP_DEST);  : "${DEST:?set BACKUP_DEST in $ENV_FILE}"
RSYNC_RSH=$(envval BACKUP_SSH); export RSYNC_RSH=${RSYNC_RSH:?set BACKUP_SSH in $ENV_FILE}
CH_DATA_DIR=$(envval CH_DATA_DIR); CH_DATA_DIR=${CH_DATA_DIR:-/opt/OceanECO/DATA/clickhouse_data}
DATA_DIR=$(envval DATA_DIR);       DATA_DIR=${DATA_DIR:-/opt/OceanECO/DATA}
IMG=$(envval SSC_IMAGE_DIR);       IMG=${IMG:-/opt/data/SSC/images}
[[ $IMG == /opt/data/* ]] || { echo "SSC_IMAGE_DIR ($IMG) must be under /opt/data" >&2; exit 1; }
IMG_HOST=$DATA_DIR${IMG#/opt/data}   # container path → host path (DATA_DIR is mounted at /opt/data)

ch() { docker compose -f docker-compose.prod.api.yml --env-file "$ENV_FILE" exec -T db-ch clickhouse-client "$@"; }
mapfile -t TABLES < <(ch -q "SELECT name FROM system.tables WHERE database='default' AND engine LIKE '%MergeTree'")

# Always drop the hardlinks, or merged-away parts stay on B's disk.
unfreeze() { for t in "${TABLES[@]}"; do ch -q "ALTER TABLE default.\`$t\` UNFREEZE WITH NAME '$NAME'" >/dev/null || true; done; }
unfreeze   # leftovers from a run that died

STAGE=$(mktemp -d); trap 'unfreeze; rm -rf "$STAGE"' EXIT
for t in "${TABLES[@]}"; do
  ch -q "SHOW CREATE TABLE default.\`$t\`" --format TSVRaw > "$STAGE/$t.sql"
  ch -q "ALTER TABLE default.\`$t\` FREEZE WITH NAME '$NAME'" >/dev/null
done
rsync -a --delete --mkpath ${DRY:+--dry-run --stats} "$STAGE/" "$DEST/schema/"

for t in "${TABLES[@]}"; do
  uuid=$(ch -q "SELECT uuid FROM system.tables WHERE database='default' AND name='$t'")
  src="$CH_DATA_DIR/shadow/$NAME/store/${uuid:0:3}/$uuid/"
  [ -d "$src" ] || continue   # empty table: FREEZE writes nothing
  rsync -a --delete --mkpath ${DRY:+--dry-run --stats} "$src" "$DEST/ch/$t/"
done

# Same relative path as on B (e.g. images/SSC), so --delete can't touch anything beside it.
rsync -a --delete --mkpath ${DRY:+--dry-run --stats} "$IMG_HOST/" "$DEST/${IMG#/opt/data/}/"
echo "backup to $DEST done: ${#TABLES[@]} tables + images"
