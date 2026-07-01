import { useState } from 'react';
import { PinIcon, PinOffIcon, RefreshCwIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
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
  onUpdate,
  plugin,
}: {
  isPinned: boolean;
  onChanged: () => void;
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  /** 更新插件到最新版（仅已安装且有新版时传入）。 */
  onUpdate?: (plugin: LoadedPlugin) => void;
  plugin: LoadedPlugin;
}) {
  const source = pluginSource(plugin);
  const authorManaged = isAuthorManaged(plugin);
  const isDisabled = plugin.status === 'DISABLED';
  // 有更新：已安装且云端版本 > 已安装版本。
  const hasUpdate = Boolean(plugin.installedVersion && isVersionNewer(plugin.version, plugin.installedVersion));
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      <Button variant="ghost" className="flex min-w-0 flex-1 items-center justify-start gap-3 rounded-none px-0 text-left" onClick={() => onRun(plugin)}>
        <TeamPluginSummary authorManaged={authorManaged} isDisabled={isDisabled} plugin={plugin} source={source} />
      </Button>
      <TeamPluginActions
        authorManaged={authorManaged}
        hasUpdate={hasUpdate}
        isPinned={isPinned}
        onChanged={onChanged}
        onTogglePin={onTogglePin}
        onUpdate={onUpdate}
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
  hasUpdate,
  isPinned,
  onChanged,
  onTogglePin,
  onUpdate,
  plugin,
}: {
  authorManaged: boolean;
  hasUpdate: boolean;
  isPinned: boolean;
  onChanged: () => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  onUpdate?: (plugin: LoadedPlugin) => void;
  plugin: LoadedPlugin;
}) {
  const [updating, setUpdating] = useState(false);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {authorManaged && <PluginMetaEditDialog plugin={plugin} onSaved={onChanged} />}
      {authorManaged && <PluginPriceEditDialog plugin={plugin} onSaved={onChanged} />}
      {authorManaged && <PluginSubmitDialog plugin={plugin} onSubmitted={onChanged} />}
      {authorManaged && <PluginStatusToggle plugin={plugin} onToggled={onChanged} />}
      {authorManaged && <PluginDeleteDialog plugin={plugin} onDeleted={onChanged} />}
      {/* 有新版可更新：显示更新按钮（带最新版本号）。非作者也能更新自己安装的插件。 */}
      {hasUpdate && onUpdate && (
        <LoadingButton
          variant="outline"
          size="sm"
          loading={updating}
          className="h-7 gap-1.5 border-blue-500/40 px-2.5 text-xs text-blue-600 hover:bg-blue-500/5 dark:text-blue-400"
          onClick={async () => {
            setUpdating(true);
            try { await onUpdate(plugin); } finally { setUpdating(false); }
          }}
          title={`更新到 v${plugin.version}（当前 v${plugin.installedVersion}）`}
        >
          <RefreshCwIcon className="size-3" />
          更新 v{plugin.version}
        </LoadingButton>
      )}
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

/** 语义版本比较：newVer 是否严格大于 oldVer（x.y.z）。非法格式按 0.0.0 处理。 */
function isVersionNewer(newVer: string, oldVer: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const [a1, a2, a3] = parse(newVer);
  const [b1, b2, b3] = parse(oldVer);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
