// creator-tools.ts —— 创建器 agent 的工具集（Vercel AI SDK tool 形态）。
//
// 流程改造（预览 + 改信息 + 多轮打磨后再提交）：
// 模型生成插件后，**不再直接发布**，而是调用 stage_plugin 工具把插件「暂存」为草稿。
// 草稿交给 FloatingCreator 在右侧面板实时预览，用户可改名字/描述/ID/版本/运行类型/入口/能力/可见性，
// 也可继续对话让 AI 迭代修改。只有用户点「提交到团队空间」时，才由 submitStagedPlugin 真正
// POST /api/plugins/upload 发布。
import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { PluginCapability } from '@lingfang/contract';
import { api, type ApiError } from '@/lib/api';
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

const DEFAULT_CAPABILITY: PluginCapability = { kind: 'ui.view', reason: '展示插件界面', risk: 'low', requires_admin: false };

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
// 隐藏段（以 . 开头，如 .env/.config）后端 cleanPath 会 400 拒绝，故在 stage 阶段就拦住，
// 让 AI 据返回 message 立即修正，而不是等用户点提交才报错。
function isSafePath(p: string): boolean {
  if (!p || p.includes('\\') || /^[\\/]/.test(p)) return false;
  return !p.split('/').some((s) => !s || s === '.' || s === '..' || s.startsWith('.'));
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
 *
 * 设计动机：AI 经常漏生成入口或依赖清单文件（如 python 缺 main.py/requirements.txt、
 * nodejs 缺 index.js/package.json），旧校验放过后到运行/扫描阶段才报 manifest_missing / 入口缺失，
 * 用户以为生成成功却跑不起来。此处在 stage（生成）、save（落盘）、submit（发布）三处统一拦截，
 * 返回**可执行的中文报错**让 AI 据 message 立即补齐重试，而非把破损草稿放行。
 *
 * 返回错误信息字符串，或 null（结构完整）。
 */
export function validateStagedCompleteness(
  runtime_type: 'client' | 'nodejs' | 'python',
  entry: string,
  files: DraftFile[],
): string | null {
  const base = validateStagedFiles(entry, files);
  if (base) return base;

  const has = (p: string) => files.some((f) => f.path === p);

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

const capabilityParams = z.object({
  kind: z.enum(['ui.view', 'fs.pick', 'fs.read', 'fs.write', 'net.fetch', 'clipboard', 'llm.chat', 'image.generate', 'storage.kv', 'system.info', 'system.screenshot', 'system.notify', 'code-assistant.run', 'code-assistant.session', 'plugin.upload', 'plugin.submitMarketplace']),
  reason: z.string().default(''),
  risk: z.enum(['none', 'low', 'medium', 'high']).default('low'),
  requires_admin: z.boolean().default(false),
  scope: z.record(z.unknown()).optional(),
});

const stageParams = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id 仅小写字母/数字/连字符'),
  name: z.string(),
  version: z.string().default('0.1.0'),
  description: z.string().default(''),
  runtime_type: z.enum(['client', 'nodejs', 'python']),
  entry: z.string(),
  capabilities: z.array(capabilityParams).optional().describe('插件需要的能力声明；调用平台 LLM 时必须包含 llm.chat。'),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
});
type StageArgs = z.infer<typeof stageParams>;

/** stage_plugin 工具返回结果（回灌给模型）。 */
export interface StagePluginResult {
  ok: boolean;
  message: string;
  name?: string;
}

/**
 * submitStagedPlugin：用户在预览面板点「提交到团队空间」时调用，真正上传发布。
 * manifest 字段取用户编辑后的最终值（含改过的名字/能力/可见性）。
 */
export async function submitStagedPlugin(draft: StagedPlugin): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const prepared = withSyncedStagedManifest(draft);
  const err = validateStagedCompleteness(prepared.runtime_type, prepared.entry, prepared.files);
  if (err) return { ok: false, message: err };
  try {
    await api('/api/plugins/upload', {
      method: 'POST',
      body: {
        manifest: buildStagedManifest(prepared),
        files: prepared.files,
        priceCents: 0,
      },
    });
    return { ok: true, name: prepared.name };
  } catch (e) {
    return { ok: false, message: `提交失败：${(e as ApiError).message || String(e)}` };
  }
}

/** ask_question 作答结果（回灌给模型）。 */
export interface AskQuestionResult {
  answer: string;
}

export const askQuestionParams = z.object({
  question: z.string().describe('要向用户澄清的问题，一句话'),
  options: z
    .array(
      z.object({
        label: z.string().describe('选项展示文案'),
        value: z.string().describe('回灌给模型的值'),
      }),
    )
    .optional()
    .describe('可选的预设选项；省略则只让用户自由输入'),
  allowFreeText: z.boolean().default(true).describe('是否允许自由文本作答'),
  multiSelect: z.boolean().default(false).describe('是否允许多选'),
});
export type AskQuestionArgs = z.infer<typeof askQuestionParams>;

