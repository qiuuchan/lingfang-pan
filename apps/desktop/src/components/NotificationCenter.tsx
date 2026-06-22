// NotificationCenter.tsx — 全局通知中心（Task 7，参考 lingfang-v4 NotificationCenter）。
//
// 数据源：GET /api/notifications（{ notifications, unreadCount }），POST /:id/read、/read-all。
// 触发场景（后端已实现）：插件过审 / 驳回 / 下架、入驻审批、消费等；type 为自由串，前端按映射展示，
// 未知类型降级 info。新版本推送（new_version）已纳入映射，后端在发布新版本时 create 即可生效。
//
// UI：右侧 Sheet 抽屉，列出通知（未读加粗 + 类型色点），支持「全部已读」。时间用 lib/time relativeTime。
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCheckIcon, Loader2Icon, BellIcon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { relativeTime } from '@/lib/time';
import type { NotificationItem, NotificationsResponse } from '@/lib/types';

// 语义类型 → 展示元数据（色点 + 中文标签）。未知类型降级 info/「通知」。
interface TypeMeta { dot: string; label: string }
const TYPE_META: Record<string, TypeMeta> = {
  plugin_approved: { dot: 'bg-emerald-500', label: '插件过审' },
  plugin_rejected: { dot: 'bg-rose-500', label: '插件未过审' },
  plugin_delisted: { dot: 'bg-amber-500', label: '插件下架' },
  application_approved: { dot: 'bg-emerald-500', label: '入驻通过' },
  application_rejected: { dot: 'bg-rose-500', label: '入驻未通过' },
  password_reset_by_admin: { dot: 'bg-blue-500', label: '密码重置' },
  purchased: { dot: 'bg-emerald-500', label: '购买成功' },
  purchase_sale: { dot: 'bg-blue-500', label: '消费动态' },
  new_version: { dot: 'bg-violet-500', label: '新版本' },
};
const DEFAULT_META: TypeMeta = { dot: 'bg-blue-500', label: '通知' };

function metaFor(type: string): TypeMeta {
  return TYPE_META[type] || DEFAULT_META;
}

export function NotificationCenter({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [marking, setMarking] = useState(false);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<NotificationsResponse>('/api/notifications');
      setData(res);
    } catch (e) {
      // 后端不可达/未配置：静默置空（通知是辅助信息，不应刷屏报错）。
      const code = (e as ApiError).code;
      if (code) toast.error((e as ApiError).message || '加载通知失败');
      setData({ notifications: [], unreadCount: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时拉取。
  useEffect(() => {
    if (open) void fetchNotifications();
  }, [open, fetchNotifications]);

  const markAllRead = useCallback(async () => {
    setMarking(true);
    try {
      await api('/api/notifications/read-all', { method: 'POST' });
      setData((prev) => prev ? { notifications: prev.notifications.map((n) => ({ ...n, read: true })), unreadCount: 0 } : prev);
    } catch (e) {
      toast.error((e as ApiError).message || '操作失败');
    } finally {
      setMarking(false);
    }
  }, []);

  const markOneRead = useCallback(async (id: string) => {
    // 乐观更新：立即置 read，失败回滚。
    const prev = data;
    setData((cur) => cur ? {
      notifications: cur.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
      unreadCount: Math.max(0, cur.unreadCount - 1),
    } : cur);
    try {
      await api(`/api/notifications/${id}/read`, { method: 'POST' });
    } catch (e) {
      setData(prev); // 回滚
      toast.error((e as ApiError).message || '标记失败');
    }
  }, [data]);

  const items = data?.notifications ?? [];
  const unread = data?.unreadCount ?? 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <BellIcon className="size-4" />通知中心
            {unread > 0 && (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                {unread} 条未读
              </span>
            )}
          </SheetTitle>
          <SheetDescription>插件过审、新版本推送、消费等消息汇总在此。</SheetDescription>
        </SheetHeader>

        <div className="flex items-center justify-end border-b px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={markAllRead}
            disabled={marking || unread === 0}
            className="text-xs text-muted-foreground"
          >
            {marking ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : <CheckCheckIcon className="mr-1 size-3" />}
            全部已读
          </Button>
        </div>

        {loading && data === null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" />加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <BellIcon className="size-8 text-muted-foreground/40" />
            <span>暂无通知</span>
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="divide-y">
              {items.map((n) => (
                <NotificationRow key={n.id} item={n} onRead={() => void markOneRead(n.id)} />
              ))}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}

function NotificationRow({ item, onRead }: { item: NotificationItem; onRead: () => void }) {
  const meta = metaFor(item.type);
  return (
    <div className={cn('flex gap-3 px-4 py-3 transition-colors hover:bg-muted/40', !item.read && 'bg-primary/[0.03]')}>
      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', meta.dot)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-sm', !item.read ? 'font-semibold text-foreground' : 'text-foreground/80')}>
            {item.title}
          </span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{meta.label}</span>
          {!item.read && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
        </div>
        {item.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</p>}
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/70">{relativeTime(item.createdAt, '')}</span>
          {!item.read && (
            <button
              type="button"
              onClick={onRead}
              className="text-[10px] text-primary hover:underline"
            >
              标为已读
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 未读数轮询 hook（供侧边栏铃铛角标用，60s 一次，失败静默）。 */
export function useUnreadCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api<NotificationsResponse>('/api/notifications?limit=1');
        if (!cancelled) setCount(res.unreadCount ?? 0);
      } catch {
        /* 静默：后端不可达时不刷屏 */
      }
    };
    void tick();
    const timer = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [enabled]);
  return count;
}
