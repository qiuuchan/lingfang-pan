import { type ReactNode } from 'react';
import { PackageIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/pagination';
import type { LoadedPlugin } from '@/lib/types';
import { Shimmer } from '@/lib/motion';
import { TeamPluginRow } from './TeamPluginRow';

const PAGE_SIZE = 6;

type TeamPluginsSectionProps = {
  error: string;
  isPinned: (id: string) => boolean;
  items: LoadedPlugin[] | null;
  page: number;
  refreshing: boolean;
  setPage: (page: number) => void;
  totalPages: number;
  onCreate: () => void;
  onOpenMarket: () => void;
  onRefresh: () => void;
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  /** 更新插件到最新版（已安装且有新版时调用）。 */
  onUpdate?: (plugin: LoadedPlugin) => void;
};

export function TeamPluginsSection({
  error,
  isPinned,
  items,
  page,
  refreshing,
  setPage,
  totalPages,
  onCreate,
  onOpenMarket,
  onRefresh,
  onRun,
  onTogglePin,
  onUpdate,
}: TeamPluginsSectionProps) {
  const total = items?.length ?? 0;
  const pageItems = (items ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <section className="flex flex-col gap-3">
      <TeamSectionHeader count={total} disabled={refreshing || items === null} refreshing={refreshing} onRefresh={onRefresh} />
      {error && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
      <TeamSectionBody
        error={error}
        isPinned={isPinned}
        items={items}
        page={page}
        pageItems={pageItems}
        setPage={setPage}
        total={total}
        totalPages={totalPages}
        onCreate={onCreate}
        onOpenMarket={onOpenMarket}
        onRefresh={onRefresh}
        onRun={onRun}
        onTogglePin={onTogglePin}
        onUpdate={onUpdate}
      />
    </section>
  );
}

function TeamSectionHeader({
  count,
  disabled,
  refreshing,
  onRefresh,
}: {
  count: number;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">团队插件</h2>
        <span className="text-xs text-muted-foreground">{count} 个</span>
      </div>
      <Button variant="ghost" size="icon-sm" title="刷新团队插件状态" disabled={disabled} onClick={onRefresh}>
        <RefreshCwIcon className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
      </Button>
    </div>
  );
}

type TeamSectionBodyProps = Omit<TeamPluginsSectionProps, 'refreshing'> & {
  pageItems: LoadedPlugin[];
  total: number;
};

function TeamSectionBody({
  error,
  isPinned,
  items,
  page,
  pageItems,
  setPage,
  total,
  totalPages,
  onCreate,
  onOpenMarket,
  onRefresh,
  onRun,
  onTogglePin,
  onUpdate,
}: TeamSectionBodyProps) {
  if (items === null) return <ListSkeleton />;
  if (!total) return error ? null : <TeamEmptyState onCreate={onCreate} onOpenMarket={onOpenMarket} />;
  return (
    <div className="flex flex-col gap-4">
      <TeamPluginRows
        isPinned={isPinned}
        items={pageItems}
        onRefresh={onRefresh}
        onRun={onRun}
        onTogglePin={onTogglePin}
        onUpdate={onUpdate}
      />
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />
    </div>
  );
}

function TeamPluginRows({
  isPinned,
  items,
  onRefresh,
  onRun,
  onTogglePin,
  onUpdate,
}: {
  isPinned: (id: string) => boolean;
  items: LoadedPlugin[];
  onRefresh: () => void;
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  onUpdate?: (plugin: LoadedPlugin) => void;
}) {
  return (
    <div className="flex flex-col divide-y rounded-lg border">
      {items.map((plugin) => (
        <TeamPluginRow
          key={plugin.id}
          isPinned={isPinned(plugin.id)}
          plugin={plugin}
          onChanged={onRefresh}
          onRun={onRun}
          onTogglePin={onTogglePin}
          onUpdate={onUpdate}
        />
      ))}
    </div>
  );
}

function TeamEmptyState({ onCreate, onOpenMarket }: { onCreate: () => void; onOpenMarket: () => void }) {
  return (
    <EmptyState
      icon={<PackageIcon className="size-8 text-muted-foreground/50" />}
      title="还没有可运行的团队插件"
      actions={(
        <>
          <Button variant="outline" size="sm" onClick={onCreate}>去创建插件</Button>
          <Button variant="outline" size="sm" onClick={onOpenMarket}>去市场安装</Button>
        </>
      )}
    />
  );
}

function EmptyState({
  icon,
  title,
  actions,
}: {
  icon: ReactNode;
  title: string;
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
      {icon}
      <span>{title}</span>
      <div className="flex gap-2">{actions}</div>
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
