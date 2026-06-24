// PluginCenterBody.tsx — 插件中心悬浮窗主体（路线 A：取代原 Plugins.tsx 主区页）。
//
// 本地 / 团队 / 市场三 Tab，复用原 LocalPluginsSection / TeamPluginsSection / MarketplacePluginsSection。
// tab 受控（来自 PluginCenterDialog props），不再与 view 同步（路线 A 已删插件中心 view 体系）。
// 运行某插件时调 onRun → App 设 runningPlugin（全屏 overlay 接管）并关闭本悬浮窗。
// 固定常用 / 历史使用已移至主侧边栏（Sidebar，首页按钮下方），不在本悬浮窗内。
import { FolderIcon, ServerIcon, StoreIcon } from 'lucide-react';
import { useApp } from '@/App';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  );
}
