// store.ts —— PluginCreatorSession（zustand）。
//
// betav2 重构核心：收口 FloatingCreator 散落的 pluginId 5 副本（ref/state/磁盘...），
// 用单一真相源消除"草稿编辑读不到文件"（问题1）和"侧边栏不显示"（问题4）。
//
// 阶段4a（本次）：pluginId 单一真相源 + bindPlugin/createPlugin 原子化。
// 阶段4b（后续）：turns/对话/persist/askQuestion 迁入。
// 阶段4c（后续）：FloatingCreator 拆分组件消费 store。
//
// 关键不变式（store 内部强制）：
//  1. pluginId 是唯一字段，组件只读 usePluginCreatorStore(s => s.pluginId)
//  2. bindPlugin 原子化：await 串行（writePluginFiles 完成才 refreshDraftFromRoot），
//     消除"写盘未完成就扫磁盘"的竞态（问题1根因）
//  3. pluginId === aiDraft.id === 磁盘目录 id（统一以目录 id 为准，不再 manifest.id || pluginId）
import { create } from 'zustand';
import { tauriInvoke } from '@/lib/api';
import { writePluginFiles } from '@/lib/plugin-status';
import { filterWritableFiles } from '@/lib/draft-plugin';
import type { LoadedPlugin } from '@/lib/types';
import {
  withSyncedStagedManifest,
  type StagedPlugin,
} from '@/lib/plugin-creator/creator-tools';

// === 工具函数（从 FloatingCreator 迁移，保持逻辑一致）===

function normalizeLoadedRuntime(value: unknown): StagedPlugin['runtime_type'] {
  return value === 'python' || value === 'nodejs' ? value : 'client';
}

function defaultEntryForRuntime(runtime: StagedPlugin['runtime_type']): string {
  if (runtime === 'python') return 'main.py';
  if (runtime === 'nodejs') return 'index.js';
  return 'ui/index.html';
}

const KNOWN_CAPABILITY_KINDS = new Set([
  'ui.view', 'fs.pick', 'fs.read', 'fs.write', 'net.fetch', 'clipboard',
  'llm.chat', 'image.generate', 'storage.kv', 'system.info',
  'system.screenshot', 'system.notify', 'plugin.upload', 'plugin.submitMarketplace',
]);

function normalizeCapabilities(value: unknown): StagedPlugin['capabilities'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const rawKind = typeof item === 'string'
      ? item.trim()
      : item && typeof item === 'object' && typeof (item as Record<string, unknown>).kind === 'string'
        ? String((item as Record<string, unknown>).kind).trim()
        : '';
    if (!KNOWN_CAPABILITY_KINDS.has(rawKind)) return [];
    const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const risk = raw.risk === 'none' || raw.risk === 'medium' || raw.risk === 'high' ? raw.risk : 'low';
    return [{
      kind: rawKind,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      risk,
      requires_admin: raw.requires_admin === true,
    } as StagedPlugin['capabilities'][number]];
  });
}

/**
 * 从磁盘 plugins_root/{pluginId}/ 重载文件，构建 StagedPlugin。
 * 迁移自 FloatingCreator.refreshDraftFromRoot，但统一以目录 id（pluginId）为唯一 id，
 * 不再 manifest.id || pluginId（消除 stagedDraft.id 与目录 id 分裂）。
 */
async function buildDraftFromRoot(pluginId: string): Promise<StagedPlugin> {
  const paths = await tauriInvoke<string[]>('list_plugin_files', { pluginId });
  const allFiles = await Promise.all(
    paths.map(async (path) => ({
      path,
      content: await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: path }),
    })),
  );
  // 过滤掉二进制占位文件（图标/图片等非 UTF-8，Rust 返回占位标记）。
  // 这些文件保留在磁盘上，但不进草稿的 files 数组（避免占位文本污染预览/写回）。
  const files = filterWritableFiles(allFiles);
  const manifestRaw = files.find((f) => f.path === 'manifest.json')?.content ?? '{}';
  const manifest = JSON.parse(manifestRaw) as Partial<StagedPlugin> & { runtime_type?: unknown };
  const runtime = normalizeLoadedRuntime(manifest.runtime_type);
  return withSyncedStagedManifest({
    id: pluginId, // 统一以目录 id 为准（不再 manifest.id || pluginId）
    name: manifest.name || pluginId,
    version: manifest.version || '0.1.0',
    description: manifest.description || '',
    runtime_type: runtime,
    entry: manifest.entry || defaultEntryForRuntime(runtime),
    visibility: manifest.visibility || 'tenant',
    capabilities: normalizeCapabilities(manifest.capabilities),
    files,
  });
}

// === Store 类型 ===

interface PluginCreatorState {
  // === 插件绑定（单一真相源，消除 5 副本）===
  /** 当前正在编辑的插件目录 id（plugins_root/{pluginId}/）。null=未绑定。 */
  pluginId: string | null;
  /** 引用的现有插件（让 agent 基于其代码改）。 */
  referencedPlugin: LoadedPlugin | null;
  /** AI 生成的原始草稿（不含用户编辑）。 */
  aiDraft: StagedPlugin | null;
  /** 用户在右侧面板的手动编辑（覆盖 AI 字段）。 */
  userEdits: Partial<StagedPlugin>;

  // === 运行时（阶段4b 会加更多）===
  /** 是否正在绑定插件（bindPlugin 期间，防并发）。 */
  binding: boolean;
  /** bindPlugin 的错误信息（写盘/读取失败）。 */
  bindError: string | null;

