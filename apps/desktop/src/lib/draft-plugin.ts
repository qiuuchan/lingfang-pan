// draft-plugin.ts —— 本地草稿插件管理 API（plugins_root 统一目录封装 + 浏览器导入/导出）。
//
// task 06-26-agent-framework-rewrite：草稿不再写入 plugins-draft 双轨目录，统一落到
// plugins_root/{id}/，通过 manifest.draft=true 标记未发布草稿。旧 Rust draft_plugin
// 仅保留迁移命令，不再作为前端写入/读取路径。
import { errorMessage, tauriInvoke } from './api';
import type { LoadedPlugin, DraftFile } from './types';

/**
 * 二进制文件占位标记（Rust read_plugin_file 对非 UTF-8 文件返回此字符串）。
 *
 * 草稿加载会遍历目录全部文件，二进制文件（PNG/ICO 图标等）无法作为 UTF-8 文本返回，
 * Rust 层返回此占位让前端能继续加载其余文本文件，而不是整个加载失败。
 *
 * 写回磁盘时必须跳过占位文件（否则会用占位文本覆盖原二进制内容）。
 */
const BINARY_PLACEHOLDER_PREFIX = '[binary file,';

/** 判断文件内容是否为二进制占位标记（Rust 层对非 UTF-8 文件的兜底返回）。 */
export function isBinaryPlaceholder(content: string): boolean {
  return content.startsWith(BINARY_PLACEHOLDER_PREFIX);
}

/** 过滤掉二进制占位文件（写回磁盘时调用，避免占位文本覆盖原二进制）。 */
export function filterWritableFiles<T extends { content: string }>(files: T[]): T[] {
  return files.filter((f) => !isBinaryPlaceholder(f.content));
}

export interface SaveDraftArgs {
  id: string;
  manifest: Record<string, unknown>;
  files: [string, string][]; // [path, content][]
  /** 对话 ID（供编辑时恢复对话历史）。 */
  conversationId?: string;
  /** 对话轮次 JSON 字符串（供编辑时恢复对话）。 */
  turns?: string;
  /** plugins_root 草稿不再维护 .versions；保留字段兼容旧调用方。 */
  saveVersion?: boolean;
  [key: string]: unknown; // Tauri InvokeArgs 要求索引签名
}

export interface SavedDraftFile {
  path: string;
  bytes: number;
  exists: boolean;
}

