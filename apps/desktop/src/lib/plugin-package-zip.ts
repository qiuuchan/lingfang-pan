// plugin-package-zip.ts —— `.lfplugin` ZIP 包导出/导入（本地插件 & 草稿插件通用）。
//
// `.lfplugin` v2 = ZIP 包，结构：
//   _meta.json   { format: 'lingfang-plugin', version: 2, source: 'local'|'draft', exportedAt, name }
//   manifest.json  原始 manifest（含 capabilities/visibility/runtime_type 等全部字段）
//   <源文件>       main.py / index.js / ui/index.html / requirements.txt / ...
//
// 设计要点：
// - 二进制处理：read_local_plugin_file 对非 UTF-8 返回占位字符串，全应用统一跳过二进制
//   （import-local/saveDraftPlugin/local-upload 同款）。ZIP 包亦只含文本文件，二进制跳过并计数提示。
// - 导入落点按 _meta.json.source：'draft' → saveDraftPlugin(draft:true)；'local'/缺失 → writePluginFiles(非草稿, 可运行)。
// - id 去重：与已有本地/草稿插件冲突时 dedupeImportId 追加 -2/-3，绝不覆盖现有目录。
// - manifest.json 用磁盘原文件（非重新生成），保留所有字段；导入时原样物化。
// - 旧 JSON 单文件 v1 格式已废弃（无存量文件、spec 无记录），遇 v1 报错引导重新导出。
import JSZip from 'jszip';
import { listPluginFiles, readLocalPluginFile, writePluginFiles } from '@/lib/plugin-status';
import { isBinaryPlaceholder, saveDraftPlugin } from '@/lib/draft-plugin';
import { safePluginId } from '@/lib/plugin-draft';
import { isVersionNewer } from '@/lib/version';
import { dedupeImportId } from '@/pages/plugins/use-local-import';
import type { DraftFile } from '@/lib/types';

/** 包内来源标记：决定导入后落草稿还是本地。 */
export type PluginPackageSource = 'local' | 'draft';

/** _meta.json 内容（包标识 + 来源 + 导出时间）。 */
interface PackageMeta {
  format: 'lingfang-plugin';
  version: 2;
  source: PluginPackageSource;
  exportedAt: string;
  name: string;
}

const META_FILE = '_meta.json';
const MANIFEST_FILE = 'manifest.json';
const PLUGIN_FORMAT = 'lingfang-plugin' as const;
const PLUGIN_VERSION = 2;

/** 不进 ZIP 包的文件（_meta.json 是包标识，单独生成；manifest.json 单独加保证用磁盘原文件）。 */
function isMetaOrManifest(path: string): boolean {
  return path === META_FILE || path === MANIFEST_FILE;
}

// === 导出 ===

/**
 * 导出插件为 `.lfplugin` ZIP 文件（浏览器下载）。
 *
 * @param pluginId 插件目录名（plugins_root/<pluginId>）。
 * @param source 来源：本地插件导出 'local'，草稿导出 'draft'（决定导入时落点）。
 * @returns { name, fileCount, skipped } 供调用方 toast。
 * @throws 枚举/读取文件失败、插件无文件时抛错。
 */
