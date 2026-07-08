// local-upload.ts —— 把本地（已物化在 plugins_root 的）插件重新构造为 StagedPlugin 以便上传到团队/市场。
//
// 与创建器的 submitStagedPlugin 配合：本地插件行点「发布」→ 本文件读 manifest + 全部源文件 →
// 组装 StagedPlugin → submitStagedPlugin → POST /api/plugins/upload（发布到团队空间）。
// 市场审核第二步由「团队插件」tab 的 PluginSubmitDialog 承担（POST /api/plugins/:id/submit-marketplace）。
//
// 为什么需要读原始 manifest：LocalPluginStatus（列表层）不带 capabilities/visibility 字段，
// 而上传需要这些字段构造完整 manifest，故从磁盘 manifest.json 重新解析。
import type { PluginCapability } from '@lingfang/contract';
import { listPluginFiles, readLocalPluginFile } from '@/lib/plugin-status';
import { isBinaryPlaceholder } from '@/lib/draft-plugin';
import type { DraftFile } from '@/lib/types';
import type { StagedPlugin } from '@/lib/plugin-creator/creator-tools';

const DEFAULT_CAPABILITY: PluginCapability = {
  kind: 'ui.view',
  reason: '展示插件界面',
  risk: 'low',
  requires_admin: false,
};

/** manifest.json 字段在磁盘上可能存在的形状（宽松解析，缺失字段走默认）。 */
interface RawManifest {
  id?: string;
  name?: string;
  title?: string;
  version?: string;
  description?: string;
  runtime_type?: unknown;
  entry?: string;
  visibility?: unknown;
  capabilities?: unknown;
}

/** 把宽松解析出的 manifest 字段归一为合法 StagedPlugin.runtime_type。 */
function normalizeRuntime(value: unknown): StagedPlugin['runtime_type'] {
  return value === 'nodejs' || value === 'python' ? value : 'client';
}

/** 把宽松解析出的 visibility 归一为 'private' | 'tenant'。 */
function normalizeVisibility(value: unknown): StagedPlugin['visibility'] {
  return value === 'private' ? 'private' : 'tenant';
}

/**
 * 读本地插件并组装为 StagedPlugin（供 submitStagedPlugin 上传）。
 *
 * @throws manifest 缺失/非法、源文件读取失败时抛出带中文提示的错误。
 */
export async function loadLocalPluginAsStaged(pluginId: string): Promise<StagedPlugin> {
  // 1. 读原始 manifest.json（capabilities/visibility 等字段只有磁盘 manifest 才有）。
  let rawManifest: RawManifest;
  try {
    const manifestText = await readLocalPluginFile(pluginId, 'manifest.json');
    rawManifest = JSON.parse(manifestText) as RawManifest;
  } catch (err) {
    throw new Error(`读取 manifest.json 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new Error('manifest.json 内容非法（非 JSON 对象）');
  }

  // 2. 枚举插件目录全部源文件（list_plugin_files 跳过 data/.venv/node_modules 等运行时目录）。
  let paths: string[];
  try {
    paths = await listPluginFiles(pluginId);
  } catch (err) {
    throw new Error(`枚举插件文件失败：${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. 逐个读内容（manifest.json 单独由 buildStagedManifestContent 重新生成，避免旧 manifest 污染）。
  //    二进制文件 read_local_plugin_file 返回占位文本（isBinaryPlaceholder 判定），跳过。
  const files: DraftFile[] = [];
  for (const path of paths) {
    if (path === 'manifest.json') continue;
    const content = await readLocalPluginFile(pluginId, path);
    if (isBinaryPlaceholder(content)) continue; // 二进制文件无法作为文本上传，跳过。
    files.push({ path, content });
  }
  if (files.length === 0) {
    throw new Error('插件没有可上传的源文件（可能全是二进制）');
  }

  // 4. 组装 StagedPlugin：字段优先取磁盘 manifest，缺失走与 import-local 一致的默认。
  const runtime = normalizeRuntime(rawManifest.runtime_type);
  const defaultEntry = runtime === 'python' ? 'main.py' : runtime === 'nodejs' ? 'index.js' : 'ui/index.html';
  const entry = rawManifest.entry && files.some((f) => f.path === rawManifest.entry)
    ? rawManifest.entry
    : defaultEntry;

  const capabilities: PluginCapability[] = Array.isArray(rawManifest.capabilities) && rawManifest.capabilities.length
    ? (rawManifest.capabilities as PluginCapability[])
    : [DEFAULT_CAPABILITY];

  return {
    id: rawManifest.id || pluginId,
    // name 优先用 title（用户命名）> name 字段 > plugin_id，与 scan_one_plugin 展示一致。
    name: rawManifest.title || rawManifest.name || pluginId,
    version: rawManifest.version || '0.1.0',
    description: rawManifest.description || '',
    runtime_type: runtime,
    entry,
    visibility: normalizeVisibility(rawManifest.visibility),
    capabilities,
    files,
  };
}
