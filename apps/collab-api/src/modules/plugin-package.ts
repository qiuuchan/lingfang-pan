import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { badRequest, conflict, forbidden } from '../common';
import { parseStrictSemVer } from './plugin-semver';

export type PluginFileInput = {
  path: string;
  content: string;
  /**
   * 是否为二进制文件。true 时 content 为 base64 编码的字节（与 .lfplugin v3 导入/导出对称）。
   * 大小计量按 base64 解码后的字节数。默认 false（content 为 UTF-8 文本）。
   */
  binary?: boolean;
};

export type PluginManifestInput = {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  runtime_type?: string;
  runtimeType?: string;
  entry?: string;
  visibility?: string;
  capabilities?: Array<{ kind?: string; reason?: string; risk?: string; requires_admin?: boolean; scope?: unknown }>;
};

export type PluginPackageInput = {
  manifest?: PluginManifestInput;
  files?: PluginFileInput[];
  priceCents?: number;
};

export type NormalizedPluginPackage = {
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    runtime_type: 'client' | 'cloud' | 'nodejs' | 'python' | 'workflow';
    entry: string;
    visibility: 'private' | 'tenant';
    capabilities: Array<{ kind: string; reason: string; risk: string; requires_admin: boolean; scope?: unknown }>;
  };
  files: PluginFileInput[];
  runtimeType: 'CLIENT' | 'CLOUD' | 'NODEJS' | 'PYTHON';
  visibility: 'PRIVATE' | 'TEAM';
  contentHash: string;
};

// 上传限制（v3 起支持 vendored 大包 + 二进制）：
// 文件数 1500（完整 vendored 上游源码树 + 模板/预览图可达上千文件，如 Pixelle-Video）、
// 单文件 60MiB（字体/音频可达 ~55M）、总 300MiB（MPT 完整 ~200M）。
const MAX_PLUGIN_FILES = 1500;
const MAX_PLUGIN_FILE_BYTES = 60 * 1024 * 1024;
const MAX_PLUGIN_TOTAL_BYTES = 300 * 1024 * 1024;
const MAX_MANIFEST_ID_LENGTH = 128;
const MAX_MANIFEST_NAME_LENGTH = 128;
const MAX_MANIFEST_DESCRIPTION_LENGTH = 4096;
const MAX_MANIFEST_ENTRY_LENGTH = 512;
const MAX_MANIFEST_CAPABILITIES = 64;
const MAX_CAPABILITY_REASON_LENGTH = 500;

// 合法 runtime_type 白名单（与契约 RuntimeType 四值一致）。
// nodejs/python 为脚本型运行时：上传云端仅做源码托管，预览执行由桌面壳本地完成（见 R3）。
const ALLOWED_RUNTIME_TYPES = ['client', 'cloud', 'nodejs', 'python', 'workflow'] as const;

// 运行时类型映射表（小写 manifest 值 → Prisma 枚举大写）。
// 头号陷阱修复（design §4.1）：原 `runtime === 'client' ? 'CLIENT' : 'CLOUD'` 三元
// 会把 nodejs/python 误判为 CLOUD，导致数据库 enum 与 manifest runtime_type 不一致。
// 改用显式映射表 + 兜底，保证四值一一对应。
const RUNTIME_TYPE_MAP: Record<string, 'CLIENT' | 'CLOUD' | 'NODEJS' | 'PYTHON'> = {
  client: 'CLIENT',
  cloud: 'CLOUD',
  nodejs: 'NODEJS',
  python: 'PYTHON',
};
const ALLOWED_CAPABILITIES = new Set([
  'ui.view', 'fs.pick', 'fs.read', 'fs.write', 'net.fetch',
  'clipboard', 'llm.chat', 'image.generate', 'image.edit', 'storage.kv',
  'system.info', 'system.screenshot', 'system.notify',
  'plugin.upload', 'plugin.submitMarketplace',
  'video.generate',
]);
const ALLOWED_CAPABILITY_RISKS = new Set(['none', 'low', 'medium', 'high']);