export async function exportPluginToZip(
  pluginId: string,
  source: PluginPackageSource,
): Promise<{ name: string; fileCount: number; skipped: number }> {
  const paths = await listPluginFiles(pluginId);
  if (paths.length === 0) {
    throw new Error('插件没有可导出的源文件');
  }

  const zip = new JSZip();
  let fileCount = 0;
  let skipped = 0;
  let displayName = pluginId;
  let manifestText = '';

  // 逐个读内容；二进制占位跳过；manifest.json 单独收存（用磁盘原文件，非重新生成）。
  for (const path of paths) {
    const content = await readLocalPluginFile(pluginId, path);
    if (isBinaryPlaceholder(content)) {
      skipped += 1;
      continue;
    }
    if (path === MANIFEST_FILE) {
      manifestText = content;
      // 从 manifest 取展示名（title > name > plugin_id）。
      try {
        const m = JSON.parse(content) as { title?: string; name?: string };
        displayName = m.title || m.name || pluginId;
      } catch {
        /* manifest 解析失败不影响导出，用 plugin_id 兜底 */
      }
      continue;
    }
    zip.file(path, content);
    fileCount += 1;
  }

  // manifest.json 必须在包内（导入需它定位 id/字段）。缺失则报错。
  if (!manifestText) {
    throw new Error('插件缺少 manifest.json，无法导出');
  }
  zip.file(MANIFEST_FILE, manifestText);
  fileCount += 1;

  const meta: PackageMeta = {
    format: PLUGIN_FORMAT,
    version: PLUGIN_VERSION,
    source,
    exportedAt: new Date().toISOString(),
    name: displayName,
  };
  zip.file(META_FILE, `${JSON.stringify(meta, null, 2)}\n`);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  triggerDownload(blob, `${pluginId}.lfplugin`);
  return { name: displayName, fileCount, skipped };
}

/** 触发浏览器下载（与 exportDraftPlugin 同款 Blob + 锚点方案）。 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// === 导入 ===

/** 解析 ZIP 包的结果（确认对话框展示 + materialize 输入）。 */
export interface ZipImportResult {
  id: string;
  name: string;
  source: PluginPackageSource;
  files: DraftFile[];
  manifest: Record<string, unknown>;
}

/**
 * 解析 `.lfplugin` ZIP 包（不落盘，供确认对话框预览）。
 *
 * @throws 非 ZIP、格式标识不符、version 不为 2、缺 manifest.json、无源文件时抛错。
 */
export async function parsePluginZip(file: File): Promise<ZipImportResult> {
  // 先读全部字节：ZIP 解析与旧版 JSON 检测共用。
  const buffer = await file.arrayBuffer();
  let zip: JSZip | null = null;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    // 非 ZIP：可能是旧 JSON 单文件 v1（lingfang-plugin-bundle）。检测后给重新导出引导，否则报非 ZIP。
    // rejectLegacyJsonOrInvalid 必抛（Promise<never>），但 TS 不识别，故显式 throw 兜底。
    throw await rejectLegacyJsonOrInvalid(buffer);
  }
  // rejectLegacyJsonOrInvalid 抛出后不会执行到这；非空断言表明 zip 已就绪。
  const resolvedZip = zip!;

  // _meta.json 校验格式标识与版本。
  const metaFile = resolvedZip.file(META_FILE);
  if (!metaFile) {
    // ZIP 但无 _meta.json：可能旧 zip 或他工具产的包。
    throw new Error('文件不是有效的灵坊插件包（缺少 _meta.json）');
  }
  const metaText = await metaFile.async('string');
  let meta: PackageMeta;
  try {
    meta = JSON.parse(metaText) as PackageMeta;
  } catch {
    throw new Error('_meta.json 不是合法的 JSON');
  }
  if (meta.format !== PLUGIN_FORMAT) {
    throw new Error('文件不是灵坊插件包（_meta.json format 不符）');
  }
  if (meta.version !== PLUGIN_VERSION) {
    throw new Error(`插件包版本 v${meta.version} 不受支持，请用当前版本重新导出（支持 v${PLUGIN_VERSION}）`);
  }
  const source: PluginPackageSource = meta.source === 'draft' ? 'draft' : 'local';

  // manifest.json 必须存在（定位 id + 保留字段）。
  const manifestEntry = resolvedZip.file(MANIFEST_FILE);
  if (!manifestEntry) {
    throw new Error('插件包缺少 manifest.json');
  }
  const manifestText = await manifestEntry.async('string');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestText) as Record<string, unknown>;
  } catch {
    throw new Error('manifest.json 不是合法的 JSON');
  }
  const rawId = typeof manifest.id === 'string' && manifest.id ? manifest.id : '';
  if (!rawId) throw new Error('manifest.json 缺少 id 字段');
  const name = (typeof manifest.title === 'string' && manifest.title)
    || (typeof manifest.name === 'string' && manifest.name)
    || rawId;

  // 收集其余源文件（跳过 _meta.json/manifest.json，均已单独处理）。
  const files: DraftFile[] = [];
  const entries = Object.values(resolvedZip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    if (isMetaOrManifest(entry.name)) continue;
    // 跳过 macOS 打包脏文件（__MACOSX/、.DS_Store）与目录占位。
    if (entry.name.startsWith('__MACOSX/') || entry.name.endsWith('.DS_Store')) continue;
    const content = await entry.async('string');
    files.push({ path: entry.name, content });
  }
  if (files.length === 0) {
    throw new Error('插件包没有可导入的源文件');
  }

  return { id: rawId, name, source, files, manifest };
}

