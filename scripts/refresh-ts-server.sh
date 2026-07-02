#!/usr/bin/env bash
set -euo pipefail

compose_file="${1:-docker-compose.ts-server.yml}"
service_name="${2:-ts-server}"
backend_health_url="${BACKEND_HEALTH_URL:-http://127.0.0.1:3001/api/health}"
timeout_seconds="${TIMEOUT_SECONDS:-180}"
sleep_seconds=5

log() {
  printf '%s\n' "$1"
}

log "Ensuring shared Docker network exists..."
docker network create ts-server-net >/dev/null 2>&1 || true

log "Pulling latest TeamSpeak image for ${service_name}..."
docker compose -f "$compose_file" pull "$service_name"

log "Recreating ${service_name}..."
docker compose -f "$compose_file" up -d --force-recreate "$service_name"

deadline=$((SECONDS + timeout_seconds))

while (( SECONDS < deadline )); do
  if curl -fsS "$backend_health_url" | grep -q '"status":"ok"'; then
    log "Backend is healthy after TS server refresh."
    exit 0
  fi

  sleep "$sleep_seconds"
done

log "Backend did not become healthy within ${timeout_seconds} seconds. Check 'docker logs --tail=120 ${service_name}' and 'docker compose ps'."
exit 1