import { PinIcon, PinOffIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/pagination';
import { fmtYuan } from '@/lib/money';
import type { LoadedPlugin } from '@/lib/types';
import { StaggerContainer, StaggerItem } from '@/lib/motion';
import {
  isAuthorManaged,
  PluginDeleteDialog,
  PluginPriceEditDialog,
  PluginStatusToggle,
} from '@/components/plugins/author-actions';

const SOURCE_LABEL: Record<NonNullable<LoadedPlugin['source']>, string> = {
  published: '已发布',
  installed: '已安装',
  builtin: '内置',
  platform: '平台',
  team: '团队共享',
  marketplace: '市场',
};

// 审核状态 → 中文 + Badge variant（仅作者自己能看到，列表卡片角标提示当前审核进度）。
const REVIEW_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
};

type PluginListProps = {
  isPinned: (id: string) => boolean;
  items: LoadedPlugin[];
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  /** 作者改价/切状态成功后回调，触发外层重新 loadPlugins 刷新列表。 */
  onAuthorChanged?: () => void;
  page: number;
  setPage: (page: number) => void;
  totalPages: number;
};

function pluginSource(plugin: LoadedPlugin): NonNullable<LoadedPlugin['source']> {
  return plugin.source || (plugin.builtin ? 'builtin' : 'published');
}

export function PluginList(props: PluginListProps) {
  const { isPinned, items, onRun, onTogglePin, page, setPage, totalPages } = props;
  return (
    <div className="flex flex-col gap-4">
      {/* 列表项交错入场（尊重 useReducedMotion），每项轻微悬停反馈。 */}
      <StaggerContainer className="flex flex-col divide-y rounded-lg border" stagger={0.05}>
        {items.map((plugin) => (
          <StaggerItem key={plugin.id} whileHover={{ x: 2, transition: { type: 'spring', stiffness: 300, damping: 20 } }}>
            <PluginListItem
              isPinned={isPinned(plugin.id)}
              onAuthorChanged={props.onAuthorChanged}
              onRun={onRun}
              onTogglePin={onTogglePin}
              plugin={plugin}
            />
          </StaggerItem>
        ))}
      </StaggerContainer>
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />
    </div>
  );
}

function PluginListItem({
  isPinned,
  onAuthorChanged,
  onRun,
  onTogglePin,
  plugin,
}: {
  isPinned: boolean;
  onAuthorChanged?: () => void;
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  plugin: LoadedPlugin;
}) {
  const source = pluginSource(plugin);
  const authorManaged = isAuthorManaged(plugin);
  const isDisabled = plugin.status === 'DISABLED';
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      <Button variant="ghost" className="flex min-w-0 flex-1 items-center justify-start gap-2 rounded-none px-0 text-left" onClick={() => onRun(plugin)}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{plugin.name}</span>
            <Badge variant={source === 'builtin' ? 'secondary' : 'outline'} className="shrink-0">
              {SOURCE_LABEL[source]}
            </Badge>
            {/* 作者插件展示审核状态 + 价格 + 启用态，便于作者一眼看到当前进度。 */}
            {authorManaged && plugin.reviewStatus && (
              <Badge variant={plugin.reviewStatus === 'APPROVED' ? 'secondary' : 'outline'} className="shrink-0 text-xs">
                {REVIEW_LABEL[plugin.reviewStatus] || plugin.reviewStatus}
              </Badge>
            )}
            {authorManaged && typeof plugin.priceCents === 'number' && (
              <Badge variant={plugin.priceCents > 0 ? 'default' : 'secondary'} className="shrink-0 text-xs">
                {fmtYuan(plugin.priceCents)}
              </Badge>
            )}
            {authorManaged && isDisabled && (
              <Badge variant="destructive" className="shrink-0 text-xs">已禁用</Badge>
            )}
          </div>
          <div className="truncate text-sm text-muted-foreground">{plugin.description || '—'}</div>
        </div>
      </Button>
      <div className="flex shrink-0 items-center gap-2">
        {authorManaged && <PluginPriceEditDialog plugin={plugin} onSaved={onAuthorChanged} />}
        {authorManaged && <PluginStatusToggle plugin={plugin} onToggled={onAuthorChanged} />}
        {authorManaged && <PluginDeleteDialog plugin={plugin} onDeleted={onAuthorChanged} />}
        <span className="text-xs text-muted-foreground">v{plugin.version}</span>
        <Button
          variant={isPinned ? 'secondary' : 'ghost'}
          size="icon-sm"
          title={isPinned ? '已固定到侧边栏，点击取消' : '固定到侧边栏'}
          onClick={() => onTogglePin(plugin, isPinned)}
        >
          {isPinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
