import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { LoadedPlugin } from '@/lib/types';
import { ensurePluginPackagePersisted } from '@/lib/plugin-installation';
import { resolvePluginRuntime } from '@/lib/plugin-runtime';
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

// 插件工作台主区展示后，tab 由 App 受控，不再拆成 plugins/author-center/market 多个 view。
// PluginCenterTab 类型随之内聚到本模块。
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
  const [page, setPage] = useState(1);

  const reload = useCallback(() => {
    setLoading(true);
    void scanPluginStatus()
      .then((nextItems) => setItems(nextItems.filter((p) => !p.draft)))
      .catch((caught) => {
        setItems((prev) => prev ?? []);
        toast.error(`扫描本地插件失败：${errorMessage(caught)}`);
      })
      .finally(() => setLoading(false));
    setPage(1);
  }, []);

  useEffect(() => {
    if (!runningPlugin) reload();
  }, [runningPlugin, reload]);

  return { items, loading, reload, page, setPage };
}

// task 06-26-agent-framework-rewrite：本地草稿插件列表
// 数据源从 listDraftPlugins（废弃的 plugins-draft 双轨）改为 scanPluginStatus 过滤 draft:true
// （统一 plugins_root 目录，manifest.draft===true 标记未发布草稿）。
export function useDraftPluginList(runningPlugin: LoadedPlugin | null) {
  const [items, setItems] = useState<LoadedPlugin[] | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    void scanPluginStatus()
      .then((all) => {
        const drafts = all.filter((p) => p.draft);
        // 把 LocalPluginStatus 映射为 LoadedPlugin 形态（草稿页兼容现有卡片接口）。
        const mapped: LoadedPlugin[] = drafts.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          description: p.description,
          entry: p.entry,
          builtin: false,
          runtime_type: p.runtime,
          status: p.status,
          draft: true,
          local: true,
          versionCount: (p as any).versionCount ?? 0,
          _meta: (p as any)._meta,
        }));
        setItems(mapped);
      })
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
      let manifestContent: string | null = null;
      try {
        manifestContent = await readLocalPluginFile(item.id, 'manifest.json');
      } catch {
        manifestContent = null;
      }
      let entryContent: string | null = null;
      const entryPath = item.entry.trim();
      if (entryPath) {
        try {
          entryContent = await readLocalPluginFile(item.id, entryPath);
        } catch (caught) {
          // incomplete/error 插件仍允许进入 Runner，由中转页展示缺失详情并提供修复入口；
          // ready 插件入口读取失败才视为打开失败，避免静默吞掉真实 IO 问题。
          if (item.status === 'ready') throw caught;
        }
      }
      setRunningPlugin(localStatusToPlugin(item, entryContent, manifestContent));
    } catch (caught) {
      toast.error(`打开本地插件失败：${errorMessage(caught)}`);
    }
  }, [setRunningPlugin]);

  const openTeamPlugin = useCallback(async (plugin: LoadedPlugin) => {
    const runtime = resolvePluginRuntime(plugin);
    try {
      // 浏览器直连 Vite 时没有 Tauri 文件系统，不能写入本地插件目录；
      // 若后端已内联 files，可直接交给 PluginRunner 用 iframe 运行。
      if (hasTauriRuntime() && !plugin.builtin && runtime !== 'cloud') await ensurePluginPackagePersisted(plugin);
      // 脚本类（nodejs/python）必须有 files 才能解析入口与运行；缺 files 时（其它团队未安装插件后端不下发）
      // 给出明确提示而非静默进入「显示源码」降级视图。
      if ((runtime === 'nodejs' || runtime === 'python') && !plugin.files?.length && !plugin.builtin) {
        toast.error('该插件尚未安装到本地，无法运行。请先点击「安装后运行」。');
        return;
      }
      setRunningPlugin({ ...plugin, runtime_type: runtime });
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }, [setRunningPlugin]);

  // task 06-26-agent-framework-rewrite：打开草稿插件 —— 统一走 openLocalPlugin 带运行时的启动路径。
  // 草稿现在存在 plugins_root/{id}/（不是旧 plugins-draft 目录），manifest.draft===true 标记。
  // 运行路径和正式本地插件完全一致：Python/Node 从真实目录启动（venv/node_modules 可用）。
  const openDraftPlugin = useCallback(async (draft: LoadedPlugin) => {
    try {
      // 把草稿 LoadedPlugin 转为 LocalPluginStatus 后走 openLocalPlugin 同一条路径。
      const status: LocalPluginStatus = {
        id: draft.id,
        name: draft.name,
        status: (draft.status as LocalPluginStatus['status']) || 'ready',
        runtime: (draft.runtime_type as LocalPluginStatus['runtime']) || 'client',
        entry: draft.entry,
        description: draft.description || '',
        version: draft.version,
        icon: undefined,
        pid: null,
        started_at: null,
        detail: null,
        draft: true,
      };
      openLocalPlugin(status);
    } catch (caught) {
      toast.error(`打开草稿插件失败：${errorMessage(caught)}`);
    }
  }, [setRunningPlugin, openLocalPlugin]);

  const openLocalRoot = useCallback(() => {
    void openPluginsRoot().catch((caught) => toast.error(errorMessage(caught)));
  }, []);

  return { openLocalPlugin, openTeamPlugin, openDraftPlugin, openLocalRoot };
}

function localStatusToPlugin(item: LocalPluginStatus, entryContent: string | null, manifestContent: string | null): LoadedPlugin {
  // 保留真实 runtime（之前硬编码 'client' 导致脚本类无法进 Runner），让 PluginRunner 正确分派：
  // client→iframe，nodejs/python→ScriptPreviewPanel（中转页分阶段启动）。
  const files: { path: string; content: string }[] = [];
  if (manifestContent != null) files.unshift({ path: 'manifest.json', content: manifestContent });
  const entryPath = item.entry.trim();
  if (entryPath && entryContent != null) files.push({ path: entryPath, content: entryContent });
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
