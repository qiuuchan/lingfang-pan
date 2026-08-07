// 团队管理子组件共享：数据加载 hook、loading 骨架、通用 helper。
import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/** 通用数据加载 hook：管理 loading/error，组件卸载后不 setState（参考 collab-admin useLoad）。
 *  返回 [data, reload, loading]。reload 可手动触发重新拉取。 */
export function useTeamResource<T>(
  path: string,
  map: (raw: unknown) => T,
  initial: T
): [T, () => Promise<void>, boolean] {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await api<unknown>(path);
      setData(map(raw));
    } catch (e) {
      // 401 由 api() 的 lf:unauthorized 事件统一处理，这里不重复 toast
      if ((e as { status?: number }).status !== 401) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);
  return [data, load, loading];
}

/** 执行写操作：成功 toast + 返回 true（供调用方决定是否关闭对话框/刷新）。失败 toast + 返回 false。 */
export async function runAction(
  fn: () => Promise<unknown>,
  success = '操作成功'
): Promise<boolean> {
  try {
    await fn();
    toast.success(success);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status !== 401) toast.error((e as Error).message);
    return false;
  }
}

export function OverviewSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/40" />
      ))}
    </div>
  );
}