  // === actions ===
  /**
   * 绑定插件到当前会话（原子操作）。
   * 替代旧 bindPluginWorkspace：串行 await 确保写盘完成才 refresh，
   * 消除"写盘未完成就扫磁盘"竞态（问题1根因）。
   */
  bindPlugin: (plugin: LoadedPlugin) => Promise<void>;
  /**
   * CreatePlugin 工具回调：工具已写入 plugins_root/{id}/，同步草稿预览。
   * 替代旧 onPluginCreated，收口多处 setState。
   */
  createPlugin: (pluginId: string, draft: StagedPlugin) => void;
  /** 用户右侧面板编辑 → 累积到 userEdits。 */
  patchDraft: (patch: Partial<StagedPlugin>) => void;
  /** Write/Edit 工具直接改了磁盘，从根目录重载草稿。 */
  refreshDraft: () => Promise<boolean>;
  /** 草稿发布成功：清空草稿态。 */
  clearDraft: () => void;
  /** 取消引用插件。 */
  clearReferencedPlugin: () => void;
}

// === Store 实现 ===

export const usePluginCreatorStore = create<PluginCreatorState>((set, get) => ({
  pluginId: null,
  referencedPlugin: null,
  aiDraft: null,
  userEdits: {},
  binding: false,
  bindError: null,

  bindPlugin: async (plugin) => {
    // 防并发：同一插件重复绑定直接跳过；不同插件等上一次完成。
    if (get().binding) return;
    if (get().pluginId === plugin.id && get().referencedPlugin?.id === plugin.id) return;

    set({ binding: true, bindError: null });
    try {
      // 1. 如果插件带 files（云端/草稿恢复），先写盘（确保磁盘有完整文件）。
      //    过滤掉二进制占位文件（Rust 对非 UTF-8 文件的兜底返回，写回会覆盖原二进制）。
      if (plugin.files?.length) {
        const writable = filterWritableFiles(plugin.files);
        if (writable.length) {
          await writePluginFiles(
            plugin.id,
            writable.map((f) => ({ path: f.path, content: f.content })),
          );
        }
      }

      // 2. 从磁盘重载（原子：写盘已完成，扫到的是完整文件，不再有竞态）。
      try {
        const draft = await buildDraftFromRoot(plugin.id);
        set({
          pluginId: plugin.id,
          referencedPlugin: plugin,
          aiDraft: draft,
          userEdits: {}, // 绑定新插件清空旧编辑
          binding: false,
        });
      } catch {
        // refresh 失败但磁盘有 files（buildDraftFromRoot 扫不到但 plugin.files 有）：
        // 用 plugin.files 构建兜底草稿（修复问题4：侧边栏不显示）。
        if (plugin.files?.length) {
          const runtime = normalizeLoadedRuntime(plugin.runtime_type);
          const fallbackDraft = withSyncedStagedManifest({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version || '0.1.0',
            description: plugin.description || '',
            runtime_type: runtime,
            entry: plugin.entry || defaultEntryForRuntime(runtime),
            visibility: 'tenant',
            capabilities: normalizeCapabilities(plugin.capabilities),
            files: filterWritableFiles(plugin.files).map((f) => ({ path: f.path, content: f.content })),
          });
          set({
            pluginId: plugin.id,
            referencedPlugin: plugin,
            aiDraft: fallbackDraft,
            userEdits: {},
            binding: false,
          });
        } else {
          // 磁盘没文件且 plugin 也没 files：记录错误但仍绑定 id（让用户能看到错误提示）。
          set({
            pluginId: plugin.id,
            referencedPlugin: plugin,
            aiDraft: null,
            userEdits: {},
            binding: false,
            bindError: `插件「${plugin.name}」没有可读取的文件，可能需要重新创建。`,
          });
        }
      }
    } catch (e) {
      set({
        binding: false,
        bindError: e instanceof Error ? e.message : '绑定插件工作目录失败',
      });
    }
  },

  createPlugin: (pluginId, draft) => {
    const synced = withSyncedStagedManifest(draft);
    const prev = get().aiDraft;
    set({
      pluginId,
      aiDraft: synced,
      // 换了插件 id（新插件）清空旧用户编辑；同一插件继续修改则保留。
      userEdits: prev && prev.id !== synced.id ? {} : get().userEdits,
    });
  },

  patchDraft: (patch) => {
    set((state) => ({ userEdits: { ...state.userEdits, ...patch } }));
  },

  refreshDraft: async () => {
    const { pluginId } = get();
    if (!pluginId) return false;
    try {
      const draft = await buildDraftFromRoot(pluginId);
      set({ aiDraft: draft });
      return true;
    } catch {
      return false;
    }
  },

  clearDraft: () => {
    set({ pluginId: null, referencedPlugin: null, aiDraft: null, userEdits: {}, bindError: null });
  },

  clearReferencedPlugin: () => {
    const { aiDraft } = get();
    set({
      referencedPlugin: null,
      // 若没有草稿，pluginId 也清空（没有正在编辑的插件了）。
      pluginId: aiDraft ? get().pluginId : null,
    });
  },
}));

// === Derived selectors（组件用）===

/** 展示用草稿 = AI 草稿 + 用户编辑，并同步 manifest。null=未绑定。 */
export function useDraft(): StagedPlugin | null {
  return usePluginCreatorStore((s) => {
    if (!s.aiDraft) return null;
    return withSyncedStagedManifest({ ...s.aiDraft, ...s.userEdits });
  });
}

/** 当前 pluginId（agent 工具回调读这个，替代旧 currentPluginIdRef）。 */
export function usePluginId(): string | null {
  return usePluginCreatorStore((s) => s.pluginId);
}
