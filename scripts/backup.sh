#!/usr/bin/env bash
# Sauvegarde PostgreSQL DevisPilot → dumps/devispilot-YYYYmmdd-HHMMSS.dump
# Usage : ./scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${BACKUP_DIR:-dumps}"
mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/devispilot-$(date +%Y%m%d-%H%M%S).dump"

docker exec devispilot-db pg_dump \
  -U "${POSTGRES_USER:-devispilot}" \
  -d "${POSTGRES_DB:-devispilot}" \
  --format=custom --compress=6 \
  > "$FILE"

echo "Sauvegarde écrite : $FILE ($(du -h "$FILE" | cut -f1))"
