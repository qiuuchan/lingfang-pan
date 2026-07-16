#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${AUTOMATION_TEST_REDIS_IMAGE:-redis:7-alpine}"
CONTAINER="lingfang-automation-redis-test-${$}-$(date +%s)"
TEST_DB="${AUTOMATION_TEST_REDIS_DB:-15}"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm -d \
  --name "${CONTAINER}" \
  -p 127.0.0.1::6379 \
  "${IMAGE}" \
  redis-server --appendonly yes --save 60 1 --maxmemory-policy noeviction >/dev/null

PORT="$(docker port "${CONTAINER}" 6379/tcp | awk -F: 'NR==1 {print $NF}')"
for _ in $(seq 1 80); do
  if docker exec "${CONTAINER}" redis-cli ping 2>/dev/null | grep -q '^PONG$'; then
    break
  fi
  sleep 0.25
done
docker exec "${CONTAINER}" redis-cli ping | grep -q '^PONG$'

export AUTOMATION_TEST_REDIS_URL="redis://127.0.0.1:${PORT}/${TEST_DB}"
export AUTOMATION_TEST_REDIS_PREFIX="lf:automation:test:${CONTAINER}"
pnpm -C "${ROOT_DIR}/apps/collab-api" test:automation:integration
