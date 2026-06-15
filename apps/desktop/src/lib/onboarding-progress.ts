// onboarding-progress.ts — 新手任务清单的纯函数持久化逻辑（与 TaskChecklist UI 解耦，便于单测）。
//
// 命名对齐现有 lf: 前缀（lf:session / lf:active-conversation / lf:pins），按 userId 隔离。
//
// key 规则：
// - 进度数组：lf:task-progress:{userId}（boolean[5]，默认全 false）。
// - 全部完成标记：lf:onboarding-done:{userId}（'1' = 已完成，不再弹）。
// userId 为 null 时用 'none' 兜底（未登录态不应出现，仅防 null 解引用）。

import type { TaskStep } from '@/components/onboarding/task-steps';

/** 进度数组的 localStorage key（按 userId 隔离）。 */
export function progressKey(userId: string | null): string {
  return `lf:task-progress:${userId || 'none'}`;
}

/** 全部完成标记的 localStorage key（按 userId 隔离）。 */
export function doneKey(userId: string | null): string {
  return `lf:onboarding-done:${userId || 'none'}`;
}

/** 从 localStorage 读取已保存的进度数组；非法/缺失时回退到全 false。 */
export function loadProgress(userId: string | null, steps: TaskStep[]): boolean[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(progressKey(userId));
  } catch {
    return steps.map(() => false);
  }
  if (!raw) return steps.map(() => false);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return steps.map(() => false);
    return steps.map((_, i) => Boolean(parsed[i]));
  } catch {
    return steps.map(() => false);
  }
}

/** 写入进度数组到 localStorage；配额满/不可用静默忽略（不阻断任务流程）。 */
export function saveProgress(userId: string | null, done: boolean[]): void {
  try {
    localStorage.setItem(progressKey(userId), JSON.stringify(done));
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

/** 是否已全部完成（不再弹清单）。 */
export function loadDone(userId: string | null): boolean {
  try {
    return localStorage.getItem(doneKey(userId)) === '1';
  } catch {
    return false;
  }
}

/** 写入全部完成标记（'1'）。 */
export function saveDone(userId: string | null): void {
  try {
    localStorage.setItem(doneKey(userId), '1');
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

/** 清除全部完成标记（用户取消某步勾选时回退，允许重新打开清单）。 */
export function clearDone(userId: string | null): void {
  try {
    localStorage.removeItem(doneKey(userId));
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

/** 判定进度数组是否全部完成。 */
export function isAllDone(done: boolean[]): boolean {
  return done.length > 0 && done.every(Boolean);
}
