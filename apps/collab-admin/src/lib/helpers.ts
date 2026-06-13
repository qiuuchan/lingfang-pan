import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

// ADMIN-VIEW-07 修复：useLoad 此前无 cleanup / 无 mounted 标志，
// 视图切换卸载组件后 in-flight 请求 resolve 仍 setState（React 18 不再告警但仍是无意义更新），
// 且 .catch 的 toast 在新视图上下文弹出「孤儿 toast」（在「用户」页看到「审计日志」错误）。
// 现加 mounted 标志：resolve/catch 前判断，卸载后不再 setState 与弹 toast。
// ADMIN-01：401 错误已由 api() 的 UNAUTHORIZED 事件路径处理（App.tsx handler 已清 session + toast），
// 此处对 401 不再重复 toast，避免「孤儿 toast」叠加。
export function useLoad(effect: () => Promise<unknown>) {
  useEffect(() => {
    let mounted = true;
    effect()
      .then(() => {
        // 仅消费副作用（已由调用方 setState），无需在此处理；保留 then 链以驱动 catch。
      })
      .catch((e: Error & { status?: number }) => {
        if (!mounted) return; // 卸载后不弹孤儿 toast
        if (e.status === 401) return; // 401 由 UNAUTHORIZED 事件路径统一处理
        toast.error(e.message);
      });
    return () => {
      mounted = false;
    };
  }, []);
}

// ADMIN-VIEW-04 修复：run 此前 try/await/catch 后永远 resolve、不 rethrow 也不返回结果，
// 所有 `await run(...)` 之后的 `setOpen(false)` 无条件执行，导致失败提交也被关闭对话框，
// 用户辛苦填写的表单草稿因下次打开 handleOpen 从 user 对象 reset 而全部丢失。
// 现返回 boolean：成功 true / 失败 false（内部已 toast.error 给出反馈）。
// 调用方约定：`if (await run(...)) setOpen(false);` —— 仅成功才关闭对话框，失败时保留草稿供用户修正重试。
// ADMIN-01：401 错误由 UNAUTHORIZED 事件路径统一处理（App.tsx handler 已清 session + toast），此处不重复 toast。
export async function run(fn: () => Promise<unknown>, success = '操作成功'): Promise<boolean> {
  try {
    await fn();
    toast.success(success);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status !== 401) toast.error((e as Error).message);
    return false;
  }
}

// ADMIN-VIEW-01 修复：提供防重入守卫 hook。
// 余额调整等资金类操作无后端幂等键，前端必须防止双击导致重复 CREDIT/DEBIT。
// 返回 [busy, guard]：busy 用于按钮 disabled + loading 态；guard 包裹异步操作，
// 在 in-flight 期间重复调用直接返回（不触发第二次后端请求）。
export function useGuardedAction() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (inFlight.current) return undefined; // 防重入：已有 in-flight 请求，直接返回
    inFlight.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return [busy, guard] as const;
}
