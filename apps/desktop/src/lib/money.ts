// 金额工具：后端一律以「分」(cents) 传输，前端统一格式化为「¥X.XX」。

/** 规整到整数分，屏蔽后端/JS 浮点噪声。 */
export function normalizeCents(cents: number | null | undefined): number {
  const n = cents ?? 0;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** 规整到两位小数，用于灵石等以小数直接计量的余额/流水。 */
export function roundToCents(value: number | null | undefined): number {
  const n = value ?? 0;
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(n * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatCreditAmount(value: number | null | undefined): string {
  return roundToCents(value).toFixed(2);
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
