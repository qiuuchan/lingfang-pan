// draft-plugin.ts —— 本地草稿插件管理 API（封装 Tauri 命令调用 + 浏览器文件导入/导出）。
//
// 草稿插件存储在本地文件系统 {appDataDir}/plugins-draft/{id}/，
// 供 AI 创建器保存草稿、插件中心列出草稿、运行、编辑、版本管理、发布到团队和导入/导出。
import { invoke } from '@tauri-apps/api/core';
import type { LoadedPlugin, DraftFile } from './types';

export interface SaveDraftArgs {
  id: string;
  manifest: Record<string, unknown>;
  files: [string, string][]; // [path, content][]
  /** 对话 ID（供编辑时恢复对话历史）。 */
  conversationId?: string;
  /** 对话轮次 JSON 字符串（供编辑时恢复对话）。 */
  turns?: string;
  /** 是否保存为新版本（false=覆盖当前，true=追加历史版本）。 */
  saveVersion?: boolean;
  [key: string]: unknown; // Tauri InvokeArgs 要求索引签名
}

/**
 * 保存草稿插件到本地文件系统。
 * 创建 {appDataDir}/plugins-draft/{id}/ 目录，写入 manifest.json、.meta.json 和源文件。
 * saveVersion=true 时把当前内容先备份到 .versions/vN/ 再写新内容。
 */
export async function saveDraftPlugin(args: SaveDraftArgs): Promise<void> {
  try {
    await invoke('save_draft_plugin', args);
  } catch (err) {
    throw new Error(`保存草稿失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 列出所有本地草稿插件。
 * 返回的插件对象已标记 draft: true, local: true，并附加 _meta 和 versionCount。
 */
export async function listDraftPlugins(): Promise<LoadedPlugin[]> {
  try {
    return await invoke<LoadedPlugin[]>('list_draft_plugins');
  } catch (err) {
    console.error('列出草稿失败:', err);
    return []; // fallback 到空数组，不阻塞插件加载
  }
}

/**
 * 加载指定草稿插件（含完整源文件）。
 * 返回的对象包含 files 数组，供运行、编辑、发布到团队时使用。
 */
export async function loadDraftPlugin(id: string): Promise<LoadedPlugin> {
  try {
    return await invoke<LoadedPlugin>('load_draft_plugin', { id });
  } catch (err) {
    throw new Error(`加载草稿 ${id} 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 删除指定草稿插件。
 * 移除本地 {appDataDir}/plugins-draft/{id}/ 整个目录。
 */
export async function deleteDraftPlugin(id: string): Promise<void> {
  try {
    await invoke('delete_draft_plugin', { id });
  } catch (err) {
    throw new Error(`删除草稿 ${id} 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 草稿历史版本条目。 */
export interface DraftVersion {
  version: string; // "v1", "v2", ...
  manifest: {
    name?: string;
    version?: string;
    description?: string;
    [k: string]: unknown;
  } | null;
}

/**
 * 列出指定草稿的历史版本（按版本号降序）。
 */
export async function listDraftVersions(id: string): Promise<DraftVersion[]> {
  try {
    return await invoke<DraftVersion[]>('list_draft_versions', { id });
  } catch (err) {
    console.error('列出草稿版本失败:', err);
    return [];
  }
}

/**
 * 回退草稿到指定历史版本（先把当前版本另存为新版本，再用目标版本覆盖当前）。
 */
export async function restoreDraftVersion(id: string, version: string): Promise<void> {
  try {
    await invoke('restore_draft_version', { id, version });
  } catch (err) {
    throw new Error(`回退版本失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// === 导入 / 导出（纯前端，与 import-local 同款 <input>/Blob 方案，零新依赖） ===

/** 导出包格式（.lfplugin = JSON 单文件）。 */
export interface DraftBundle {
  format: 'lingfang-plugin-bundle';
  version: 1;
  manifest: Record<string, unknown>;
  files: DraftFile[];
  exportedAt: string;
}

/**
 * 导出草稿为 .lfplugin 文件（浏览器下载）。
 * 加载完整草稿 → 序列化为 JSON bundle → 触发浏览器下载。
 */
export async function exportDraftPlugin(id: string, exportedAt: string): Promise<void> {
  const draft = await loadDraftPlugin(id);
  const raw = draft as LoadedPlugin & { capabilities?: unknown; visibility?: unknown; runtime_type?: unknown };
  const bundle: DraftBundle = {
    format: 'lingfang-plugin-bundle',
    version: 1,
    manifest: {
      id: draft.id,
      name: draft.name,
      version: draft.version,
      entry: draft.entry,
      description: draft.description ?? '',
      capabilities: raw.capabilities ?? [],
      visibility: raw.visibility ?? 'private',
      runtime_type: raw.runtime_type ?? 'client',
    },
    files: draft.files ?? [],
    exportedAt,
  };
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${draft.id}.lfplugin`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 从 .lfplugin 文件解析草稿 bundle（读取文件文本 → 校验格式）。
 * 校验失败抛错。返回解析出的 bundle。
 */
export async function parseDraftBundle(file: File): Promise<DraftBundle> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  const bundle = parsed as Partial<DraftBundle>;
  if (bundle.format !== 'lingfang-plugin-bundle' || !bundle.manifest || !Array.isArray(bundle.files)) {
    throw new Error('文件不是有效的灵坊插件包（.lfplugin）');
  }
  return bundle as DraftBundle;
}

/**
 * 导入草稿 bundle 到本地（保存为新草稿）。
 * 若 ID 已存在会覆盖——调用方应先确认。
 */
export async function importDraftBundle(bundle: DraftBundle): Promise<string> {
  const manifest = bundle.manifest;
  const id = String(manifest.id ?? '');
  if (!id) throw new Error('插件包缺少 id');
  await saveDraftPlugin({
    id,
    manifest: { ...manifest, draft: true },
    files: bundle.files.map((f) => [f.path, f.content] as [string, string]),
  });
  return String(manifest.name ?? id);
}
