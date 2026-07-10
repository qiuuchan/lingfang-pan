// creator-tools.ts —— 插件创建器共享纯函数：草稿 manifest、结构校验与提交发布。
//
// Agent 工具壳已迁移到 lib/agent/tools.ts（OpenAI Agents SDK，PascalCase 工具名），
// 本文件只保留 UI/提交/校验可复用的无框架工具函数，避免再次引入 ai tool() 双轨。
import type { PluginCapability } from '@lingfang/contract';
import { api, type ApiError } from '@/lib/api';
import { uploadPlugin, type UploadProgress } from '@/lib/plugin-upload';
import type { DraftFile } from '@/lib/types';

/** 暂存的插件草稿：AI 生成的 manifest 字段 + 全部文件。供前端预览/编辑/提交。 */
export interface StagedPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime_type: 'client' | 'nodejs' | 'python';
  entry: string;
  visibility: 'private' | 'tenant';
  capabilities: PluginCapability[];
  files: DraftFile[];
}

const DEFAULT_CAPABILITY: PluginCapability = {
  kind: 'ui.view',
  reason: '展示插件界面',
  risk: 'low',
  requires_admin: false,
};

type StagedPluginManifestSource = Omit<StagedPlugin, 'files'>;

export function buildStagedManifest(draft: StagedPluginManifestSource) {
  return {
    id: draft.id,
    name: draft.name,
    version: draft.version,
    description: draft.description,
    runtime_type: draft.runtime_type,
    entry: draft.entry,
    visibility: draft.visibility,
    capabilities: draft.capabilities.length ? draft.capabilities : [DEFAULT_CAPABILITY],
  };
}

export function buildStagedManifestContent(draft: StagedPluginManifestSource): string {
  return `${JSON.stringify(buildStagedManifest(draft), null, 2)}\n`;
}

export function withSyncedStagedManifest(draft: StagedPlugin): StagedPlugin {
  const manifestFile: DraftFile = {
    path: 'manifest.json',
    content: buildStagedManifestContent(draft),
  };
  return {
    ...draft,
    files: [manifestFile, ...draft.files.filter((file) => file.path !== 'manifest.json')],
  };
}

// 文件路径安全校验（禁绝对路径/空段/../反斜杠/隐藏段），与后端 cleanPath 行为对齐。
export function isSafePath(p: string): boolean {
  if (!p || p.includes('\\') || /^[\\/]/.test(p)) return false;
  return !p.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'));
}

/** 校验暂存草稿结构（路径合法 + 入口存在），返回错误信息或 null。 */
export function validateStagedFiles(entry: string, files: DraftFile[]): string | null {
  if (!files.length) return '插件至少要包含一个文件';
  if (!files.every((f) => isSafePath(f.path))) return '文件路径非法（禁绝对路径/空段/../）';
  if (!files.some((f) => f.path === entry)) return `入口文件 ${entry} 不在 files 中`;
  return null;
}

/**
 * 完整性校验：在 validateStagedFiles 基础上，追加按 runtime_type 的「必需文件 + 入口命名」校验。
 */
export function validateStagedCompleteness(
  runtime_type: 'client' | 'nodejs' | 'python',
  entry: string,
  files: DraftFile[],
): string | null {
  const base = validateStagedFiles(entry, files);
  if (base) return base;

  const has = (path: string) => files.some((file) => file.path === path);

  switch (runtime_type) {
    case 'client':
      if (!entry.endsWith('.html')) {
        return `前端（client）插件入口应为 HTML 文件（建议 ui/index.html），当前 entry=${entry}。请生成 HTML 入口并设为 entry。`;
      }
      break;
    case 'nodejs':
      if (entry !== 'index.js') {
        return `Node.js 插件入口必须命名为 index.js（当前 entry=${entry}）。请把入口文件改名为 index.js 并同步 entry。`;
      }
      if (!has('package.json')) {
        return 'Node.js 插件缺少 package.json，请补一个（无依赖时 dependencies 用 {} 即可），否则无法安装运行。';
      }
      break;
    case 'python':
      if (entry !== 'main.py') {
        return `Python 插件入口必须命名为 main.py（当前 entry=${entry}）。请把入口文件改名为 main.py 并同步 entry。`;
      }
      if (!has('requirements.txt')) {
        return 'Python 插件缺少 requirements.txt，请补一个（无依赖时留空文件即可），否则无法安装运行。';
      }
      break;
  }
  return null;
}

/**
 * submitStagedPlugin：用户在预览面板点「提交到团队空间」时调用，真正上传发布。
 *
 * 后端 uploadPlugin 现在按 manifest.id 识别同插件：团队内已有同 id 插件 → 走升级（editPluginDraft
 * in-place 更新，返回 upgraded:true）；否则新建；同 contentHash → 去重。
 * 调用方据 upgraded 给「升级」/「已发布」不同提示。
 *
 * 返回 id（后端 plugin.id）：本地行「发布到市场」需要在 upload 后拿到 plugin.id 再调
 * submit-marketplace，故从 res.plugin.id 透传出来（升级/去重路径同样有 plugin.id）。
 */
export async function submitStagedPlugin(
  draft: StagedPlugin,
  onProgress?: (info: UploadProgress) => void,
): Promise<{ ok: true; name: string; id?: string; upgraded?: boolean } | { ok: false; message: string }> {
  const prepared = withSyncedStagedManifest(draft);
  const err = validateStagedCompleteness(prepared.runtime_type, prepared.entry, prepared.files);
  if (err) return { ok: false, message: err };
  try {
    const manifest = buildStagedManifest(prepared);
    // 有 onProgress 时走 Rust upload_plugin（Channel 进度推送），无时走 fetch api()（小插件快路径）。
    if (onProgress) {
      const res = await uploadPlugin(
        { manifest, files: prepared.files, priceCents: 0 },
        onProgress,
      );
      return { ok: true, name: prepared.name, id: res.plugin?.id, upgraded: res.upgraded === true };
    }
    // 后端返回 { plugin, upgraded?, deduplicated? }：upgraded=true 表示升级覆盖了团队内同 id 插件。
    // plugin.id 始终存在（uploadPlugin 无论新建/升级/去重都返回 publicPlugin(plugin, ...)）。
    // 大插件（含 vendor/ 内嵌上游源码）JSON payload 可达数 MB，默认 30s 超时可能不够，放宽到 120s。
    const res = await api<{ plugin: { id: string }; upgraded?: boolean; deduplicated?: boolean }>('/api/plugins/upload', {
      method: 'POST',
      body: {
        manifest,
        files: prepared.files,
        priceCents: 0,
      },
      timeoutMs: 120_000,
    });
    return { ok: true, name: prepared.name, id: res.plugin?.id, upgraded: res.upgraded === true };
  } catch (e) {
    return { ok: false, message: `提交失败：${(e as ApiError).message || String(e)}` };
  }
}
