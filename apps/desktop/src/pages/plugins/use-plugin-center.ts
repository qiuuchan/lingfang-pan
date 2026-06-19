import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { LoadedPlugin, View } from '@/lib/types';
import { pluginCenterTabFromView, pluginCenterViewForTab, type PluginCenterTab } from '@/lib/plugin-center';
import { parseManifest } from '@/lib/plugin-draft';
import { ensurePluginPackagePersisted } from '@/lib/plugin-installation';
import {
  openPluginsRoot,
  readLocalPluginFile,
  scanPluginStatus,
  type LocalPluginStatus,
} from '@/lib/plugin-status';
import { errorMessage, loadPlugins } from '../plugins-runtime';

export const PLUGIN_PAGE_SIZE = 6;

export function usePluginCenterTab(view: View, setView: (view: View) => void) {
  const [activeTab, setActiveTab] = useState<PluginCenterTab>(() => pluginCenterTabFromView(view));
  useEffect(() => {
    if (view !== 'plugins') setActiveTab(pluginCenterTabFromView(view));
  }, [view]);

  const changeTab = useCallback((tab: PluginCenterTab) => {
    setActiveTab(tab);
    const nextView = pluginCenterViewForTab(tab);
    if (view !== nextView) setView(nextView);
  }, [setView, view]);

  return { activeTab, changeTab };
}

export function useTeamPluginList(runningPlugin: LoadedPlugin | null) {
  const [items, setItems] = useState<LoadedPlugin[] | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    const result = await loadPlugins();
    setError(result.error);
    setItems(result.plugins);
    setPage(1);
  }, []);

  const refresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    void reload().finally(() => setRefreshing(false));
  }, [refreshing, reload]);

  useEffect(() => {
    if (!runningPlugin) void reload();
  }, [runningPlugin, reload]);

  return { items, error, page, refreshing, setPage, refresh };
}

export function useLocalPluginList(runningPlugin: LoadedPlugin | null) {
  const [items, setItems] = useState<LocalPluginStatus[] | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    void scanPluginStatus()
      .then((nextItems) => setItems(nextItems))
      .catch((caught) => {
        setItems((prev) => prev ?? []);
        toast.error(`扫描本地插件失败：${errorMessage(caught)}`);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!runningPlugin) reload();
  }, [runningPlugin, reload]);

  return { items, loading, reload };
}

export function usePluginOpeners(setRunningPlugin: (plugin: LoadedPlugin) => void) {
  const openLocalPlugin = useCallback(async (item: LocalPluginStatus) => {
    try {
      const entryContent = await readLocalPluginFile(item.id, item.entry);
      setRunningPlugin(localStatusToPlugin(item, entryContent));
    } catch (caught) {
      toast.error(`打开本地插件失败：${errorMessage(caught)}`);
    }
  }, [setRunningPlugin]);

  const openTeamPlugin = useCallback(async (plugin: LoadedPlugin) => {
    const runtime = plugin.runtime_type || parseManifest(plugin.files || []).runtime_type;
    try {
      if (!plugin.builtin && runtime !== 'cloud') await ensurePluginPackagePersisted(plugin);
      setRunningPlugin(plugin);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }, [setRunningPlugin]);

  const openLocalRoot = useCallback(() => {
    void openPluginsRoot().catch((caught) => toast.error(errorMessage(caught)));
  }, []);

  return { openLocalPlugin, openTeamPlugin, openLocalRoot };
}

function localStatusToPlugin(item: LocalPluginStatus, entryContent: string): LoadedPlugin {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    version: item.version,
    entry: item.entry,
    builtin: false,
    runtime_type: 'client',
    status: item.status,
    files: [{ path: item.entry, content: entryContent }],
  };
}