function manifestString(
  value: unknown,
  field: string,
  options: { defaultValue?: string; maxLength?: number; trim?: boolean; allowEmpty?: boolean } = {},
) {
  const raw = value === undefined ? options.defaultValue : value;
  if (typeof raw !== 'string') throw badRequest(`manifest.${field} 必须是字符串`);
  const text = options.trim ? raw.trim() : raw;
  if (!options.allowEmpty && !text) throw badRequest(`manifest.${field} 不能为空`);
  if (options.maxLength !== undefined && text.length > options.maxLength) {
    throw badRequest(`manifest.${field} 长度不能超过 ${options.maxLength}`, { field, limit: options.maxLength });
  }
  return text;
}

function cleanPath(value: unknown) {
  const path = String(value || '').trim().replace(/\\/g, '/');
  if (!path) throw badRequest('插件文件路径不能为空');
  if (path.startsWith('/') || path.startsWith('~') || /^[a-zA-Z]:\//.test(path)) throw badRequest('插件文件路径不能是绝对路径', { path });
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw badRequest('插件文件路径不能包含空段或 ..', { path });
  // 允许点开头的文件名（如 .gitignore/.npmrc，vendored 源码树常见）；仍拒 `.``/`..``/空段（上面已校验）。
  return path;
}

function normalizedRuntime(manifest: PluginManifestInput) {
  const snakeCase = manifest.runtime_type;
  const raw = snakeCase === undefined || snakeCase === '' ? manifest.runtimeType : snakeCase;
  const value = raw === undefined || raw === '' ? 'client' : raw;
  if (typeof value !== 'string') throw badRequest('manifest.runtime_type 必须是字符串');
  const runtime = value.toLowerCase();
  if (!ALLOWED_RUNTIME_TYPES.includes(runtime as typeof ALLOWED_RUNTIME_TYPES[number])) {
    throw badRequest('runtime_type 只允许 client / cloud / nodejs / python / workflow');
  }
  return runtime as typeof ALLOWED_RUNTIME_TYPES[number];
}

function normalizedVisibility(value: unknown) {
  const raw = value === undefined || value === '' ? 'tenant' : value;
  if (typeof raw !== 'string') throw badRequest('manifest.visibility 必须是字符串');
  const visibility = raw.toLowerCase();
  if (visibility !== 'tenant' && visibility !== 'private') {
    throw badRequest('visibility 只允许 tenant 或 private');
  }
  return visibility;
}

function normalizedCapabilities(input: unknown): NormalizedPluginPackage['manifest']['capabilities'] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw badRequest('manifest.capabilities 必须是数组');
  if (input.length > MAX_MANIFEST_CAPABILITIES) {
    throw badRequest(`manifest.capabilities 不能超过 ${MAX_MANIFEST_CAPABILITIES} 项`, {
      count: input.length,
      limit: MAX_MANIFEST_CAPABILITIES,
    });
  }
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest('manifest.capabilities 条目必须是对象', { index });
    }
    const capability = raw as Record<string, unknown>;
    const kind = capability.kind;
    if (typeof kind !== 'string' || !ALLOWED_CAPABILITIES.has(kind)) {
      throw badRequest('插件能力不在允许范围内', { index, kind });
    }
    const reason = capability.reason === undefined ? '' : capability.reason;
    if (typeof reason !== 'string') {
      throw badRequest('manifest.capabilities.reason 必须是字符串', { index });
    }
    if (reason.length > MAX_CAPABILITY_REASON_LENGTH) {
      throw badRequest(`manifest.capabilities.reason 长度不能超过 ${MAX_CAPABILITY_REASON_LENGTH}`, {
        index,
        limit: MAX_CAPABILITY_REASON_LENGTH,
      });
    }
    const risk = capability.risk === undefined ? 'low' : capability.risk;
    if (typeof risk !== 'string' || !ALLOWED_CAPABILITY_RISKS.has(risk)) {
      throw badRequest('插件能力 risk 不合法', { index, kind, risk });
    }
    const requiresAdmin = capability.requires_admin === undefined ? false : capability.requires_admin;
    if (typeof requiresAdmin !== 'boolean') {
      throw badRequest('manifest.capabilities.requires_admin 必须是布尔值', { index });
    }
    const scope = capability.scope;
    if (scope !== undefined && (!scope || typeof scope !== 'object' || Array.isArray(scope))) {
      throw badRequest('manifest.capabilities.scope 必须是对象', { index });
    }
    return {
      kind,
      reason,
      risk,
      // AI 能力只以 manifest 声明作为运行门禁，不保留管理员审批语义。
      requires_admin: kind === 'llm.chat' || kind === 'image.generate' ? false : requiresAdmin,
      ...(scope === undefined ? {} : { scope }),
    };
  });
}