export interface SaveDraftPluginResult {
  id: string;
  path: string;
  manifestPath: string;
  metaPath: string;
  savedAt: string;
  fileCount: number;
  manifestWritten: boolean;
  metaWritten: boolean;
  files: SavedDraftFile[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parseTurns(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function manifestStringField(manifest: Record<string, unknown>, key: string, fallback = ''): string {
  const value = manifest[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function normalizeRuntime(value: unknown): LoadedPlugin['runtime_type'] {
  return value === 'nodejs' || value === 'python' || value === 'cloud' ? value : 'client';
}

async function readPluginFiles(pluginId: string): Promise<DraftFile[]> {
  const paths = await tauriInvoke<string[]>('list_plugin_files', { pluginId });
  const all = await Promise.all(
    paths.map(async (path) => ({
      path,
      content: await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: path }),
    })),
  );
  // 过滤掉二进制占位文件（图标/图片等非 UTF-8，Rust 返回占位标记）。
  return filterWritableFiles(all);
}

/**
 * 保存草稿插件到 plugins_root/{id}/。
 * 写入 manifest.json（draft:true）和源文件；对话元信息内嵌在 manifest._meta 以供编辑恢复。
 */
export async function saveDraftPlugin(args: SaveDraftArgs): Promise<SaveDraftPluginResult> {
  try {
    const savedAt = new Date().toISOString();
    const manifest = {
      ...args.manifest,
      id: args.id,
      draft: true,
      _meta: {
        ...asRecord(args.manifest._meta),
        source: 'plugins_root',
        conversationId: args.conversationId,
        turns: parseTurns(args.turns),
        updatedAt: savedAt,
      },
    };
    const files = [
      { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
      ...args.files
        .filter(([path]) => path !== 'manifest.json')
        .map(([path, content]) => ({ path, content }))
        // 跳过二进制占位文件：它们是 Rust 对非 UTF-8 文件的兜底返回，
        // 写回会用占位文本覆盖原二进制（图标/图片等）。
        .filter((f) => !isBinaryPlaceholder(f.content)),
    ];
    await tauriInvoke<void>('write_plugin_files', { pluginId: args.id, files });
    await tauriInvoke<void>('set_plugin_draft_flag', { pluginId: args.id, draft: true });
    const root = await tauriInvoke<string>('get_plugins_root').catch(() => '');
    return {
      id: args.id,
      path: root ? `${root}/${args.id}` : args.id,
      manifestPath: root ? `${root}/${args.id}/manifest.json` : 'manifest.json',
      metaPath: '',
      savedAt,
      fileCount: files.length,
      manifestWritten: true,
      metaWritten: false,
      files: files.map((file) => ({
        path: file.path,
        bytes: new TextEncoder().encode(file.content).length,
        exists: true,
      })),
    };
  } catch (err) {
    throw new Error(`保存草稿失败: ${errorMessage(err)}`);
  }
}

/**
 * 列出所有本地草稿插件。
 * 返回的插件对象已标记 draft: true, local: true，并附加 _meta 和 versionCount。
 */
export async function listDraftPlugins(): Promise<LoadedPlugin[]> {
  try {
    const rows = await tauriInvoke<Array<{ id: string; draft: boolean }>>('scan_plugin_status');
    const drafts = rows.filter((row) => row.draft);
    return (await Promise.all(drafts.map((row) => loadDraftPlugin(row.id).catch(() => null)))).filter(
      (plugin): plugin is LoadedPlugin => Boolean(plugin),
    );
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
    const files = await readPluginFiles(id);
    const manifestRaw = files.find((file) => file.path === 'manifest.json')?.content ?? '{}';
    const manifest = asRecord(JSON.parse(manifestRaw));
    const meta = asRecord(manifest._meta);
    const plugin: LoadedPlugin = {
      id,
      name: manifestStringField(manifest, 'name', id),
      description: manifestStringField(manifest, 'description'),
      version: manifestStringField(manifest, 'version', '0.1.0'),
      entry: manifestStringField(manifest, 'entry', 'ui/index.html'),
      builtin: false,
      runtime_type: normalizeRuntime(manifest.runtime_type),
      capabilities: Array.isArray(manifest.capabilities) ? (manifest.capabilities as LoadedPlugin['capabilities']) : [],
      files,
      manifest,
      draft: true,
      local: true,
      versionCount: 0,
      _meta: {
        createdAt: manifestStringField(meta, 'createdAt', manifestStringField(meta, 'updatedAt', new Date().toISOString())),
        updatedAt: manifestStringField(meta, 'updatedAt', new Date().toISOString()),
        source: manifestStringField(meta, 'source', 'plugins_root'),
        conversationId: typeof meta.conversationId === 'string' ? meta.conversationId : undefined,
        turns: meta.turns,
      },
    };
    (plugin as LoadedPlugin & { visibility?: unknown }).visibility = manifest.visibility ?? 'tenant';
    return plugin;
  } catch (err) {
    throw new Error(`加载草稿 ${id} 失败: ${errorMessage(err)}`);
  }
}

/**
 * 删除指定草稿插件。
 * 移除本地 {appDataDir}/plugins-draft/{id}/ 整个目录。
 */
export async function deleteDraftPlugin(id: string): Promise<void> {
  try {
    await tauriInvoke('delete_plugin', { pluginId: id });
  } catch (err) {
    throw new Error(`删除草稿 ${id} 失败: ${errorMessage(err)}`);
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
  void id;
  return [];
}

/**
 * 回退草稿到指定历史版本（先把当前版本另存为新版本，再用目标版本覆盖当前）。
 */
export async function restoreDraftVersion(id: string, version: string): Promise<void> {
  void id;
  void version;
  throw new Error('草稿历史版本已随 plugins_root 统一目录迁移移除，当前版本不支持回退。');
}

// 注：旧的 .lfplugin JSON 单文件导入/导出（exportDraftPlugin/parseDraftBundle/importDraftBundle/DraftBundle）
// 已迁移为 .lfplugin ZIP 包格式（plugin-package-zip.ts）。旧格式无存量文件，不做兼容。
// 导入/导出请使用 exportPluginToZip / parsePluginZip / materializeZipPlugin。
