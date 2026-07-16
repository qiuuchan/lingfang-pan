// NotificationCenter.tsx — 全局通知中心（Task 7，参考 lingfang-v4 NotificationCenter）。
//
// 数据源：GET /api/notifications（{ notifications, unreadCount }），POST /:id/read、/read-all。
// 触发场景（后端已实现）：插件过审 / 驳回 / 下架、入驻审批、消费等；type 为自由串，前端按映射展示，
// 未知类型降级 info。新版本推送（new_version）已纳入映射，后端在发布新版本时 create 即可生效。
//
// UI：右侧 Sheet 抽屉，列出通知（未读加粗 + 类型色点），支持「全部已读」。时间用 lib/time relativeTime。
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  BellIcon,
  BellRingIcon,
  CheckCheckIcon,
  CircleCheckBigIcon,
  Clock3Icon,
  InfoIcon,
  KeyRoundIcon,
  Loader2Icon,
  PackageCheckIcon,
  PackageXIcon,
  ShoppingBagIcon,
  SparklesIcon,
  StoreIcon,
  type LucideIcon,
} from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { dragRegionProps } from '@/lib/window-drag';
import { relativeTime } from '@/lib/time';
import type { NotificationItem, NotificationsResponse } from '@/lib/types';

// 语义类型 → 展示元数据（色点 + 中文标签）。未知类型降级 info/「通知」。
interface TypeMeta { icon: LucideIcon; iconClass: string; iconBg: string; label: string }
const TYPE_META: Record<string, TypeMeta> = {
  plugin_approved: { icon: PackageCheckIcon, iconClass: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-500/10', label: '插件过审' },
  plugin_rejected: { icon: PackageXIcon, iconClass: 'text-destructive', iconBg: 'bg-destructive/10', label: '插件未过审' },
  plugin_delisted: { icon: PackageXIcon, iconClass: 'text-amber-600 dark:text-amber-400', iconBg: 'bg-amber-500/10', label: '插件下架' },
  application_approved: { icon: StoreIcon, iconClass: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-500/10', label: '入驻通过' },
  application_rejected: { icon: StoreIcon, iconClass: 'text-destructive', iconBg: 'bg-destructive/10', label: '入驻未通过' },
  password_reset_by_admin: { icon: KeyRoundIcon, iconClass: 'text-primary', iconBg: 'bg-primary/10', label: '密码重置' },
  purchased: { icon: ShoppingBagIcon, iconClass: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-500/10', label: '购买成功' },
  purchase_sale: { icon: ShoppingBagIcon, iconClass: 'text-primary', iconBg: 'bg-primary/10', label: '消费动态' },
  new_version: { icon: SparklesIcon, iconClass: 'text-violet-600 dark:text-violet-400', iconBg: 'bg-violet-500/10', label: '新版本' },
};
const DEFAULT_META: TypeMeta = { icon: InfoIcon, iconClass: 'text-primary', iconBg: 'bg-primary/10', label: '通知' };

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 项 3：改居中悬浮窗（原右侧 Sheet 抽屉）。与钱包/团队/设置面板一致的 Dialog 形态。 */}
      <DialogContent className="flex h-[72vh] max-h-[72vh] w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4" {...dragRegionProps}>
          <DialogTitle className="flex items-center gap-2" data-tauri-drag-region>
            <BellIcon className="size-4" />通知中心
            {unread > 0 && (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                {unread} 条未读
              </span>
            )}
          </DialogTitle>
          <DialogDescription>插件过审、新版本推送、消费等消息汇总在此。</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-4 border-b bg-muted/20 px-5 py-3">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <BellRingIcon className="size-3.5 text-primary" />
              <strong className="font-semibold text-foreground">{unread}</strong> 条未读
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CircleCheckBigIcon className="size-3.5" />
              {Math.max(0, items.length - unread)} 条已读
            </span>
          </div>
          <LoadingButton
            variant="outline"
            size="sm"
            onClick={markAllRead}
            loading={marking}
            disabled={marking || unread === 0}
            className="text-xs"
          >
            {!marking && <CheckCheckIcon />}
            全部已读
          </LoadingButton>
        </div>

        {loading && data === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <span className="flex size-11 items-center justify-center rounded-full bg-muted">
              <Loader2Icon className="size-5 animate-spin text-primary" />
            </span>
            正在同步通知…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
              <BellIcon className="size-6" />
            </span>
            <h3 className="mt-4 text-sm font-semibold text-foreground">消息已经处理完毕</h3>
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">插件审核、版本更新和团队消费动态会集中显示在这里。</p>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1 bg-muted/15">
            <div className="m-4 divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
              {items.map((n) => (
                <NotificationRow key={n.id} item={n} onRead={() => void markOneRead(n.id)} />
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NotificationRow({ item, onRead }: { item: NotificationItem; onRead: () => void }) {
  const meta = metaFor(item.type);
  const TypeIcon = meta.icon;
  return (
    <div className={cn('group flex gap-3.5 px-4 py-3.5 transition-colors hover:bg-muted/35', !item.read && 'bg-primary/[0.04]')}>
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', meta.iconBg, meta.iconClass)}>
        <TypeIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span className={cn('truncate text-sm', !item.read ? 'font-semibold text-foreground' : 'text-foreground/80')}>
            {item.title}
          </span>
          <span className="shrink-0 rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">{meta.label}</span>
          {!item.read && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary ring-2 ring-primary/15" />}
        </div>
        {item.body && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.body}</p>}
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
            <Clock3Icon className="size-3" />{relativeTime(item.createdAt, '')}
          </span>
          {!item.read && (
            <Button type="button" variant="ghost" size="xs" onClick={onRead} className="h-6 px-2 text-[10px] text-primary opacity-80 hover:text-primary group-hover:opacity-100">
              <CheckCheckIcon className="size-3" />
              标为已读
            </Button>
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