export function normalizePluginPackage(input: PluginPackageInput): NormalizedPluginPackage {
  const manifest = input.manifest;
  const rawFiles = input.files;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw badRequest('manifest 不能为空');
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) throw badRequest('files 不能为空');
  if (rawFiles.length > MAX_PLUGIN_FILES) throw badRequest('插件文件数量超限', { count: rawFiles.length, limit: MAX_PLUGIN_FILES });

  const name = manifestString(manifest.name, 'name', { maxLength: MAX_MANIFEST_NAME_LENGTH, trim: true });
  const id = manifestString(manifest.id, 'id', { defaultValue: name, maxLength: MAX_MANIFEST_ID_LENGTH, trim: true });
  const version = manifestString(manifest.version, 'version', { defaultValue: '0.1.0', trim: true });
  if (!parseStrictSemVer(version)) throw badRequest('manifest.version 必须是严格 SemVer', { version });
  const description = manifestString(manifest.description, 'description', {
    defaultValue: '',
    maxLength: MAX_MANIFEST_DESCRIPTION_LENGTH,
    allowEmpty: true,
  });
  const entry = cleanPath(manifestString(manifest.entry, 'entry', {
    defaultValue: 'ui/index.html',
    maxLength: MAX_MANIFEST_ENTRY_LENGTH,
    trim: true,
  }));
  const runtime = normalizedRuntime(manifest);
  const visibilityValue = normalizedVisibility(manifest.visibility);

  const seen = new Set<string>();
  let totalBytes = 0;
  const files = rawFiles.map((file) => {
    if (!file || typeof file !== 'object') throw badRequest('文件格式不正确');
    const path = cleanPath(file.path);
    if (seen.has(path)) throw conflict('插件文件路径重复', { path });
    seen.add(path);
    if (typeof file.content !== 'string') throw badRequest('插件文件内容必须是字符串', { path });
    // 二进制文件（binary:true）：content 为 base64，按解码后字节数计量（避免 33% 膨胀误判）。
    // 文本文件：按 UTF-8 字节数计量。
    const bytes = file.binary ? Buffer.from(file.content, 'base64').length : Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_PLUGIN_FILE_BYTES) throw badRequest('单个插件文件过大', { path, limitBytes: MAX_PLUGIN_FILE_BYTES });
    totalBytes += bytes;
    if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) throw badRequest('插件包总大小超限', { limitBytes: MAX_PLUGIN_TOTAL_BYTES });
    return { path, content: file.content, ...(file.binary ? { binary: true } : {}) };
  }).sort((a, b) => a.path.localeCompare(b.path));

  if (!seen.has(entry)) throw badRequest('manifest.entry 指向的文件不存在', { entry });
  const capabilities = normalizedCapabilities(manifest.capabilities);

  const normalizedManifest = {
    id,
    name,
    version,
    description,
    runtime_type: runtime,
    entry,
    visibility: visibilityValue as 'private' | 'tenant',
    capabilities,
  };
  const contentHash = createHash('sha256').update(JSON.stringify({ manifest: normalizedManifest, files })).digest('hex');
  return {
    manifest: normalizedManifest,
    files,
    runtimeType: RUNTIME_TYPE_MAP[runtime] ?? 'CLIENT',
    visibility: visibilityValue === 'private' ? 'PRIVATE' : 'TEAM',
    contentHash,
  };
}

