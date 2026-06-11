#!/usr/bin/env bash
# LingFang 一键启动脚本（macOS / Linux）。
#
# 流程：检查依赖 → 准备 .env → 启动服务端（内嵌 SQLite，自动建库）→ 等待健康 → 启动桌面壳。
# 用法：  pnpm start:sh
#   或    bash tools/start.sh
#
# 可选参数：
#   --skip-desktop   只起后端（服务端）

set -euo pipefail

SKIP_DESKTOP=0
for arg in "$@"; do
  case "$arg" in
    --skip-desktop) SKIP_DESKTOP=1 ;;
  esac
done

# 仓库根 = 本脚本所在目录的上一级。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '\033[36m[LingFang] %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m[LingFang] %s\033[0m\n' "$1"; }
warn() { printf '\033[33m[LingFang] %s\033[0m\n' "$1"; }
die()  { printf '\033[31m[LingFang] %s\033[0m\n' "$1"; exit 1; }

# ---------- 0. 依赖检查 ----------
info "检查工具链…"
command -v cargo >/dev/null 2>&1 || die "缺少 cargo，请先安装 Rust。"
command -v pnpm  >/dev/null 2>&1 || die "缺少 pnpm。"

# ---------- 1. 准备 .env（可选）----------
# 数据库默认内嵌 SQLite（lingfang.db，自动创建），无需任何外部服务。
if [ ! -f .env ] && [ -f .env.example ]; then
  info "未找到 .env，从 .env.example 复制…"
  cp .env.example .env
  warn "已生成 .env（默认开发配置）。如需自定义请编辑：$ROOT/.env"
fi

BIND_ADDR="127.0.0.1:8787"
if [ -f .env ]; then
  v="$(grep -E '^BIND_ADDR=' .env | head -1 | cut -d= -f2- || true)"
  [ -n "$v" ] && BIND_ADDR="$v"
fi

# ---------- 2. 启动服务端 ----------
info "编译并启动服务端（内嵌 SQLite，首次编译会拉取依赖）…"
mkdir -p night_runs
cargo run -p server >night_runs/server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  info "停止服务端（PID $SERVER_PID）…"
  kill "$SERVER_PID" 2>/dev/null || true
  ok "已停止。"
}
trap cleanup EXIT

# ---------- 3. 等待服务端健康 ----------
HEALTH="http://$BIND_ADDR/health"
info "等待服务端健康（$HEALTH）…"
up=0
for _ in $(seq 1 90); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    die "服务端进程已退出。查看日志：night_runs/server.log"
  fi
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then up=1; break; fi
  sleep 2
done
[ "$up" -eq 1 ] || die "服务端在 180 秒内未就绪。查看日志：night_runs/server.log"
ok "服务端已就绪：http://$BIND_ADDR"

# ---------- 4. 启动桌面壳 ----------
if [ "$SKIP_DESKTOP" -eq 1 ]; then
  trap - EXIT
  ok "后端已启动（--skip-desktop）。服务端日志：night_runs/server.log"
  info "停止：kill $SERVER_PID"
  exit 0
fi

info "启动桌面壳（Tauri）…"
pnpm -C apps/desktop dev
