#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG="lingfang-workflow-pg-${$}"; REDIS="lingfang-workflow-redis-${$}"; TMP="$(mktemp -d)"; PG_IMAGE="${WORKFLOW_E2E_POSTGRES_IMAGE:-postgres:16}"
cleanup(){ docker rm -f "$PG" "$REDIS" >/dev/null 2>&1 || true; rm -rf "$TMP"; }; trap cleanup EXIT INT TERM
docker run -d --name "$PG" -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=lingfang -p 127.0.0.1::5432 "$PG_IMAGE" >/dev/null
docker run -d --name "$REDIS" -p 127.0.0.1::6379 redis:7-alpine redis-server --appendonly yes --save 60 1 --maxmemory-policy noeviction >/dev/null
for _ in $(seq 1 120); do docker exec "$PG" pg_isready -U test -d lingfang >/dev/null 2>&1 && docker exec "$REDIS" redis-cli ping 2>/dev/null | grep -q PONG && break; sleep .25; done
PGPORT="$(docker port "$PG" 5432/tcp | awk -F: 'NR==1{print $NF}')"; RPORT="$(docker port "$REDIS" 6379/tcp | awk -F: 'NR==1{print $NF}')"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -days 1 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' >/dev/null 2>&1
export DATABASE_PROVIDER=postgresql DATABASE_URL="postgresql://test:test@127.0.0.1:${PGPORT}/lingfang"
export WORKFLOW_E2E_DATABASE_URL="$DATABASE_URL" AUTOMATION_TEST_REDIS_URL="redis://127.0.0.1:${RPORT}/15" WORKFLOW_E2E_TLS_KEY="$TMP/key.pem" WORKFLOW_E2E_TLS_CERT="$TMP/cert.pem"
pnpm -C "$ROOT_DIR/apps/collab-api" prisma:deploy
pnpm -C "$ROOT_DIR/apps/collab-api" exec vitest run src/automation/workflow-postgres-https.integration.spec.ts --testTimeout=60000
