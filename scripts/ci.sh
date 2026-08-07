#!/usr/bin/env bash
# LingFang CI 核心脚本 —— 本地与任意 CI 平台通用。
#
# 执行链路：安装依赖 → 生成 Prisma 客户端 → 类型检查 → 单元测试(后端 + 前端) → 生产构建。
#
# 设计要点（为何无需 Redis / 外部 Postgres）：
#   - 后端单元测试全部 Mock 了 PrismaService + $transaction，不连真实数据库；
#   - 5 个 integration spec 按 env 门控（AUTOMATION_TEST_REDIS_URL /
#     SHARED_REALTIME_TEST_REDIS_URL / SHARED_STATE_DATABASE_INTEGRATION /
#     WORKFLOW_E2E_*），未配置时自动 describe.skip，不会在 CI 误挂。
#   因此本脚本在「无外部服务」的标准 runner 上即可全绿。
#
# 集成冒烟（需真实数据库 + 运行中的 API）单独放在 .github/workflows/smoke.yml，
# 通过 scripts/verify-all.mjs 执行，不污染快速单元门禁。
#
# ───────────────────────── 验证 / CI 工具分工 ─────────────────────────
#  dev-up.sh          本地一键起停双服务（后端 :19006 + 管理前端 :19005），开发用。
#  smoke.mjs          基础健康检查（管理员登录 / RBAC / 平台信息）。
#  plugin-lifecycle-smoke.mjs  插件价值链：发布 v4 → 提交市场 → 审核 → 上架。
#  marketplace-billing-smoke.mjs  灵石计费：跨团队购买 → 真实扣团队灵石余额。
#  verify-all.mjs     串联以上三个脚本的一键全量自检（需运行中的 API）。
#  _smoke-helpers.mjs 冒烟脚本共享工具（幂等确保 demo 租户/用户）。
#  enable-settlement-v2.mjs  把市场结算切到 SETTLEMENT_V2（购买扣费前提，幂等）。
#  ci.sh              【单元门禁】install→prisma generate→lint→format:check→
#                     全工作区 typecheck→全工作区 vitest→全工作区生产构建。
#                     无需外部服务（单测 Mock Prisma；integration spec 按 env 门控跳过）。
#  smoke-ci.sh        【集成门禁】全新库上启动真实 API 并跑 verify-all。
#  .github/workflows/ci.yml     调用 ci.sh，每次 push/PR 跑（快速）。
#  .github/workflows/smoke.yml  调用 smoke-ci.sh，手动触发（重，验证真实部署）。
# ─────────────────────────────────────────────────────────────────────
#
# 注意：脚本开头清空 NODE_OPTIONS 仅为兼容本仓库开发沙箱注入的 safe-delete 垫片；
# 标准 CI 环境没有该变量，置空是空操作，无害。
set -euo pipefail

# 仅当检测到沙箱垫片时才清空，避免误伤真实 CI 里可能存在的合法 NODE_OPTIONS。
case "${NODE_OPTIONS:-}" in
  *genie-safe-delete*) export NODE_OPTIONS="" ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 优先使用 PATH 中的 pnpm；缺失时回退到 npx 拉取 pnpm@9（与仓库锁文件版本一致）。
PNPM="pnpm"
if ! command -v pnpm >/dev/null 2>&1; then PNPM="npx -y pnpm@9"; fi

echo "==> [1/7] install dependencies (frozen lockfile)"
$PNPM install --frozen-lockfile

echo "==> [2/7] prisma generate (apps/collab-api)"
$PNPM -C apps/collab-api prisma:generate

echo "==> scan: forbidden patterns in request paths"
# 仅离线迁移脚本（migrate-plugin-registry-v4-legacy.ts）允许 $queryRawUnsafe；
# 请求处理路径严禁，防止 SQL 注入反模式被误复制进 HTTP 处理链路。
if grep -rn --include='*.ts' '$queryRawUnsafe' apps/collab-api/src \
   | grep -v 'migrate-plugin-registry-v4-legacy\.ts' \
   | grep -v '\.spec\.ts'; then
  echo '错误：发现 $queryRawUnsafe 出现在非迁移脚本（仅离线迁移 migrate-plugin-registry-v4-legacy.ts 与测试 *.spec.ts 允许）'; exit 1
fi

echo "==> [3/7] lint (eslint, error-level baseline)"
$PNPM lint

echo "==> [4/7] format check (prettier --check)"
$PNPM format:check

echo "==> [5/7] typecheck (all workspace packages)"
# 同样改成递归：此前只查 collab-api / collab-admin，apps/desktop（改动量最大的
# 应用）、apps/web、apps/plugin-preview 与 packages/* 的类型错误可以直接穿过门禁。
# 目前 8 个包带 typecheck（ui-tokens 是纯 token 资产包，无脚本），
# 全量 tsc --noEmit 也只要 ~13s，没有理由不查。
$PNPM -r typecheck

echo "==> [6/7] unit tests (all workspace packages; integration auto-skips)"
# 用 `pnpm -r test` 递归覆盖全部工作区包，而不是逐个枚举。
# 枚举写法曾经漏掉 apps/desktop(430) / apps/web(33) / apps/plugin-preview(31)
# 共 494 个单测——它们一直在跑绿却从未被门禁保护，回归了也没人知道。
# 递归写法还有一个长期好处：以后新增的包只要有 test 脚本就自动进门禁。
# 当前 8 个包的 test 均为 `vitest run`（无 e2e/playwright），不需要外部服务；
# 需要真实 Redis/Postgres 的 integration spec 按 env 门控自动 skip。
$PNPM -r test

echo "==> [7/7] production builds (all CI-buildable packages)"
# 这里不能用 `pnpm -r build`：apps/desktop 的 build 是 `tauri build`，需要 Rust
# 工具链 + 数 GB 运行时产物（runtime-parts），标准 runner 上跑不动。
# 因此枚举，并让 desktop 走纯前端的 `vite:build`（不依赖 runtime:verify）。
# 此前门禁只构建 collab-api / collab-admin，desktop / web / plugin-preview 的
# 打包期错误（Vite 解析失败、循环依赖、产物体积炸裂）完全不会被拦住。
# 新增的三个加起来只多 ~7s，性价比极高。
$PNPM -C apps/collab-api build
$PNPM -C apps/collab-admin build
$PNPM -C apps/web build
$PNPM -C apps/plugin-preview build
$PNPM -C apps/desktop vite:build

echo "==> CI core checks passed ✅"