export type PublicPluginInput = {
  id: string;
  name: string;
  description: string;
  version: string;
  entry: string;
  runtimeType: string;
  status: string;
  visibility: string;
  teamId: string | null;
  authorUserId: string | null;
  files: unknown;
  manifest: unknown;
  capabilities: unknown;
  contentHash: string;
  reviewStatus: string;
  reviewReason: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  marketplace: boolean;
  priceCents: number;
  installCount: number;
  ratingCount: number;
  ratingSum: number;
  createdAt: Date;
  updatedAt: Date;
  aiPolicyVersion?: number;
  aiPolicyStatus?: string;
  aiPolicyReason?: string;
};

export function publicPlugin(plugin: PublicPluginInput, currentTeamId?: string) {
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    entry: plugin.entry,
    runtimeType: plugin.runtimeType,
    runtime_type: String(plugin.runtimeType).toLowerCase(),
    status: plugin.status,
    visibility: plugin.visibility,
    teamId: plugin.teamId,
    authorUserId: plugin.authorUserId,
    files: plugin.files,
    manifest: plugin.manifest,
    capabilities: plugin.capabilities,
    contentHash: plugin.contentHash,
    reviewStatus: plugin.reviewStatus,
    reviewReason: plugin.reviewReason,
    reviewedById: plugin.reviewedById,
    reviewedAt: plugin.reviewedAt?.toISOString() || null,
    marketplace: plugin.marketplace,
    priceCents: plugin.priceCents,
    installCount: plugin.installCount,
    ratingCount: plugin.ratingCount,
    ratingSum: plugin.ratingSum,
    source: plugin.teamId === currentTeamId ? 'team' : plugin.marketplace ? 'marketplace' : 'platform',
    aiPolicyVersion: plugin.aiPolicyVersion ?? 0,
    aiPolicyStatus: plugin.aiPolicyStatus || 'UNCHECKED',
    aiPolicyReason: plugin.aiPolicyReason || '',
    createdAt: plugin.createdAt.toISOString(),
    updatedAt: plugin.updatedAt.toISOString(),
  };
}

export function publicAvailablePlugin(
  plugin: PublicPluginInput & { installations?: Array<{ version?: string }> },
  currentTeamId: string,
) {
  const public_ = publicPlugin(plugin, currentTeamId);
  const isOwnTeam = plugin.teamId === currentTeamId;
  const installations = plugin.installations ?? [];
  const isInstalled = installations.length > 0;
  // 已安装版本（PluginInstallation.version）：供前端对比 version（最新版）判断是否有更新。
  // 一个团队对一个插件只有一条 ENABLED installation，取第一条。
  const installedVersion = isInstalled ? installations[0]?.version : undefined;
  if (isOwnTeam) {
    // 本团队插件也注入 installedVersion：作者/团队成员在本机安装了旧版时，
    // 团队 tab 同样需要显示「更新」按钮（hasUpdate = installedVersion && isVersionNewer）。
    // files/manifest 本团队始终可见（作者视角），故不按 isInstalled 隐藏。
    return { ...public_, installedVersion };
  }

  return {
    ...public_,
    files: isInstalled ? public_.files : undefined,
    manifest: isInstalled ? public_.manifest : undefined,
    reviewReason: undefined,
    reviewedById: undefined,
    // installedVersion 仅在已安装时返回（未安装时 undefined，前端不显示更新按钮）。
    installedVersion,
  };
}

export function ensurePluginManager(plugin: { teamId: string | null; authorUserId: string | null }, teamId: string, userId: string, role: string) {
  if (plugin.teamId !== teamId) throw forbidden('不能操作其他团队的插件');
  if (plugin.authorUserId !== userId && role !== 'TEAM_ADMIN') throw forbidden('仅作者或团队管理员可操作该插件');
}

export type { Prisma };
