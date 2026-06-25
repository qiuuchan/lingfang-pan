import { PinIcon, PinOffIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtYuan } from '@/lib/money';
import type { LoadedPlugin } from '@/lib/types';
import {
  isAuthorManaged,
  PluginDeleteDialog,
  PluginMetaEditDialog,
  PluginPriceEditDialog,
  PluginStatusToggle,
  PluginSubmitDialog,
} from '@/components/plugins/author-actions';

const SOURCE_LABEL: Record<NonNullable<LoadedPlugin['source']>, string> = {
  published: '已发布',
  installed: '已安装',
  builtin: '内置',
  platform: '平台',
  team: '团队共享',
  marketplace: '市场',
};

const REVIEW_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
};

export function TeamPluginRow({
  isPinned,
  onChanged,
  onRun,
  onTogglePin,
  plugin,
}: {
  isPinned: boolean;
  onChanged: () => void;
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  plugin: LoadedPlugin;
}) {
  const source = pluginSource(plugin);
  const authorManaged = isAuthorManaged(plugin);
  const isDisabled = plugin.status === 'DISABLED';
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      <Button variant="ghost" className="flex min-w-0 flex-1 items-center justify-start gap-3 rounded-none px-0 text-left" onClick={() => onRun(plugin)}>
        <TeamPluginSummary authorManaged={authorManaged} isDisabled={isDisabled} plugin={plugin} source={source} />
      </Button>
      <TeamPluginActions
        authorManaged={authorManaged}
        isPinned={isPinned}
        onChanged={onChanged}
        onTogglePin={onTogglePin}
        plugin={plugin}
      />
    </div>
  );
}

function TeamPluginSummary({
  authorManaged,
  isDisabled,
  plugin,
  source,
}: {
  authorManaged: boolean;
  isDisabled: boolean;
  plugin: LoadedPlugin;
  source: NonNullable<LoadedPlugin['source']>;
}) {
  return (
    <>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{plugin.name}</span>
          <Badge variant={source === 'builtin' ? 'secondary' : 'outline'} className="shrink-0">{SOURCE_LABEL[source]}</Badge>
          <ReviewBadge authorManaged={authorManaged} plugin={plugin} />
          <PriceBadge authorManaged={authorManaged} plugin={plugin} />
          {authorManaged && isDisabled && <Badge variant="destructive" className="shrink-0 text-xs">已禁用</Badge>}
        </div>
        <div className="truncate text-sm text-muted-foreground">{plugin.description || '—'}</div>
      </div>
    </>
  );
}

function ReviewBadge({ authorManaged, plugin }: { authorManaged: boolean; plugin: LoadedPlugin }) {
  if (!authorManaged || !plugin.reviewStatus) return null;
  return (
    <Badge variant={plugin.reviewStatus === 'APPROVED' ? 'secondary' : 'outline'} className="shrink-0 text-xs">
      {REVIEW_LABEL[plugin.reviewStatus] || plugin.reviewStatus}
    </Badge>
  );
}

function PriceBadge({ authorManaged, plugin }: { authorManaged: boolean; plugin: LoadedPlugin }) {
  if (!authorManaged || typeof plugin.priceCents !== 'number') return null;
  return (
    <Badge variant={plugin.priceCents > 0 ? 'default' : 'secondary'} className="shrink-0 text-xs">
      {fmtYuan(plugin.priceCents)}
    </Badge>
  );
}

function TeamPluginActions({
  authorManaged,
  isPinned,
  onChanged,
  onTogglePin,
  plugin,
}: {
  authorManaged: boolean;
  isPinned: boolean;
  onChanged: () => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  plugin: LoadedPlugin;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {authorManaged && <PluginMetaEditDialog plugin={plugin} onSaved={onChanged} />}
      {authorManaged && <PluginPriceEditDialog plugin={plugin} onSaved={onChanged} />}
      {authorManaged && <PluginSubmitDialog plugin={plugin} onSubmitted={onChanged} />}
      {authorManaged && <PluginStatusToggle plugin={plugin} onToggled={onChanged} />}
      {authorManaged && <PluginDeleteDialog plugin={plugin} onDeleted={onChanged} />}
      <span className="ml-1 text-xs text-muted-foreground">v{plugin.version}</span>
      <PinButton isPinned={isPinned} onClick={() => onTogglePin(plugin, isPinned)} />
    </div>
  );
}

function PinButton({ isPinned, onClick }: { isPinned: boolean; onClick: () => void }) {
  return (
    <Button
      variant={isPinned ? 'secondary' : 'ghost'}
      size="icon-sm"
      title={isPinned ? '已固定到侧边栏，点击取消' : '固定到侧边栏'}
      onClick={onClick}
    >
      {isPinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
    </Button>
  );
}

function pluginSource(plugin: LoadedPlugin): NonNullable<LoadedPlugin['source']> {
  return plugin.source || (plugin.builtin ? 'builtin' : 'published');
}
