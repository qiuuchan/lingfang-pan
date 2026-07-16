#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_IMAGE="${SHARED_STATE_TEST_POSTGRES_IMAGE:-postgres:16}"
MYSQL_IMAGE="${SHARED_STATE_TEST_MYSQL_IMAGE:-mysql:8.0}"
PG_CONTAINER="lingfang-shared-state-pg-${$}-$(date +%s)"
MYSQL_CONTAINER="lingfang-shared-state-mysql-${$}-$(date +%s)"
CLIENT_PROVIDER="postgresql"

restore_postgres_client() {
  if [[ "${CLIENT_PROVIDER}" != "mysql" ]]; then return; fi
  DATABASE_PROVIDER=postgresql \
  DATABASE_URL="postgresql://restore:restore@127.0.0.1:5432/restore" \
    pnpm -C "${ROOT_DIR}/apps/collab-api" prisma:generate >/dev/null 2>&1 || true
  CLIENT_PROVIDER="postgresql"
}

cleanup() {
  docker rm -f "${PG_CONTAINER}" "${MYSQL_CONTAINER}" >/dev/null 2>&1 || true
  restore_postgres_client
}
trap cleanup EXIT INT TERM

run_spec() {
  export SHARED_STATE_DATABASE_INTEGRATION=1
  pnpm -C "${ROOT_DIR}/apps/collab-api" test:shared-state:database:integration
}

docker run --rm -d \
  --name "${PG_CONTAINER}" \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=test \
  -e POSTGRES_DB=lingfang \
  -p 127.0.0.1::5432 \
  "${PG_IMAGE}" >/dev/null
for _ in $(seq 1 120); do
  if docker exec "${PG_CONTAINER}" pg_isready -U test -d lingfang >/dev/null 2>&1; then break; fi
  sleep 0.25
done
docker exec "${PG_CONTAINER}" pg_isready -U test -d lingfang >/dev/null
PG_PORT="$(docker port "${PG_CONTAINER}" 5432/tcp | awk -F: 'NR==1 {print $NF}')"
export DATABASE_PROVIDER=postgresql
export DATABASE_URL="postgresql://test:test@127.0.0.1:${PG_PORT}/lingfang"
pnpm -C "${ROOT_DIR}/apps/collab-api" prisma:generate
pnpm -C "${ROOT_DIR}/apps/collab-api" prisma:deploy
run_spec
docker rm -f "${PG_CONTAINER}" >/dev/null

docker run --rm -d \
  --name "${MYSQL_CONTAINER}" \
  -e MYSQL_ROOT_PASSWORD=test \
  -e MYSQL_DATABASE=lingfang \
  -e MYSQL_USER=test \
  -e MYSQL_PASSWORD=test \
  -p 127.0.0.1::3306 \
  "${MYSQL_IMAGE}" \
  --default-authentication-plugin=mysql_native_password >/dev/null
for _ in $(seq 1 180); do
  if docker exec "${MYSQL_CONTAINER}" mysqladmin ping -uroot -ptest --silent >/dev/null 2>&1 \
    && docker exec "${MYSQL_CONTAINER}" mysql -utest -ptest -D lingfang -Nse 'SELECT 1' 2>/dev/null | grep -q '^1$'; then break; fi
  sleep 0.5
done
docker exec "${MYSQL_CONTAINER}" mysqladmin ping -uroot -ptest --silent >/dev/null
docker exec "${MYSQL_CONTAINER}" mysql -utest -ptest -D lingfang -Nse 'SELECT 1' 2>/dev/null | grep -q '^1$'
sleep 1
MYSQL_PORT="$(docker port "${MYSQL_CONTAINER}" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
export DATABASE_PROVIDER=mysql
export DATABASE_URL="mysql://test:test@127.0.0.1:${MYSQL_PORT}/lingfang"
pnpm -C "${ROOT_DIR}/apps/collab-api" prisma:generate
CLIENT_PROVIDER="mysql"
pnpm -C "${ROOT_DIR}/apps/collab-api" prisma:deploy
run_spec
restore_postgres_client
