import { useEffect } from 'react';
import { toast } from 'sonner';

export function useLoad(effect: () => Promise<unknown>) {
  useEffect(() => {
    effect().catch((e: Error) => toast.error(e.message));
  }, []);
}

export async function run(fn: () => Promise<unknown>, success = '操作成功') {
  try {
    await fn();
    toast.success(success);
  } catch (e) {
    toast.error((e as Error).message);
  }
}