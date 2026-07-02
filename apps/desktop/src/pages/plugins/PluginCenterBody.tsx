// PluginCenterBody.tsx — 插件工作台「运行插件」主区内容。
//
// 本地 / 我的草稿 / 团队 / 市场四 Tab，复用原 Section 组件。
// tab 受控（来自 App state），不再与 view 同步。
// 运行某插件时调 onRun → App 设 runningPlugin（全屏接管主体区）。
// 固定常用 / 历史使用已移至主侧边栏（Sidebar，首页按钮下方），不在本页重复展示。
import { FolderIcon, ServerIcon, StoreIcon, FileEditIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { LoadedPlugin } from '@/lib/types';
import { LocalPluginsSection } from './LocalPluginsSection';
import { DraftPluginsSection } from './DraftPluginsSection';
import { MarketplacePluginsSection } from './MarketplacePluginsSection';
import { TeamPluginsSection } from './TeamPluginsSection';
import { installMarketplacePluginPackage } from '@/lib/plugin-installation';
import {
  PLUGIN_PAGE_SIZE,
  useLocalPluginList,
  useDraftPluginList,
  usePluginOpeners,
  useTeamPluginList,
  type PluginCenterTab,
} from './use-plugin-center';

export function PluginCenterBody({
  tab,
  onTabChange,
  onRun,
  onCreate,
  onClose,
}: {
  tab: PluginCenterTab;
  onTabChange: (tab: PluginCenterTab) => void;
  /** 运行某插件：由 App 设 runningPlugin。 */
  onRun: (plugin: LoadedPlugin) => void;
  /** 打开创建器（团队空态「创建插件」入口）。 */
  onCreate: () => void;
  /** 草稿编辑前的收尾回调；主区形态下通常为空操作。 */
  onClose: () => void;
}) {
  const app = useApp();
  const team = useTeamPluginList(app.runningPlugin);
  const local = useLocalPluginList(app.runningPlugin);
  const draft = useDraftPluginList(app.runningPlugin);
  const openers = usePluginOpeners(onRun);

  const totalTeam = team.items?.length ?? 0;
  const totalTeamPages = Math.max(1, Math.ceil(totalTeam / PLUGIN_PAGE_SIZE));
  const totalLocal = local.items?.length ?? 0;
  const totalLocalPages = Math.max(1, Math.ceil(totalLocal / PLUGIN_PAGE_SIZE));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <Tabs value={tab} onValueChange={(value) => onTabChange((value || 'local') as PluginCenterTab)}>
        <TabsList className="grid w-full max-w-2xl grid-cols-4 rounded-xl border-border bg-muted/40">
          <TabsTrigger value="local" className="rounded-xl"><FolderIcon className="size-3.5" />本地插件</TabsTrigger>
          <TabsTrigger value="draft" className="rounded-xl"><FileEditIcon className="size-3.5" />我的草稿</TabsTrigger>
          <TabsTrigger value="team" className="rounded-xl"><ServerIcon className="size-3.5" />团队插件</TabsTrigger>
          <TabsTrigger value="market" className="rounded-xl"><StoreIcon className="size-3.5" />市场插件</TabsTrigger>
        </TabsList>
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {tab === 'local' && (
              <TabsContent value="local" keepMounted className="mt-4 focus-visible:outline-none">
                <LocalPluginsSection
                  items={local.items ?? []}
                  loading={local.loading}
                  page={local.page}
                  setPage={local.setPage}
                  totalPages={totalLocalPages}
                  onOpen={(item) => { void openers.openLocalPlugin(item); }}
                  onOpenRoot={openers.openLocalRoot}
                  onRefresh={local.reload}
                />
              </TabsContent>
            )}
            {tab === 'draft' && (
              <TabsContent value="draft" keepMounted className="mt-4 focus-visible:outline-none">
                <DraftPluginsSection
                  items={draft.items ?? []}
                  loading={draft.loading}
                  onRun={(plugin) => { void openers.openDraftPlugin(plugin); }}
                  onRefresh={draft.reload}
                  onCreate={onCreate}
                  onClose={onClose}
                />
              </TabsContent>
            )}
            {tab === 'team' && (
              <TabsContent value="team" keepMounted className="mt-4 focus-visible:outline-none">
                <TeamPluginsSection
                  error={team.error}
                  isPinned={app.isPinned}
                  items={team.items}
                  page={team.page}
                  refreshing={team.refreshing}
                  runningPlugin={app.runningPlugin}
                  setPage={team.setPage}
                  totalPages={totalTeamPages}
                  onCreate={onCreate}
                  onOpenMarket={() => onTabChange('market')}
                  onRefresh={team.refresh}
                  onRun={(plugin) => { void openers.openTeamPlugin(plugin); }}
                  onStopPlugin={team.refresh}
                  onTogglePin={(plugin, pinned) => (pinned ? app.unpinPlugin(plugin.id) : app.pinPlugin(plugin))}
                  onUpdate={async (plugin) => {
                    // 更新插件到最新版：重新调 installMarketplacePluginPackage（后端 update version + 返回最新 files，前端重新落盘）。
                    try {
                      await installMarketplacePluginPackage(plugin.id);
                      toast.success(`已更新「${plugin.name}」到 v${plugin.version}`);
                      team.refresh();
                    } catch (e) {
                      toast.error(`更新失败：${e instanceof Error ? e.message : String(e)}`);
                    }
                  }}
                />
              </TabsContent>
            )}
            {tab === 'market' && (
              <TabsContent value="market" keepMounted className="mt-4 focus-visible:outline-none">
                <MarketplacePluginsSection active={tab === 'market'} />
              </TabsContent>
            )}
          </motion.div>
        </AnimatePresence>
      </Tabs>
    </div>
  );
}
