// import-local.ts —— 从电脑本地文件/文件夹导入插件，转成草稿（StagedPlugin）以复用预览/改信息/提交流程。
//
// 用纯前端 <input type="file">（文件夹用 webkitdirectory）读取字节，webkitRelativePath 拿相对路径，
// 零原生（Tauri/Rust）改动。导入后进入草稿态，用户可预览、改信息、继续让 AI 改、再提交。
import type { PluginCapability } from '@lingfang/contract';
import { parseManifest, safePluginId, cleanPathFrontend } from '@/lib/plugin-draft';
import type { StagedPlugin } from '@/lib/plugin-creator/creator-tools';
import { EXTERNAL_TOOL_PROVENANCE } from '@/lib/plugin-provenance';
import type { DraftFile } from '@/lib/types';

const DEFAULT_CAPABILITY: PluginCapability = {
  kind: 'ui.view',
  reason: '展示插件界面',
  risk: 'low',
  requires_admin: false,
};

// v4 ZIP 总上限为 1500 entries；固定 _meta.json + manifest.json 占 2 条。
export const MAX_SOURCE_FILES = 1498;
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

// 文本文件扩展名白名单：白名单内尝试 fatal UTF-8 解码；失败或其余扩展名按二进制处理。
const TEXT_EXTENSIONS = new Set([
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'json',
  'jsonc',
  'py',
  'pyi',
  'txt',
  'md',
  'markdown',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'csv',
  'svg',
  'xml',
  'env',
  'sh',
  'bat',
  'lock',
]);

function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return true; // 无扩展名（如 Dockerfile、LICENSE）按文本处理。
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** ArrayBuffer → 标准 base64 字符串（无换行），供 writePluginFileBytes 写盘。 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000; // 避免超大数组 callstack 溢出，分块拼接。
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeUtf8(buffer: ArrayBuffer): string | null {
  try {
    // ignoreBOM keeps U+FEFF in the string so a later UTF-8 write preserves
    // the original BOM bytes instead of silently changing the file.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** 从浏览器 File 列表读取文件，归一为 tagged DraftFile[]（path 去掉顶层目录名）。 */
export interface ImportResult {
  files: DraftFile[];
  skipped: string[]; // 跳过的文件（超限/非法路径），UI 提示用。
  rootName: string; // 推断的根目录名（用作插件 id 兜底）。
}

export async function readLocalFiles(fileList: FileList | File[]): Promise<ImportResult> {
  const all = Array.from(fileList);
  const skipped: string[] = [];
  const files: DraftFile[] = [];
  let totalBytes = 0;

  // 推断顶层目录名（webkitdirectory 时 relativePath 形如 "my-plugin/ui/index.html"）。
  let rootName = '';
  const first = all[0] as File & { webkitRelativePath?: string };
  if (first?.webkitRelativePath) {
    rootName = first.webkitRelativePath.split('/')[0] || '';
  }

  for (const file of all) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    // 去掉顶层目录名，得到插件内相对路径（单文件导入时无目录前缀，rel 即文件名）。
    const stripped =
      rootName && rel.startsWith(`${rootName}/`) ? rel.slice(rootName.length + 1) : rel;
    const checked = cleanPathFrontend(stripped);
    if (!checked.ok) {
      skipped.push(`${stripped}（路径非法）`);
      continue;
    }
    const path = checked.value;
    // 跳过依赖、版本控制和运行缓存。dist/build 可能包含真实入口，必须保留。
    if (
      /(^|\/)(node_modules|\.git|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache)\//.test(
        `/${path}`
      )
    )
      continue;
    if (file.size > MAX_FILE_BYTES) {
      skipped.push(`${path}（超 ${MAX_FILE_BYTES / 1024 / 1024}MiB，已跳过）`);
      continue;
    }
    if (files.length >= MAX_SOURCE_FILES) {
      skipped.push(
        `${path}（超 ${MAX_SOURCE_FILES} 个源码文件上限；v4 制品 1500 条目含 2 个固定元数据文件）`
      );
      continue;
    }
    if (totalBytes + file.size > MAX_TOTAL_BYTES) {
      skipped.push(`${path}（超 ${MAX_TOTAL_BYTES / 1024 / 1024}MiB 总量上限）`);
      continue;
    }
    const buffer = await file.arrayBuffer();
    const text = isTextPath(path) ? decodeUtf8(buffer) : null;
    totalBytes += file.size;
    if (text !== null) files.push({ path, content: text });
    else files.push({ path, content: arrayBufferToBase64(buffer), binary: true });
  }

  return { files, skipped, rootName };
}

/** 把导入的文件转成草稿：有 manifest.json 则用其字段，否则按入口文件启发式判运行类型。 */
export function filesToStagedPlugin(result: ImportResult): StagedPlugin {
  const { files, rootName } = result;
  const hasManifest = files.some((f) => f.path === 'manifest.json');
  const manifest = parseManifest(files);

  // 运行类型：manifest 优先；无 manifest 时按入口文件启发式。
  const runtimeRaw = manifest.runtime_type;
  let runtime: StagedPlugin['runtime_type'] =
    runtimeRaw === 'cloud' || runtimeRaw === 'nodejs' || runtimeRaw === 'python'
      ? runtimeRaw
      : 'client';
  if (!hasManifest) {
    if (files.some((f) => f.path === 'main.py')) runtime = 'python';
    else if (files.some((f) => f.path === 'index.js')) runtime = 'nodejs';
    else runtime = 'client';
  }

  // 入口：manifest 优先；无则按运行类型默认入口，再回退到第一个匹配文件。
  const defaultEntry =
    runtime === 'python' ? 'main.py' : runtime === 'nodejs' ? 'index.js' : 'ui/index.html';
  let entry = hasManifest && manifest.entry ? manifest.entry : defaultEntry;
  if (!files.some((f) => f.path === entry)) {
    // 入口不存在：client 找任意 .html，否则用第一个文件，保证 entry 有效（提交校验要求 entry∈files）。
    const htmlFallback = files.find((f) => f.path.endsWith('.html'));
    entry =
      (runtime === 'client' && htmlFallback ? htmlFallback.path : files[0]?.path) || defaultEntry;
  }

  // id：manifest.id 优先，其次根目录名，再兜底 'imported-plugin'，统一过 safePluginId 收敛为合法 kebab。
  const idSource = (hasManifest && manifest.id) || rootName || 'imported-plugin';
  const id = safePluginId(idSource);

  // 名字：manifest.title > manifest.name > 根目录名 > id。
  const name = manifest.title || (hasManifest ? manifest.name : '') || rootName || id;

  // 能力：有 manifest 用其声明；无 manifest 时显式用 ui.view 默认能力，避免给导入插件挂上意外的高权限能力。
  const capabilities =
    hasManifest && manifest.capabilities.length
      ? (manifest.capabilities as PluginCapability[])
      : [DEFAULT_CAPABILITY];
  const visibility: StagedPlugin['visibility'] =
    manifest.visibility === 'private' ? 'private' : 'tenant';

  return {
    id,
    name,
    version: manifest.version || '0.1.0',
    description: manifest.description || '',
    runtime_type: runtime,
    entry,
    visibility,
    capabilities,
    files,
    ...EXTERNAL_TOOL_PROVENANCE,
  };
}
