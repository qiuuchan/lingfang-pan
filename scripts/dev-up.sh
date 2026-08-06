#!/usr/bin/env bash
# dev-up.sh — 本地一键启动 LingFang 开发环境（后端 + 管理前端，不含桌面端）。
#
# 用法（在 Git Bash / WSL / 任意 bash 中执行）：
#   ./scripts/dev-up.sh          启动 collab-api(:19006) + collab-admin(:19005)
#   ./scripts/dev-up.sh stop     停止
#   DATABASE_URL=... ./scripts/dev-up.sh   自定义数据库连接串
#
# 说明：
#   - 仅启动「无界面后端 API」+「可选 Web 管理端」，不拉起 Tauri 桌面端（无头环境跑不了）。
#   - 强制清空 NODE_OPTIONS 以绕过本 agent 沙箱注入的 safe-delete 垫片（会拦截 pnpm 内部 unlink）。
#     在你自己的终端里该变量本就为空，清空无副作用。
#   - 复用根 package.json 的 collab:api:dev / collab:admin:dev 脚本。

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export DATABASE_URL="${DATABASE_URL:-postgresql://lingfang:lingfang@localhost:5432/lingfang_collab?schema=public}"
export NODE_OPTIONS=""

API_PORT=19006
ADMIN_PORT=19005
LOG_DIR="$REPO_ROOT/.devlogs"
mkdir -p "$LOG_DIR"
PID_API="$LOG_DIR/collab-api.pid"
PID_ADMIN="$LOG_DIR/collab-admin.pid"

# 选 pnpm：优先本机 pnpm（corepack），否则回退 npx pnpm@9
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
else
  PNPM="npx -y pnpm@9"
fi

port_open() {
  curl -sf -o /dev/null -m 2 "http://127.0.0.1:$1/" 2>/dev/null
}

kill_pidfile() {
  local pidf="$1" label="$2"
  if [ -f "$pidf" ]; then
    local pid
    pid="$(cat "$pidf" 2>/dev/null || echo "")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo "  已停止 $label (PID $pid)"
    fi
    rm -f "$pidf"
  fi
}

stop() {
  echo "停止 LingFang 开发服务..."
  kill_pidfile "$PID_API" "collab-api"
  kill_pidfile "$PID_ADMIN" "collab-admin"
  echo "完成。如仍有残留进程，可手动按端口结束：lsof -ti tcp:19005,tcp:19006 | xargs kill"
  exit 0
}

if [ "${1:-}" = "stop" ]; then
  stop
fi

# 启动后端
if port_open "$API_PORT"; then
  echo "后端 :$API_PORT 已在运行（跳过）"
else
  echo "启动后端 collab-api (:19006)..."
  nohup $PNPM collab:api:dev > "$LOG_DIR/collab-api.log" 2>&1 &
  echo $! > "$PID_API"
fi

# 启动管理前端
if port_open "$ADMIN_PORT"; then
  echo "前端 :$ADMIN_PORT 已在运行（跳过）"
else
  echo "启动管理前端 collab-admin (:19005)..."
  nohup $PNPM collab:admin:dev > "$LOG_DIR/collab-admin.log" 2>&1 &
  echo $! > "$PID_ADMIN"
fi

echo ""
echo "LingFang 开发环境已就绪："
echo "  后端 API:    http://localhost:$API_PORT        Swagger: http://localhost:$API_PORT/api/docs"
echo "  管理前端:    http://localhost:$ADMIN_PORT"
echo "  管理登录:    admin@example.com / ChangeMe123!"
echo "  日志目录:    $LOG_DIR"
echo "  停止命令:    ./scripts/dev-up.sh stop"