/** 非 ZIP 文件兜底：尝试按 JSON 解析，命中旧版 v1 给重新导出引导，否则报非 ZIP。 */
async function rejectLegacyJsonOrInvalid(buffer: ArrayBuffer): Promise<never> {
  const text = new TextDecoder().decode(buffer);
  try {
    const parsed = JSON.parse(text) as { format?: string };
    if (parsed.format === 'lingfang-plugin-bundle') {
      throw new Error('这是旧版 JSON 格式的 .lfplugin（v1），请用当前版本重新导出后再导入');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('旧版')) throw err;
    /* 非 JSON 或 format 不符，落到下面的通用错误 */
  }
  throw new Error('文件不是有效的 ZIP 包（.lfplugin）');
}

/**
 * 把解析后的 ZIP 包物化到 plugins_root（确认对话框确认后调用）。
 *
 * - source==='draft' → saveDraftPlugin（写 draft:true 标记，进「我的草稿」）。
 * - source==='local'/缺失 → writePluginFiles（含 manifest.json，非草稿，立即可运行）。
 * - **版本感知覆盖**：若 existingVersions 含同 id 且包版本更高（isVersionNewer）→ 用原 id 覆盖升级
 *   （不 dedupe 改名），返回 upgraded:true。同版本/低版本/不存在 → 维持 dedupeImportId 改名逻辑（避免误覆盖）。
 * - id 去重：dedupeImportId 防覆盖现有插件目录（仅非升级路径）。
 *
 * @param existingVersions 现有插件的 id→version 映射（调用方从 scanPluginStatus 的 id+version 构造）。
 * @returns { id, source, upgraded } 最终 plugin_id、落点来源、是否为版本升级覆盖。
 */
export async function materializeZipPlugin(
  result: ZipImportResult,
  existingIds: string[],
  existingVersions?: Record<string, string>,
): Promise<{ id: string; source: PluginPackageSource; upgraded: boolean }> {
  const incomingVersion = String(result.manifest.version ?? '0.0.0');
  const baseId = safePluginId(result.id);
  const existingVersion = existingVersions?.[baseId];
  // 升级判定：现有同 id 插件 + 包版本严格更高 → 覆盖原 id（不 dedupe）。
  const isUpgrade = Boolean(existingVersion) && isVersionNewer(incomingVersion, existingVersion!);
  const finalId = isUpgrade ? baseId : dedupeImportId(baseId, existingIds);
  if (result.source === 'draft') {
    await saveDraftPlugin({
      id: finalId,
      manifest: { ...result.manifest, id: finalId },
      files: result.files.map((f) => [f.path, f.content] as [string, string]),
    });
  } else {
    await writePluginFiles(finalId, [
      { path: MANIFEST_FILE, content: `${JSON.stringify({ ...result.manifest, id: finalId }, null, 2)}\n` },
      ...result.files.map((f) => ({ path: f.path, content: f.content })),
    ]);
  }
  return { id: finalId, source: result.source, upgraded: isUpgrade };
}
