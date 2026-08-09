// 金额工具：后端一律以「分」(cents) 传输，前端统一格式化为「¥X.XX」。
// 灵石（AI 计费货币）同样以整数分存储（1 灵石=100 分），formatCreditAmount 负责 ÷100 展示。

/** 规整到整数分，屏蔽后端/JS 浮点噪声。 */
export function normalizeCents(cents: number | null | undefined): number {
  const n = cents ?? 0;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** 灵石（整数分）格式化为展示用「X.XX」（÷100，带千分位）。后端灵石余额/流水一律为整数分。 */
export function formatCreditAmount(value: number | null | undefined): string {
  const c = value ?? 0;
  if (!Number.isFinite(c)) return '0.00';
  const cents = Math.round(c); // 已是整数分；兜底消除浮点噪声
  const safe = cents === 0 ? 0 : cents; // 把 -0 归正，避免渲染成 "-0.00"
  return (safe / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/// 分 → 「¥X.XX」。免费（0 分）返回「免费」。
export function fmtYuan(cents: number | null | undefined): string {
  const c = normalizeCents(cents);
  if (c === 0) return '免费';
  return `¥${(c / 100).toFixed(2)}`;
}

/// 分 → 纯数值「X.XX」（不带「免费」语义，用于余额显示）。
export function centsToYuan(cents: number | null | undefined): string {
  return `¥${(normalizeCents(cents) / 100).toFixed(2)}`;
}

/// 「元」输入 → 分（四舍五入到整数分）。非法输入返回 0。
export function yuanToCents(yuan: string | number): number {
  const n = typeof yuan === 'number' ? yuan : parseFloat(yuan);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}
