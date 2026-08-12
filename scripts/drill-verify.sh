#!/usr/bin/env bash
#
# drill-verify.sh —— 恢复演练的反向断言校验器
#
# 核心纪律（对应工单 T4 验收「破坏必须能被检出」）：
#   恢复不完整 / 数据缺失 / 注水流水残留 时，本脚本**非零退出**（红），
#   绝不出现「恢复成功但数据缺失」的静默成功。
#
# 用法: drill-verify.sh --db-url URL [--expect baseline.tsv]
#   baseline.tsv 每行: 表名<TAB>期望行数（缺省用内置已知良好基线）

set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://lingfang:lingfang@127.0.0.1:5444/lingfang_collab}"
EXPECT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-url) DB_URL="$2"; shift 2 ;;
    --expect) EXPECT_FILE="$2"; shift 2 ;;
    *) echo "[drill-verify] 未知参数: $1" >&2; exit 2 ;;
  esac
done

for bin in psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[drill-verify] 错误: 未找到 '$bin'" >&2; exit 1; fi
done

# 已知良好基线（与演练 seed 一致）：表名<TAB>期望行数
DEFAULT_BASELINE="$(cat <<'EOF'
Wallet	1
WalletTransaction	1
PluginPackage	1
PluginRelease	1
Team	1
User	1
Role	1
CreditLedger	1
TeamCredit	1
_prisma_migrations	56
EOF
)"

BASELINE="${EXPECT_FILE:+$(cat "$EXPECT_FILE")}"
BASELINE="${BASELINE:-$DEFAULT_BASELINE}"

fail=0
echo "[drill-verify] 校验恢复完整性 @ $(date +%H:%M:%S)"
while IFS=$'\t' read -r tbl expect; do
  [[ -z "$tbl" || "$tbl" == \#* ]] && continue
  actual=$(psql -h 127.0.0.1 -p 5444 -U lingfang -d lingfang_collab -tAc "SELECT COUNT(*) FROM \"$tbl\"" 2>/dev/null || echo "ERR")
  if [[ "$actual" != "$expect" ]]; then
    echo "[drill-verify] 失败: 表 $tbl 期望=$expect 实际=$actual"
    fail=1
  else
    echo "[drill-verify] OK: $tbl = $actual"
  fi
done <<< "$BASELINE"

# 反向断言：注水的坏数据必须不存在（被恢复清除）
INJECTED=$(psql -h 127.0.0.1 -p 5444 -U lingfang -d lingfang_collab -tAc "SELECT COUNT(*) FROM \"WalletTransaction\" WHERE reason='DRILL_INJECTED_BAD'" 2>/dev/null || echo "ERR")
if [[ "$INJECTED" != "0" ]]; then
  echo "[drill-verify] 失败(反向断言): 注水流水残留 $INJECTED 行（恢复未清除污染）"
  fail=1
else
  echo "[drill-verify] OK(反向断言): 注水流水已清除"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "[drill-verify] 结论: 红 —— 恢复不完整或被污染"
  exit 1
fi
echo "[drill-verify] 结论: 绿 —— 恢复完整且污染已清除"
