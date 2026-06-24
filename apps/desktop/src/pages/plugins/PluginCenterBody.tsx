// PluginCenterBody.tsx — 插件中心悬浮窗的两栏主体（路线 A：取代原 Plugins.tsx 主区页）。
//
// 左栏：固定常用（pinnedPlugins）+ 历史使用（recentPlugins），复用 App 既有 pins/recent 基础设施。
// 右栏：本地 / 团队 / 市场三 Tab，复用原 LocalPluginsSection / TeamPluginsSection / MarketplacePluginsSection。
// tab 受控（来自 PluginCenterDialog props），不再与 view 同步（路线 A 已删插件中心 view 体系）。
// 运行某插件时调 onRun → App 设 runningPlugin（全屏 overlay 接管）并关闭本悬浮窗。
import { type ReactNode } from 'react';
import { FolderIcon, PinIcon, PinOffIcon, ServerIcon, StoreIcon, HistoryIcon } from 'lucide-react';
import { useApp } from '@/App';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PluginIcon, readPluginIcon } from '@/components/plugins/author-actions';
import type { LoadedPlugin } from '@/lib/types';
import { LocalPluginsSection } from './LocalPluginsSection';
import { MarketplacePluginsSection } from './MarketplacePluginsSection';
import { TeamPluginsSection } from './TeamPluginsSection';
import {
  PLUGIN_PAGE_SIZE,
  useLocalPluginList,
  usePluginOpeners,
  useTeamPluginList,
  type PluginCenterTab,
} from './use-plugin-center';

export function PluginCenterBody({
  tab,
  onTabChange,
  onRun,
  onCreate,
}: {
  tab: PluginCenterTab;
  onTabChange: (tab: PluginCenterTab) => void;
  /** 运行某插件：由 App 设 runningPlugin + 关闭悬浮窗。 */
  onRun: (plugin: LoadedPlugin) => void;
  /** 打开创建器（团队空态「创建插件」入口）。 */
  onCreate: () => void;
}) {
  const app = useApp();
  const team = useTeamPluginList(app.runningPlugin);
  const local = useLocalPluginList(app.runningPlugin);
  const openers = usePluginOpeners(onRun);

  const totalTeam = team.items?.length ?? 0;
  const totalTeamPages = Math.max(1, Math.ceil(totalTeam / PLUGIN_PAGE_SIZE));

  return (
    <div className="flex min-h-0 flex-1">
      <PluginCenterSidebar onRun={onRun} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <Tabs value={tab} onValueChange={(value) => onTabChange((value || 'local') as PluginCenterTab)}>
          <TabsList className="grid w-full max-w-xl grid-cols-3">
            <TabsTrigger value="local"><FolderIcon className="size-3.5" />本地插件</TabsTrigger>
            <TabsTrigger value="team"><ServerIcon className="size-3.5" />团队插件</TabsTrigger>
            <TabsTrigger value="market"><StoreIcon className="size-3.5" />市场插件</TabsTrigger>
          </TabsList>
          <TabsContent value="local" keepMounted className="mt-4 focus-visible:outline-none">
            <LocalPluginsSection
              items={local.items ?? []}
              loading={local.loading}
              onOpen={(item) => { void openers.openLocalPlugin(item); }}
              onOpenRoot={openers.openLocalRoot}
              onRefresh={local.reload}
            />
          </TabsContent>
          <TabsContent value="team" keepMounted className="mt-4 focus-visible:outline-none">
            <TeamPluginsSection
              error={team.error}
              isPinned={app.isPinned}
              items={team.items}
              page={team.page}
              refreshing={team.refreshing}
              setPage={team.setPage}
              totalPages={totalTeamPages}
              onCreate={onCreate}
              onOpenMarket={() => onTabChange('market')}
              onRefresh={team.refresh}
              onRun={(plugin) => { void openers.openTeamPlugin(plugin); }}
              onTogglePin={(plugin, pinned) => (pinned ? app.unpinPlugin(plugin.id) : app.pinPlugin(plugin))}
            />
          </TabsContent>
          <TabsContent value="market" keepMounted className="mt-4 focus-visible:outline-none">
            <MarketplacePluginsSection active={tab === 'market'} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// PluginCenterSidebar — 左侧栏：固定常用 + 历史使用（复用 App 的 pins/recent）。
function PluginCenterSidebar({ onRun }: { onRun: (plugin: LoadedPlugin) => void }) {
  const { pinnedPlugins, recentPlugins, isPinned, pinPlugin, unpinPlugin } = useApp();
  // 历史中已固定的项不再重复展示，避免与「固定常用」区冗余。
  const recentUnpinned = recentPlugins.filter((p) => !isPinned(p.id));

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-muted/30 px-3 py-4">
      {/* 固定常用 */}
      <section className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
          <PinIcon className="size-3" />固定常用
        </div>
        {pinnedPlugins.length === 0 ? (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground/60">在右侧列表点固定常用的插件，方便随时打开。</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {pinnedPlugins.map((p) => (
              <SidebarPluginItem
                key={p.id}
                plugin={p}
                actionIcon={<PinOffIcon className="size-3.5" />}
                actionTitle="取消固定"
                onAction={() => unpinPlugin(p.id)}
                onClick={() => onRun(p)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 历史使用 */}
      <section className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
          <HistoryIcon className="size-3" />历史使用
        </div>
        {recentUnpinned.length === 0 ? (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground/60">运行过的插件会出现在这里。</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {recentUnpinned.map((p) => (
              <SidebarPluginItem
                key={p.id}
                plugin={p}
                actionIcon={<PinIcon className="size-3.5" />}
                actionTitle="固定常用"
                onAction={() => pinPlugin(p)}
                onClick={() => onRun(p)}
              />
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}

function SidebarPluginItem({
  plugin,
  actionIcon,
  actionTitle,
  onAction,
  onClick,
}: {
  plugin: LoadedPlugin;
  actionIcon: ReactNode;
  actionTitle: string;
  onAction: () => void;
  onClick: () => void;
}) {
  return (
    <div className="group/item relative flex items-center">
      <button
        type="button"
        onClick={onClick}
        title={plugin.name}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'h-9 flex-1 justify-start gap-2 px-2 font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <PluginIcon icon={readPluginIcon(plugin)} className="size-5 shrink-0 rounded object-cover" />
        <span className="truncate text-sm">{plugin.name}</span>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={actionTitle}
        onClick={(e) => { e.stopPropagation(); onAction(); }}
        className="absolute right-1 size-6 opacity-0 transition-opacity group-hover/item:opacity-100"
      >
        {actionIcon}
      </Button>
    </div>
  );
}

