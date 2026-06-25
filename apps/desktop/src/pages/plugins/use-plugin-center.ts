import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { LoadedPlugin } from '@/lib/types';
import { parseManifest } from '@/lib/plugin-draft';
import { ensurePluginPackagePersisted } from '@/lib/plugin-installation';
import { listDraftPlugins, deleteDraftPlugin, loadDraftPlugin } from '@/lib/draft-plugin';
import {
  openPluginsRoot,
  readLocalPluginFile,
  scanPluginStatus,
  type LocalPluginStatus,
} from '@/lib/plugin-status';
import { errorMessage, loadPlugins } from '../plugins-runtime';

export const PLUGIN_PAGE_SIZE = 6;

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

// 路线 A：插件中心改为悬浮窗后，tab 不再映射 view（已删 plugins/author-center/market view）。
// PluginCenterTab 类型随之内聚到本模块，供悬浮窗内部本地 state 使用。
// task 06-25：新增 'draft'（我的草稿）—— AI 创建器保存的本地草稿插件。
export type PluginCenterTab = 'local' | 'draft' | 'team' | 'market';

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

// task 06-25：本地草稿插件列表（AI 创建器保存的草稿）。
export function useDraftPluginList(runningPlugin: LoadedPlugin | null) {
  const [items, setItems] = useState<LoadedPlugin[] | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    void listDraftPlugins()
      .then((drafts) => setItems(drafts))
      .catch((caught) => {
        setItems((prev) => prev ?? []);
        toast.error(`加载草稿失败：${errorMessage(caught)}`);
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
      // 统一中转页：所有本地插件（client/nodejs/python）都进 PluginRunner（= 统一启动中转页）。
      // 读取 manifest.json（脚本类 ScriptPreviewPanel parseManifest 需要）+ 入口文件（HTML iframe 需要）。
      // manifest 读取失败不阻断（HTML 插件可能无 manifest，回退仅入口文件）。
      const entryContent = await readLocalPluginFile(item.id, item.entry);
      let manifestContent: string | null = null;
      try {
        manifestContent = await readLocalPluginFile(item.id, 'manifest.json');
      } catch {
        manifestContent = null;
      }
      setRunningPlugin(localStatusToPlugin(item, entryContent, manifestContent));
    } catch (caught) {
      toast.error(`打开本地插件失败：${errorMessage(caught)}`);
    }
  }, [setRunningPlugin]);

  const openTeamPlugin = useCallback(async (plugin: LoadedPlugin) => {
    const runtime = plugin.runtime_type || parseManifest(plugin.files || []).runtime_type;
    try {
      // 浏览器直连 Vite 时没有 Tauri 文件系统，不能写入本地插件目录；
      // 若后端已内联 files，可直接交给 PluginRunner 用 iframe 运行。
      if (hasTauriRuntime() && !plugin.builtin && runtime !== 'cloud') await ensurePluginPackagePersisted(plugin);
      setRunningPlugin(plugin);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }, [setRunningPlugin]);

  // task 06-25：打开草稿插件（运行）—— 从本地文件系统加载完整源文件后运行。
  const openDraftPlugin = useCallback(async (draft: LoadedPlugin) => {
    try {
      const fullDraft = await loadDraftPlugin(draft.id);
      setRunningPlugin(fullDraft);
    } catch (caught) {
      toast.error(`打开草稿插件失败：${errorMessage(caught)}`);
    }
  }, [setRunningPlugin]);

  const openLocalRoot = useCallback(() => {
    void openPluginsRoot().catch((caught) => toast.error(errorMessage(caught)));
  }, []);

  return { openLocalPlugin, openTeamPlugin, openDraftPlugin, openLocalRoot };
}

function localStatusToPlugin(item: LocalPluginStatus, entryContent: string, manifestContent: string | null): LoadedPlugin {
  // 保留真实 runtime（之前硬编码 'client' 导致脚本类无法进 Runner），让 PluginRunner 正确分派：
  // client→iframe，nodejs/python→ScriptPreviewPanel（中转页分阶段启动）。
  const files = [{ path: item.entry, content: entryContent }];
  if (manifestContent != null) files.unshift({ path: 'manifest.json', content: manifestContent });
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    version: item.version,
    entry: item.entry,
    builtin: false,
    runtime_type: item.runtime,
    status: item.status,
    files,
  };
}
