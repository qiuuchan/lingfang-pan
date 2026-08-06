import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 人民币分 -> 展示金额。负号前置到货币符号前（标准写法 -¥5.00，而非 ¥-5.00）。
export const money = (cents: number) => {
  const sign = cents < 0 ? '-' : '';
  return `${sign}¥${(Math.abs(cents) / 100).toFixed(2)}`;
};