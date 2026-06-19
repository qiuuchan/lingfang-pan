import { FolderIcon, ServerIcon, StoreIcon } from 'lucide-react';
import { useApp } from '@/App';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LocalPluginsSection } from './plugins/LocalPluginsSection';
import { MarketplacePluginsSection } from './plugins/MarketplacePluginsSection';
import { PluginRunner } from './plugins/PluginRunner';
import { TeamPluginsSection } from './plugins/TeamPluginsSection';
import {
  PLUGIN_PAGE_SIZE,
  useLocalPluginList,
  usePluginCenterTab,
  usePluginOpeners,
  useTeamPluginList,
} from './plugins/use-plugin-center';

export function Plugins() {
  const app = useApp();
  const { activeTab, changeTab } = usePluginCenterTab(app.view, app.setView);
  const team = useTeamPluginList(app.runningPlugin);
  const local = useLocalPluginList(app.runningPlugin);
  const openers = usePluginOpeners(app.setRunningPlugin);

  if (app.runningPlugin) {
    return <PluginRunner plugin={app.runningPlugin} onBack={() => app.setRunningPlugin(null)} />;
  }

  const totalTeam = team.items?.length ?? 0;
  const totalTeamPages = Math.max(1, Math.ceil(totalTeam / PLUGIN_PAGE_SIZE));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">插件</h1>
        <p className="text-sm text-muted-foreground">本地运行、团队共享、市场发现都在这里。</p>
      </div>
      <Tabs value={activeTab} onValueChange={(value) => changeTab((value || 'local') as typeof activeTab)}>
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
            onCreate={() => app.setView('creator')}
            onOpenMarket={() => changeTab('market')}
            onRefresh={team.refresh}
            onRun={(plugin) => { void openers.openTeamPlugin(plugin); }}
            onTogglePin={(plugin, pinned) => (pinned ? app.unpinPlugin(plugin.id) : app.pinPlugin(plugin))}
          />
        </TabsContent>
        <TabsContent value="market" keepMounted className="mt-4 focus-visible:outline-none">
          <MarketplacePluginsSection active={activeTab === 'market'} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