/** web_search 单条结果（回灌给模型 + 可供前端展示）。 */
export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/** web_search 工具返回结果（回灌给模型）。 */
export interface WebSearchResult {
  ok: boolean;
  query: string;
  results: WebSearchResultItem[];
  /** 失败/无结果时的说明，便于模型决定是否换关键词重试。 */
  message?: string;
}

export const webSearchParams = z.object({
  query: z.string().min(1).describe('搜索关键词，尽量具体；可用中文或英文'),
  limit: z.number().int().min(1).max(20).optional().describe('期望结果条数，默认 8，上限 20'),
});
export type WebSearchArgs = z.infer<typeof webSearchParams>;

// ── 草稿读写工具（agent 按需读/改草稿，省 token，避免整包重发） ───────────────

export const readDraftParams = z.object({
  path: z.string().min(1).describe('要读取的草稿文件相对路径，如 ui/index.html'),
});
export type ReadDraftArgs = z.infer<typeof readDraftParams>;

export const patchDraftParams = z.object({
  path: z.string().min(1).describe('要新增或覆盖的文件相对路径'),
  content: z.string().describe('文件完整内容（覆盖式写入，不是 diff）'),
});
export type PatchDraftArgs = z.infer<typeof patchDraftParams>;

function scanPluginIssues(draft: StagedPlugin | null) {
  const issues: Array<{ level: 'error' | 'warning'; message: string }> = [];
  if (!draft) return [{ level: 'error' as const, message: '当前还没有草稿，请先生成或导入插件。' }];
  const prepared = withSyncedStagedManifest(draft);
  const completeness = validateStagedCompleteness(prepared.runtime_type, prepared.entry, prepared.files);
  if (completeness) issues.push({ level: 'error', message: completeness });
  const hasLlmCall = prepared.files.some((file) => /sdk\.llm\.chat|llm\.chat|LINGFANG_PLUGIN_BRIDGE_URL/.test(file.content));
  const declaresLlm = prepared.capabilities.some((cap) => cap.kind === 'llm.chat');
  if (hasLlmCall && !declaresLlm) issues.push({ level: 'error', message: '插件使用了 LLM，但 manifest 未声明 llm.chat 能力。' });
  const joined = prepared.files.map((file) => file.content).join('\n');
  if (/sk-[A-Za-z0-9_-]{12,}/.test(joined)) issues.push({ level: 'error', message: '发现疑似硬编码 API Key，请移除密钥。' });
  if (/api\.openai\.com|chat\/completions|v1\/messages|Authorization['"]?\s*:\s*['"]?Bearer/i.test(joined) && !/LINGFANG_PLUGIN_BRIDGE_URL/.test(joined)) {
    issues.push({ level: 'warning', message: '发现疑似第三方模型直连接口，应改用 sdk.llm.chat 或脚本桥。' });
  }
  if (prepared.files.some((file) => !isSafePath(file.path))) issues.push({ level: 'error', message: '存在非法文件路径。' });
  return issues;
}

/** 团队插件精简条目（list_team_plugins 返回，避免把全文塞给模型）。 */
export interface TeamPluginBrief {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime_type: string;
}

/**
 * 工厂：构造创建器工具集。
 * - stage_plugin：校验后把草稿交给 onStagePlugin（前端暂存到预览面板），不发布。
 * - ask_question：信息不足时人在环提问，execute 返回等待用户作答的 deferred Promise。
 * - web_search：内置默认启用的多源聚合网络搜索，调后端 /api/search（免用户密钥、服务端自动跳过被墙源）。
 * - list_draft_files / read_draft_file / patch_draft_file：让 agent 按需查看/读取/增量改当前草稿，
 *   省 token（不必整包重发），改完自动刷新预览。getDraft 用 ref 取最新草稿避免闭包陈旧。
 * - list_team_plugins：查团队已有插件，避免重复造轮子 / 参考命名风格。
 */
export function createCreatorTools(opts: {
  onStagePlugin: (draft: StagedPlugin) => void;
  onAskQuestion: (args: AskQuestionArgs, toolCallId: string) => Promise<AskQuestionResult>;
  /** 取当前草稿（合并用户编辑后的最新值）；无草稿返回 null。用 ref 包装避免闭包读到旧值。 */
  getDraft: () => StagedPlugin | null;
  /** patch_draft_file 改/增文件后回调，前端更新草稿并刷新预览。 */
  onPatchDraft: (path: string, content: string) => void;
}) {
  const stagePluginTool = tool({
    description:
      '把生成的插件暂存为草稿，交给用户在右侧面板预览并按需修改信息（名字/描述/版本/能力等），' +
      '用户确认后会手动提交发布。当插件的 manifest 与全部文件都齐备时调用此工具。' +
      '调用前请确保：entry 存在于 files；client→ui/index.html、nodejs→index.js(+package.json)、python→main.py(+requirements.txt)。' +
      '文件路径只能是相对路径，禁绝对/空段/..。' +
      '返回 { ok, message }：成功则告诉用户「已生成草稿，可在右侧预览并修改后提交」；失败则据 message 修正后重试。' +
      '不要重复 stage 已经成功的同一版本——用户要继续改时会再次对话。',
    inputSchema: zodSchema(stageParams),
    execute: async (args: StageArgs): Promise<StagePluginResult> => {
      const draft = withSyncedStagedManifest({
        id: args.id,
        name: args.name,
        version: args.version,
        description: args.description,
        runtime_type: args.runtime_type,
        entry: args.entry,
        visibility: 'tenant',
        capabilities: args.capabilities?.length ? args.capabilities : [DEFAULT_CAPABILITY],
        files: args.files,
      });
      const err = validateStagedCompleteness(draft.runtime_type, draft.entry, draft.files);
      if (err) return { ok: false, message: err };
      opts.onStagePlugin(draft);
      return { ok: true, message: `已生成插件「${args.name}」草稿，用户可在右侧预览并修改信息后提交。`, name: args.name };
    },
  });

  const askQuestionTool = tool({
    description:
      '当信息不足、需求有歧义、或需要用户在多个方案中选择时，调用此工具向用户发起结构化提问（不要用纯文本提问）。' +
      '能用预设 options 就给选项，减少用户打字。返回 { answer }：用户的回答，据此继续后续流程。',
    inputSchema: zodSchema(askQuestionParams),
    execute: (args: AskQuestionArgs, context: { toolCallId: string }): Promise<AskQuestionResult> =>
      opts.onAskQuestion(args, context.toolCallId),
  });

  const webSearchTool = tool({
    description:
      '联网搜索：当需要最新信息、查 API/库用法、了解第三方服务、核实事实或获取你训练数据之外的内容时调用。' +
      '内置默认可用，无需任何配置或密钥。返回 { ok, query, results:[{title,url,snippet,source}], message }。' +
      '拿到结果后请基于 snippet/标题归纳，引用关键来源；ok 为 false 或 results 为空时，可换更具体的关键词重试一次。' +
      '不要用它替代向用户提问（澄清需求用 ask_question）。',
    inputSchema: zodSchema(webSearchParams),
    execute: async (args: WebSearchArgs): Promise<WebSearchResult> => {
      try {
        const resp = await api<{ query: string; results: WebSearchResultItem[]; sourcesUsed: string[] }>('/api/search', {
          method: 'POST',
          body: { query: args.query, limit: args.limit },
        });
        const results = Array.isArray(resp.results) ? resp.results : [];
        if (results.length === 0) {
          return { ok: false, query: args.query, results: [], message: '未搜到结果，可换更具体的关键词重试。' };
        }
        return { ok: true, query: resp.query ?? args.query, results };
      } catch (e) {
        return { ok: false, query: args.query, results: [], message: `搜索失败：${(e as ApiError).message || String(e)}` };
      }
    },
  });

  const listDraftFilesTool = tool({
    description:
      '列出当前草稿的全部文件路径（文件树）。修改现有插件前先调它了解结构，再决定读哪个文件，' +
      '避免盲目整包重发。返回 { ok, files:[路径], message }。无草稿时 ok=false。',
    inputSchema: zodSchema(z.object({})),
    execute: async (): Promise<{ ok: boolean; files: string[]; message?: string }> => {
      const d = opts.getDraft();
      if (!d) return { ok: false, files: [], message: '当前还没有草稿，先用 stage_plugin 生成或让用户导入。' };
      return { ok: true, files: d.files.map((f) => f.path) };
    },
  });

  const readDraftFileTool = tool({
    description:
      '读取当前草稿某个文件的完整内容。配合 list_draft_files 使用：先列结构、按需读单文件，' +
      '不必把所有文件塞进上下文。返回 { ok, path, content, message }。文件不存在时 ok=false。',
    inputSchema: zodSchema(readDraftParams),
    execute: async (args: ReadDraftArgs): Promise<{ ok: boolean; path: string; content?: string; message?: string }> => {
      const d = opts.getDraft();
      if (!d) return { ok: false, path: args.path, message: '当前还没有草稿。' };
      const file = d.files.find((f) => f.path === args.path);
      if (!file) return { ok: false, path: args.path, message: `文件 ${args.path} 不存在。可先调 list_draft_files 查看有哪些文件。` };
      return { ok: true, path: args.path, content: file.content };
    },
  });

  const patchDraftFileTool = tool({
    description:
      '新增或覆盖草稿里的单个文件（覆盖式写入完整内容，不是 diff）。做小改动时优先用它而非 stage_plugin 整包重发——' +
      '只改动目标文件，其余文件与用户已改的信息全部保留，省 token 且更精准。' +
      '改完前端会自动刷新预览。返回 { ok, message }。无草稿时 ok=false（需先 stage_plugin）。',
    inputSchema: zodSchema(patchDraftParams),
    execute: async (args: PatchDraftArgs): Promise<{ ok: boolean; message: string }> => {
      const d = opts.getDraft();
      if (!d) return { ok: false, message: '当前还没有草稿，无法 patch。请先用 stage_plugin 生成完整插件。' };
      if (!isSafePath(args.path)) return { ok: false, message: `文件路径非法：${args.path}（禁绝对路径/空段/../隐藏段）` };
      opts.onPatchDraft(args.path, args.content);
      return { ok: true, message: `已更新文件 ${args.path}，预览已刷新。` };
    },
  });

  const listTeamPluginsTool = tool({
    description:
      '列出当前团队已有的插件（精简信息：id/名字/描述/版本/运行类型）。' +
      '用于避免重复造轮子、参考已有命名风格、或用户问“团队有什么插件”时。返回 { ok, plugins, message }。',
    inputSchema: zodSchema(z.object({})),
    execute: async (): Promise<{ ok: boolean; plugins: TeamPluginBrief[]; message?: string }> => {
      try {
        const rows = await api<Array<{ id: string; name: string; description?: string; version?: string; runtime_type?: string }>>('/api/plugins/available');
        const plugins: TeamPluginBrief[] = (Array.isArray(rows) ? rows : []).map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? '',
          version: p.version ?? '',
          runtime_type: p.runtime_type ?? '',
        }));
        if (!plugins.length) return { ok: true, plugins: [], message: '团队暂无已有插件。' };
        return { ok: true, plugins };
      } catch (e) {
        return { ok: false, plugins: [], message: `查询团队插件失败：${(e as ApiError).message || String(e)}` };
      }
    },
  });

  const checkPluginTool = tool({
    description:
      '检查当前草稿是否可运行、可提交：manifest、入口文件、运行时必需文件、路径安全、LLM 能力声明与平台 LLM 使用方式。' +
      '生成或修改插件后必须调用。返回 { ok, issues, message }；ok=false 时应先修复再继续。',
    inputSchema: zodSchema(z.object({})),
    execute: async (): Promise<{ ok: boolean; issues: Array<{ level: 'error' | 'warning'; message: string }>; message: string }> => {
      const issues = scanPluginIssues(opts.getDraft());
      const blocking = issues.some((issue) => issue.level === 'error');
      return {
        ok: !blocking,
        issues,
        message: issues.length === 0 ? '检查通过。' : `检查发现 ${issues.length} 个问题，其中 ${issues.filter((i) => i.level === 'error').length} 个需要先修复。`,
      };
    },
  });

  const reviewPluginTool = tool({
    description:
      'Review 当前草稿的行为风险和发布质量，重点检查硬编码密钥、第三方 AI 直连、危险权限、运行时兼容与用户体验。' +
      '提交前必须调用。返回 { ok, findings, message }。',
    inputSchema: zodSchema(z.object({})),
    execute: async (): Promise<{ ok: boolean; findings: Array<{ severity: 'blocker' | 'warning' | 'info'; message: string }>; message: string }> => {
      const d = opts.getDraft();
      const issues = scanPluginIssues(d);
      const findings: Array<{ severity: 'blocker' | 'warning' | 'info'; message: string }> = issues.map((issue) => ({ severity: issue.level === 'error' ? 'blocker' : 'warning', message: issue.message }));
      if (d) {
        findings.push({ severity: 'info', message: `运行时：${d.runtime_type}；入口：${d.entry}；文件数：${d.files.length}` });
        if (d.capabilities.length === 0) findings.push({ severity: 'warning', message: '未声明任何能力，若插件要调用平台服务请补充能力声明。' });
      }
      const blockers = findings.filter((finding) => finding.severity === 'blocker').length;
      return {
        ok: blockers === 0,
        findings,
        message: blockers === 0 ? 'Review 通过，可继续预览或提交。' : `Review 发现 ${blockers} 个阻断问题，请先修复。`,
      };
    },
  });

  return {
    stage_plugin: stagePluginTool,
    ask_question: askQuestionTool,
    web_search: webSearchTool,
    check_plugin: checkPluginTool,
    review_plugin: reviewPluginTool,
    list_draft_files: listDraftFilesTool,
    read_draft_file: readDraftFileTool,
    patch_draft_file: patchDraftFileTool,
    list_team_plugins: listTeamPluginsTool,
  };
}
