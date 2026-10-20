#!/usr/bin/env bash
# Restauration d'une sauvegarde Perspecta.
# Usage : ./scripts/restore.sh dumps/devispilot-XXXX.dump
# ATTENTION : remplace intégralement les données actuelles de la base.
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:?usage: restore.sh <fichier.dump>}"
[ -f "$FILE" ] || { echo "Fichier introuvable : $FILE"; exit 1; }

echo "⚠  Restauration de $FILE — les données actuelles seront remplacées."
read -r -p "Confirmer (tapez « restaure ») : " ok
[ "$ok" = "restaure" ] || { echo "Annulé."; exit 1; }

# Arrêt de l'API pendant la restauration pour éviter les écritures concurrentes.
docker stop devispilot-api >/dev/null 2>&1 || true

docker exec -i devispilot-db pg_restore \
  -U "${POSTGRES_USER:-devispilot}" \
  -d "${POSTGRES_DB:-devispilot}" \
  --clean --if-exists --no-owner \
  < "$FILE"

docker start devispilot-api >/dev/null 2>&1 || true
echo "Restauration terminée. Vérifier : curl -s http://127.0.0.1:${API_PORT:-3400}/api/health"
