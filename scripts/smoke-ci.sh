#!/usr/bin/env bash
# LingFang 集成冒烟：在「全新数据库」上启动真实 API 并跑通 verify-all.mjs。
# 与 ci.sh（单元门禁）互补：ci.sh 不依赖外部服务；本脚本验证「真实运行中的 API」三链路。
#
# 步骤：安装 → prisma generate → 复制 .env(example) → db:setup(migrate+seed)
#       → 切 SETTLEMENT_V2 → 构建并后台启动 API → 等待健康 → verify-all → 关闭 API。
# 前置：本机需有可达的 PostgreSQL（CI 用 postgres 服务容器；本地用 dev-up.sh 起的服务或既有库）。
set -euo pipefail

case "${NODE_OPTIONS:-}" in
  *genie-safe-delete*) export NODE_OPTIONS="" ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PNPM="pnpm"
if ! command -v pnpm >/dev/null 2>&1; then PNPM="npx -y pnpm@9"; fi

echo "==> [1/8] install dependencies"
$PNPM install --frozen-lockfile

echo "==> [2/8] prisma generate"
$PNPM -C apps/collab-api prisma:generate

echo "==> [3/8] prepare .env (from .env.example) for the API"
cp apps/collab-api/.env.example apps/collab-api/.env

echo "==> [4/8] db:setup (migrate + seed admin/rbac/billing/releases)"
$PNPM -C apps/collab-api db:setup

echo "==> [5/8] enable SETTLEMENT_V2 (购买真实扣灵石的前提)"
node scripts/enable-settlement-v2.mjs

echo "==> [6/8] build collab-api"
$PNPM -C apps/collab-api build

echo "==> [7/8] start API in background (PORT 19006)"
$PNPM -C apps/collab-api start &
API_PID=$!

echo "==> waiting for API health (http://localhost:19006/api/platform-info)"
UP=0
for i in $(seq 1 60); do
  if curl -sf http://localhost:19006/api/platform-info >/dev/null 2>&1; then echo "   API is up"; UP=1; break; fi
  sleep 2
done
if [ "$UP" -ne 1 ]; then
  echo "FAIL ❌ API 未在预期时间内就绪"
  kill "$API_PID" 2>/dev/null || true
  exit 1
fi

echo "==> [8/8] run verify-all (插件价值链 + 灵石计费购买 + 健康检查)"
set +e
node scripts/verify-all.mjs
RC=$?
set -e

kill "$API_PID" 2>/dev/null || true
if [ "$RC" -eq 0 ]; then echo "==> SMOKE PASSED ✅"; else echo "==> SMOKE FAILED ❌ (rc=$RC)"; fi
exit "$RC"
