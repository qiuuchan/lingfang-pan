import { type ReactNode } from 'react';
import { FolderOpenIcon, PackageIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Shimmer } from '@/lib/motion';
import type { LocalPluginStatus } from '@/lib/plugin-status';
import { LocalPluginRow } from './LocalPluginRow';

const PAGE_SIZE = 6;

export function LocalPluginsSection({
  items,
  loading,
  onOpen,
  onOpenRoot,
  onRefresh,
}: {
  items: LocalPluginStatus[];
  loading: boolean;
  onOpen: (item: LocalPluginStatus) => void;
  onOpenRoot: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader count={items.length} loading={loading} onOpenRoot={onOpenRoot} onRefresh={onRefresh} />
      {loading ? (
        <ListSkeleton />
      ) : items.length ? (
        <div className="flex flex-col divide-y rounded-lg border">
          {items.map((item) => (
            <LocalPluginRow key={item.id} item={item} onOpen={onOpen} onDeleted={onRefresh} />
          ))}
        </div>
      ) : (
        <EmptyLocalPlugins />
      )}
    </section>
  );
}

function SectionHeader({
  count,
  loading,
  onOpenRoot,
  onRefresh,
}: {
  count: number;
  loading: boolean;
  onOpenRoot: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">本地插件</h2>
        <span className="text-xs text-muted-foreground">{count} 个</span>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" title="打开插件存储目录" onClick={onOpenRoot}>
          <FolderOpenIcon className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" title="重新扫描本地插件状态" onClick={onRefresh}>
          <RefreshCwIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
    </div>
  );
}

function EmptyLocalPlugins() {
  return (
    <EmptyState
      icon={<PackageIcon className="size-8 text-muted-foreground/50" />}
      title="还没有本地插件"
      description="创建器生成或市场安装的插件会保存在这里，重启后仍可用。"
    />
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
      {icon}
      <span>{title}</span>
      <span className="text-xs">{description}</span>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col divide-y rounded-lg border">
      {Array.from({ length: PAGE_SIZE }).map((_, i) => (
        <Shimmer key={i} className="h-14 w-full rounded-none" />
      ))}
    </div>
  );
}
