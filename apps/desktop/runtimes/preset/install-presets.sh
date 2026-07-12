#!/usr/bin/env bash
# 把预装包安装进灵方桌面端内置运行时（runtimes/python、runtimes/nodejs）。
# 打包前执行一次即可；安装产物随 runtimes/ 提交。镜像源与 embedded_runtime.rs 一致。
# 用法：bash apps/desktop/runtimes/preset/install-presets.sh [--skip-python] [--skip-node]
set -euo pipefail

SKIP_PYTHON=0
SKIP_NODE=0
for arg in "$@"; do
  case "$arg" in
    --skip-python) SKIP_PYTHON=1 ;;
    --skip-node)   SKIP_NODE=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

PRESET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIMES_DIR="$(dirname "$PRESET_DIR")"

PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
PIP_TRUSTED_HOST="pypi.tuna.tsinghua.edu.cn"
NPM_REGISTRY="https://registry.npmmirror.com"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

# 内置 Python：Windows 为 python/python.exe，类 Unix 为 python/bin/python
PYTHON_EXE=""
for cand in "$RUNTIMES_DIR/python/python.exe" "$RUNTIMES_DIR/python/bin/python"; do
  [ -f "$cand" ] && PYTHON_EXE="$cand" && break
done

NODE_EXE=""
for cand in "$RUNTIMES_DIR/nodejs/node.exe" "$RUNTIMES_DIR/nodejs/bin/node"; do
  [ -f "$cand" ] && NODE_EXE="$cand" && break
done
NODE_DIR="$RUNTIMES_DIR/nodejs"
NPM_CLI="$NODE_DIR/node_modules/npm/bin/npm-cli.js"

if [ "$SKIP_PYTHON" -eq 0 ]; then
  [ -n "$PYTHON_EXE" ] || { echo "找不到内置 Python（runtimes/python）" >&2; exit 1; }
  REQ="$PRESET_DIR/requirements.txt"
  [ -f "$REQ" ] || { echo "找不到 requirements.txt：$REQ" >&2; exit 1; }

  step "升级内置 Python 的 pip"
  "$PYTHON_EXE" -m pip install --upgrade pip \
    --index-url "$PIP_INDEX_URL" --trusted-host "$PIP_TRUSTED_HOST" --disable-pip-version-check

  step "按 requirements.txt 预装 Python 包"
  "$PYTHON_EXE" -m pip install -r "$REQ" \
    --index-url "$PIP_INDEX_URL" --trusted-host "$PIP_TRUSTED_HOST" --disable-pip-version-check
fi

if [ "$SKIP_NODE" -eq 0 ]; then
  [ -n "$NODE_EXE" ] || { echo "找不到内置 Node（runtimes/nodejs）" >&2; exit 1; }
  [ -f "$NPM_CLI" ] || { echo "找不到内置 npm：$NPM_CLI" >&2; exit 1; }
  MANIFEST="$PRESET_DIR/node-globals.json"
  [ -f "$MANIFEST" ] || { echo "找不到 node-globals.json：$MANIFEST" >&2; exit 1; }

  # 用内置 node 解析 manifest 生成 name@version 列表
  SPECS=$("$NODE_EXE" -e '
    const m = require(process.argv[1]).globals || {};
    process.stdout.write(Object.entries(m).map(([n,v]) => n + "@" + v).join(" "));
  ' "$MANIFEST")

  if [ -n "$SPECS" ]; then
    step "全局预装 Node 工具链：$SPECS"
    # shellcheck disable=SC2086
    "$NODE_EXE" "$NPM_CLI" install --global --prefix "$NODE_DIR" --registry "$NPM_REGISTRY" $SPECS
  else
    step "node-globals.json 无全局包，跳过"
  fi
fi

step "预装完成"
