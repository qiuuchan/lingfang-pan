#!/usr/bin/env bash
#
# backup-pg.sh —— LingFang collab PG 物理/逻辑备份脚本
#
# 设计目标（对应《LingFang-工单-Beta推进-备份演练与文档-2026-08-11.md》T4 P2-5）：
#   - pg_dump -Fc 逻辑全库（可单表恢复、可跨小版本恢复）
#   - pg_dumpall --globals-only 角色/权限（恢复时先建角色，否则 pg_restore 会因属主缺失失败）
#   - 制品存储清单快照（artifact root 下文件指纹 + 总量，便于「制品恢复」对账）
#   - 按天/周/月轮转的保留策略
#   - 异地副本目录参数化（--offsite）
#
# 纪律：set -euo pipefail；任一步失败即非零退出，绝不静默成功（避免「备份成功但数据缺失」）。

set -euo pipefail

# ---------------------------------------------------------------------------
# 参数与默认
# ---------------------------------------------------------------------------
# 数据库凭据优先级：CLI --db-url > 环境变量 DATABASE_URL > 默认值
# 制品根：--artifact-root > ARTIFACT_ROOT > 默认 ./storage（与 collab-deployment 制品目录约定一致，按需覆盖）
# 备份根：--backup-root > BACKUP_ROOT > 默认 ./backups
# 异地副本：--offsite（可选，目录路径；存在则 rsync/cp 一份过去）

DB_URL="${DATABASE_URL:-postgresql://lingfang:lingfang@localhost:5432/lingfang_collab}"
BACKUP_ROOT="${BACKUP_ROOT:-backups}"
ARTIFACT_ROOT="${ARTIFACT_ROOT:-storage}"
OFFSITE_DIR=""
KEEP_DAILY=7
KEEP_WEEKLY=5
KEEP_MONTHLY=12

usage() {
  cat >&2 <<EOF
用法: $0 [选项]
  --db-url URL       数据库连接串（默认取 \$DATABASE_URL 或内置默认）
  --backup-root DIR  备份根目录（默认 \$BACKUP_ROOT 或 ./backups）
  --artifact-root DIR 制品（插件制品）存储根（默认 \$ARTIFACT_ROOT 或 ./storage）
  --offsite DIR      异地副本目录（可选；存在则同步一份）
  --keep-daily N     保留日备份数（默认 ${KEEP_DAILY}）
  --keep-weekly N    保留周备份数（默认 ${KEEP_WEEKLY}）
  --keep-monthly N   保留月备份数（默认 ${KEEP_MONTHLY}）
  -h, --help         显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-url)      DB_URL="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --artifact-root) ARTIFACT_ROOT="$2"; shift 2 ;;
    --offsite)     OFFSITE_DIR="$2"; shift 2 ;;
    --keep-daily)  KEEP_DAILY="$2"; shift 2 ;;
    --keep-weekly) KEEP_WEEKLY="$2"; shift 2 ;;
    --keep-monthly) KEEP_MONTHLY="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "[backup-pg] 未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

# 依赖检查：pg_dump/pg_dumpall/pg_isready 必须在 PATH；不在则显式失败
for bin in pg_dump pg_dumpall pg_isready; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[backup-pg] 错误: 未找到 '$bin'，请将其所在 bin 目录加入 PATH 后重试。" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 时间戳与路径
# ---------------------------------------------------------------------------
TS="$(date +%Y%m%d-%H%M%S)"
DOW="$(date +%u)"      # 1=周一 .. 7=周日
DOM="$(date +%d)"      # 日（用于月轮转判定：每月 1 号做月备）
RUN_DIR="${BACKUP_ROOT}/${TS}"
DB_NAME="$(echo "$DB_URL" | sed -E 's#.*/([^?]+).*#\1#')"

echo "[backup-pg] 开始备份 @ ${TS}"
echo "[backup-pg]   目标库: ${DB_NAME}"
echo "[backup-pg]   备份根: ${BACKUP_ROOT}"
echo "[backup-pg]   制品根: ${ARTIFACT_ROOT}"

mkdir -p "$RUN_DIR"

# ---------------------------------------------------------------------------
# 0) 连通性校验：连不上直接失败（避免产出空备份还报成功）
# ---------------------------------------------------------------------------
if ! pg_isready --dbname="$DB_URL" >/dev/null 2>&1; then
  echo "[backup-pg] 错误: 数据库不可达 (${DB_NAME})，中止备份。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1) 逻辑全库（-Fc 自定义格式，支持并行恢复与单对象恢复）
