// plugin-package-zip.ts —— `.lfplugin` ZIP 包导出/导入（本地插件 & 草稿插件通用）。
//
// `.lfplugin` v3 = ZIP 包，结构：
//   _meta.json   { format: 'lingfang-plugin', version: 3, source, exportedAt, name, binaryFiles?: string[] }
//   manifest.json  原始 manifest（含 capabilities/visibility/runtime_type 等全部字段）
//   <文本源文件>    main.py / index.js / ui/index.html / requirements.txt / ...（UTF-8 直存）
//   <二进制源文件>  字体/图片/音频（base64 编码存，路径列入 _meta.binaryFiles）
//
// 设计要点：
// - 二进制处理（v3）：导出时 readLocalPluginFile 命中占位 → 改 readLocalPluginFileBytes 取 base64 →
//   zip.file(path, base64, {base64:true})，路径记入 _meta.binaryFiles。导入时按名单用
//   entry.async('base64') 读 + writePluginFileBytes 写真实字节。文本文件仍走 async('string') + writePluginFiles。
// - v2 向后兼容：旧包无 binaryFiles 字段，按纯文本处理（二进制本就被 v2 导出跳过，无丢失）。
// - 导入落点按 _meta.json.source：'draft' → saveDraftPlugin(draft:true)；'local'/缺失 → writePluginFiles(非草稿, 可运行)。
// - id 去重：与已有本地/草稿插件冲突时 dedupeImportId 追加 -2/-3，绝不覆盖现有目录。
// - manifest.json 用磁盘原文件（非重新生成），保留所有字段；导入时原样物化。
// - 旧 JSON 单文件 v1 格式已废弃（无存量文件、spec 无记录），遇 v1 报错引导重新导出。
import JSZip from 'jszip';
import {
  listPluginFiles,
  readLocalPluginFile,
  readLocalPluginFileBytes,
  writePluginFiles,
  writePluginFileBytes,
} from '@/lib/plugin-status';
import { isBinaryPlaceholder, saveDraftPlugin } from '@/lib/draft-plugin';
import { safePluginId } from '@/lib/plugin-draft';
import { isVersionNewer } from '@/lib/version';
import { dedupeImportId } from '@/pages/plugins/use-local-import';
import type { DraftFile } from '@/lib/types';

/** 包内来源标记：决定导入后落草稿还是本地。 */
export type PluginPackageSource = 'local' | 'draft';

/** _meta.json 内容（包标识 + 来源 + 导出时间 + 二进制文件名单）。 */
interface PackageMeta {
  format: 'lingfang-plugin';
  version: 2 | 3;
  source: PluginPackageSource;
  exportedAt: string;
  name: string;
  /** v3：二进制文件路径名单（content 在 ZIP 里以 base64 存）。v2 包无此字段。 */
  binaryFiles?: string[];
}

const META_FILE = '_meta.json';
const MANIFEST_FILE = 'manifest.json';
const PLUGIN_FORMAT = 'lingfang-plugin' as const;
/** 当前写入版本（v3 支持二进制）。读取时接受 v2（向后兼容，按纯文本处理）。 */
const PLUGIN_VERSION = 3;

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
  const binaryFiles: string[] = [];

  // 逐个读内容；二进制占位 → 改读 base64 真实字节并记入 binaryFiles（不再跳过）。
  // manifest.json 单独收存（用磁盘原文件，非重新生成）。
  for (const path of paths) {
    const content = await readLocalPluginFile(pluginId, path);
    if (isBinaryPlaceholder(content)) {
      if (path === MANIFEST_FILE) {
        // manifest.json 不可能是二进制；若命中说明异常，跳过避免损坏。
        skipped += 1;
        continue;
      }
      // 二进制文件：读 base64 真实字节，以 base64 存入 ZIP，路径记入名单。
      const b64 = await readLocalPluginFileBytes(pluginId, path);
      zip.file(path, b64, { base64: true });
      binaryFiles.push(path);
      fileCount += 1;
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
    ...(binaryFiles.length > 0 ? { binaryFiles } : {}),
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
  // 接受 v2（纯文本，向后兼容）与 v3（支持二进制）。v1（旧 JSON 单文件）在 rejectLegacyJsonOrInvalid 拦截。
  if (meta.version !== 2 && meta.version !== 3) {
    throw new Error(`插件包版本 v${meta.version} 不受支持，请用当前版本重新导出（支持 v2/v3）`);
  }
  const source: PluginPackageSource = meta.source === 'draft' ? 'draft' : 'local';
  const binarySet = new Set(meta.binaryFiles ?? []);

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
  // 二进制文件（_meta.binaryFiles 名单）：读 base64，标 binary:true；文本文件：读 UTF-8 字符串。
  const files: DraftFile[] = [];
  const entries = Object.values(resolvedZip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    if (isMetaOrManifest(entry.name)) continue;
    // 跳过 macOS 打包脏文件（__MACOSX/、.DS_Store）与目录占位。
    if (entry.name.startsWith('__MACOSX/') || entry.name.endsWith('.DS_Store')) continue;
    if (binarySet.has(entry.name)) {
      const b64 = await entry.async('base64');
      files.push({ path: entry.name, content: b64, binary: true });
    } else {
      const content = await entry.async('string');
      files.push({ path: entry.name, content });
    }
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

  // 拆分文本/二进制文件：文本走批量写，二进制逐个写字节（writePluginFileBytes）。
  const textFiles = result.files.filter((f) => !f.binary);
  const binaryFiles = result.files.filter((f) => f.binary);

  if (result.source === 'draft') {
    await saveDraftPlugin({
      id: finalId,
      manifest: { ...result.manifest, id: finalId },
      files: textFiles.map((f) => [f.path, f.content] as [string, string]),
    });
    // 二进制文件单独写字节（saveDraftPlugin 走文本路径，二进制会被 isBinaryPlaceholder 误过滤）。
    for (const f of binaryFiles) {
      await writePluginFileBytes(finalId, f.path, f.content);
    }
  } else {
    await writePluginFiles(finalId, [
      { path: MANIFEST_FILE, content: `${JSON.stringify({ ...result.manifest, id: finalId }, null, 2)}\n` },
      ...textFiles.map((f) => ({ path: f.path, content: f.content })),
    ]);
    for (const f of binaryFiles) {
      await writePluginFileBytes(finalId, f.path, f.content);
    }
  }
  return { id: finalId, source: result.source, upgraded: isUpgrade };
}
