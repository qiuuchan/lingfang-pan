import { PinIcon, PinOffIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/pagination';
import type { LoadedPlugin } from '@/lib/types';
import { StaggerContainer, StaggerItem } from '@/lib/motion';

const SOURCE_LABEL: Record<NonNullable<LoadedPlugin['source']>, string> = {
  published: '已发布',
  installed: '已安装',
  builtin: '内置',
  platform: '平台',
  team: '团队共享',
  marketplace: '市场',
};

type PluginListProps = {
  isPinned: (id: string) => boolean;
  items: LoadedPlugin[];
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
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
  onRun,
  onTogglePin,
  plugin,
}: {
  isPinned: boolean;
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  plugin: LoadedPlugin;
}) {
  const source = pluginSource(plugin);
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      <Button variant="ghost" className="flex min-w-0 flex-1 items-center justify-start gap-2 rounded-none px-0 text-left" onClick={() => onRun(plugin)}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{plugin.name}</span>
            <Badge variant={source === 'builtin' ? 'secondary' : 'outline'} className="shrink-0">
              {SOURCE_LABEL[source]}
            </Badge>
          </div>
          <div className="truncate text-sm text-muted-foreground">{plugin.description || '—'}</div>
        </div>
      </Button>
      <div className="flex shrink-0 items-center gap-2">
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