# ---------------------------------------------------------------------------
DUMP_FILE="${RUN_DIR}/${DB_NAME}.dump"
if ! pg_dump -Fc --no-owner --no-privileges --dbname="$DB_URL" -f "$DUMP_FILE"; then
  echo "[backup-pg] 错误: pg_dump 失败，备份不完整。" >&2
  exit 1
fi
echo "[backup-pg]   库转储: ${DUMP_FILE} ($(du -h "$DUMP_FILE" | cut -f1))"

# ---------------------------------------------------------------------------
# 2) 全局对象（角色/权限）—— 恢复前必须先建角色
# ---------------------------------------------------------------------------
GLOBALS_FILE="${RUN_DIR}/globals.sql"
if ! pg_dumpall --globals-only --dbname="$DB_URL" -f "$GLOBALS_FILE"; then
  echo "[backup-pg] 错误: pg_dumpall --globals-only 失败。" >&2
  exit 1
fi
echo "[backup-pg]   角色转储: ${GLOBALS_FILE} ($(du -h "$GLOBALS_FILE" | cut -f1))"

# ---------------------------------------------------------------------------
# 3) 制品存储清单快照（文件指纹 + 总量），供「制品恢复」对账
# ---------------------------------------------------------------------------
MANIFEST_FILE="${RUN_DIR}/artifacts-manifest.txt"
{
  echo "# artifact manifest @ ${TS}"
  echo "# root: ${ARTIFACT_ROOT}"
  if [[ -d "$ARTIFACT_ROOT" ]]; then
    find "$ARTIFACT_ROOT" -type f -printf '%s\t%p\n' | sort -k2
    echo "# total files: $(find "$ARTIFACT_ROOT" -type f | wc -l)"
    echo "# total bytes: $(find "$ARTIFACT_ROOT" -type f -printf '%s\n' | awk '{s+=$1} END{print s+0}')"
  else
    echo "# (artifact root 不存在，跳过清单)"
  fi
} > "$MANIFEST_FILE"
echo "[backup-pg]   制品清单: ${MANIFEST_FILE}"

# ---------------------------------------------------------------------------
# 4) 备份集元数据
# ---------------------------------------------------------------------------
cat > "${RUN_DIR}/backup-meta.txt" <<EOF
ts=${TS}
db=${DB_NAME}
db_url=${DB_URL}
pg_dump_version=$(pg_dump --version | head -1)
artifact_root=${ARTIFACT_ROOT}
EOF

# ---------------------------------------------------------------------------
# 5) 轮转（按天/周/月保留）
# ---------------------------------------------------------------------------
prune_by_keep() {
  local pattern="$1" keep="$2" label="$3"
  local dirs
  # 用 find 避免 ls 在 0 匹配时返回非零（否则 set -e 会误杀脚本）
  dirs=$(find "$BACKUP_ROOT" -maxdepth 1 -type d -name "$pattern" 2>/dev/null | sort -r)
  local count
  count=$(printf '%s\n' "$dirs" | grep -c . || true)
  if [[ "$count" -gt "$keep" ]]; then
    local excess
    excess=$((count - keep))
    echo "$dirs" | tail -n "$excess" | while read -r d; do
      echo "[backup-pg]   轮转清理(${label}): ${d}"
      rm -rf "$d"
    done
  fi
}

# 日备：全部 YYYYMMDD-* 目录，保留 KEEP_DAILY
prune_by_keep '[0-9][0-9][0-9][0-9][0-9][0-9][0-9]-*' "$KEEP_DAILY" "daily"

# 周备：周一(DOW==1)的备份升级保留
if [[ "$DOW" == "1" ]]; then
  prune_by_keep '[0-9]*-Mon-*' "$KEEP_WEEKLY" "weekly"
fi

# 月备：每月 1 号的备份升级保留
if [[ "$DOM" == "01" ]]; then
  prune_by_keep '[0-9]*-M01-*' "$KEEP_MONTHLY" "monthly"
fi

# ---------------------------------------------------------------------------
# 6) 异地副本（可选）
# ---------------------------------------------------------------------------
if [[ -n "$OFFSITE_DIR" ]]; then
  if [[ ! -d "$OFFSITE_DIR" ]]; then
    echo "[backup-pg] 警告: --offsite 目录不存在 (${OFFSITE_DIR})，跳过异地同步。" >&2
  else
    if cp -a "$RUN_DIR" "${OFFSITE_DIR}/"; then
      echo "[backup-pg]   异地副本: ${OFFSITE_DIR}/$(basename "$RUN_DIR")"
    else
      echo "[backup-pg] 错误: 异地副本同步失败。" >&2
      exit 1
    fi
  fi
fi

echo "[backup-pg] 备份完成: ${RUN_DIR}"
echo "[backup-pg] 最新备份目录: ${RUN_DIR}"
