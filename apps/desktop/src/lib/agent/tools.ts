// tools.ts —— OpenAI Agents SDK 工具集（Claude Code 风格命名，全部指向 plugins_root/{id}/）。
//
// 设计要点（task 06-26-agent-framework-rewrite）：
// - 单一真相源：工具直接读写应用插件目录 plugins_root/{id}/（Rust plugin_store 命令），
//   不再有 plugins-draft 内存/双轨。manifest.draft===true 标记未发布草稿。
// - Claude Code 命名：Read / Write / Edit / Glob 对齐 Claude Code 内置工具语义；
//   CreatePlugin / Check / WebSearch / AskQuestion / ListTeamPlugins 是领域工具，沿用 PascalCase。
// - read-before-edit 不变式：Edit 前必须先 Read 过该文件（per-run 的 readPaths 跟踪），否则报错，
//   迫使模型先看真实内容再改，避免盲目替换。
// - HITL：AskQuestion 通过 onAskQuestion 回调挂起（UI 收集答案），与 Agents SDK 的 run 循环协作。
import { tool } from '@openai/agents';
import { z } from 'zod';
import { api, type ApiError, tauriInvoke } from '@/lib/api';
import { runPluginScript, type ScriptFile, type ScriptRuntime } from '@/lib/plugin-script';
import { deletePluginFile, movePluginFile } from '@/lib/plugin-status';
import {
  validateStagedCompleteness,
  isSafePath,
  buildStagedManifest,
  type StagedPlugin,
} from '@/lib/plugin-creator/creator-tools';

/** AskQuestion 作答结果（回灌给模型）。 */
export interface AskQuestionResult {
  answer: string;
}

/** AskQuestion 入参（结构化提问，人在环）。 */
export interface AskQuestionArgs {
  question: string;
  options?: { label: string; value: string }[];
  allowFreeText: boolean;
  multiSelect: boolean;
}

/** Todo 项（与 Claude Code 的 TodoWrite 一致：内容 + 状态 + 优先级）。 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

/** 工具工厂入参：当前插件 id + HITL/刷新/Todo 回调。 */
export interface AgentToolsOptions {
  /** 当前正在开发的插件目录 id（plugins_root/{id}/）。CreatePlugin 后由调用方更新。 */
  getPluginId: () => string | null;
  /** CreatePlugin 初始化插件目录后回调（调用方记录 id、刷新预览）。 */
  onPluginCreated: (pluginId: string, draft: StagedPlugin) => void;
  /** 任意写操作（Write/Edit）后回调，调用方刷新右侧预览。 */
  onFilesChanged: () => void;
  /** AskQuestion 人在环：返回等待用户作答的 Promise。 */
  onAskQuestion: (args: AskQuestionArgs, toolCallId: string) => Promise<AskQuestionResult>;
  /** 返回上一轮保存的 todo 清单（跨轮延续，UI 持久化在 localStorage）。 */
  getTodos: () => TodoItem[];
  /** TodoWrite 变更后同步给 UI 持久化与渲染。 */
  onTodoUpdate: (todos: TodoItem[]) => void;
}

/** 团队插件精简条目（ListTeamPlugins 返回）。 */
interface TeamPluginBrief {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime_type: string;
}

// 文件内容 schema：宽松接收任意输入，在 execute 内归一化为字符串。
// 模型对大段源码（含大量引号/反斜杠）有时会传成对象/嵌套结构/畸形值，
// 严格 union 校验会直接抛 InvalidToolInputError（与 WebSearch.limit 同类根因），
// 故用 unknown + 手动归一化兜底，永不因入参形状失败。
const fileContentSchema = z.unknown().describe('文件完整内容（字符串）；复杂多行源码也可用字符串数组逐行传入。');

/**
 * 把模型传入的文件内容归一化为字符串。
 * 兜底所有畸形输入：数组→逐行 join、对象→取 content/text/value/body 字段、其它→String()。
 * 目的是不让 content 形状触发 zod/JSON 解析失败（InvalidToolInputError）。
 * 导出供单测验证容错语义（与 withRetryFetch 同样导出）。
 */
export function normalizeToolFileContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((line) => String(line)).join('\n');
  if (content != null && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    const picked = obj.content ?? obj.text ?? obj.value ?? obj.body ?? obj.code;
    if (typeof picked === 'string') return picked;
    if (Array.isArray(picked)) return picked.map((line) => String(line)).join('\n');
    try { return JSON.stringify(content, null, 2); } catch { return String(content); }
  }
  return content == null ? '' : String(content);
}

/**
 * 构造 Agents SDK 工具集。读写全部落到 plugins_root/{id}/（Rust 命令），唯一真相源。
 * readPaths 跟踪本 run 内已 Read 的文件，强制 Edit 前先 Read（read-before-edit 不变式）。
 */
export function createAgentTools(opts: AgentToolsOptions) {
  // read-before-edit 跟踪：本次 agent run 内已 Read 过的文件路径。Edit 前校验。
  const readPaths = new Set<string>();

  function requirePluginId(): string {
    const id = opts.getPluginId();
    if (!id) {
      throw new Error('当前还没有插件。请先用 CreatePlugin 创建插件目录，再读写文件。');
    }
    return id;
  }

  const Read = tool({
    name: 'Read',
    description:
      '读取当前插件目录下某个文件的完整内容。修改文件前必须先 Read（read-before-edit）。' +
      '返回文件文本内容；文件不存在时返回错误。',
    parameters: z.object({
      path: z.string().describe('相对插件目录的文件路径，如 ui/index.html / main.py'),
    }),
    async execute({ path }): Promise<string> {
      const pluginId = requirePluginId();
      if (!isSafePath(path)) return `错误：非法文件路径 ${path}（禁绝对路径/空段/../隐藏段）`;
      try {
        const content = await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: path });
        readPaths.add(path);
        return content;
      } catch (e) {
        return `读取失败：${e instanceof Error ? e.message : String(e)}。可先用 Glob 查看有哪些文件。`;
      }
    },
  });

  const Write = tool({
    name: 'Write',
    description:
      '创建或覆盖当前插件目录下的单个文件（写入完整内容，不是 diff）。' +
      '新建文件用 Write；修改已有文件优先用 Edit（更精准）。写入后预览自动刷新。',
    parameters: z.object({
      path: z.string().describe('相对插件目录的文件路径'),
      content: fileContentSchema,
    }),
    async execute({ path, content }): Promise<string> {
      const pluginId = requirePluginId();
      if (!isSafePath(path)) return `错误：非法文件路径 ${path}（禁绝对路径/空段/../隐藏段）`;
      try {
        await tauriInvoke<void>('write_plugin_file', { pluginId, path, content: normalizeToolFileContent(content) });
        readPaths.add(path); // 写过即视为已知内容，后续可直接 Edit
        opts.onFilesChanged();
        return `已写入 ${path}。`;
      } catch (e) {
        return `写入失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const Edit = tool({
    name: 'Edit',
    description:
      '对当前插件目录下的已有文件做字符串替换。必须先 Read 过该文件才能 Edit（read-before-edit）。' +
      'old_string 必须在文件中唯一匹配；replace_all=true 时替换全部匹配。',
    parameters: z.object({
      path: z.string().describe('相对插件目录的文件路径'),
      old_string: z.string().describe('要替换的原文（需在文件中唯一，除非 replace_all）'),
      new_string: z.string().describe('替换后的新文本'),
      replace_all: z.boolean().default(false).describe('是否替换所有匹配'),
    }),
    async execute({ path, old_string, new_string, replace_all }): Promise<string> {
      const pluginId = requirePluginId();
      if (!isSafePath(path)) return `错误：非法文件路径 ${path}`;
      if (!readPaths.has(path)) {
        return `错误：必须先 Read(${path}) 再 Edit。请先读取文件看到真实内容。`;
      }
      let content: string;
      try {
        content = await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: path });
      } catch (e) {
        return `读取失败：${e instanceof Error ? e.message : String(e)}`;
      }
      if (old_string === new_string) return '错误：old_string 与 new_string 相同，无需修改。';
      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) return `错误：在 ${path} 中找不到 old_string，无法替换。请先 Read 确认原文。`;
      if (occurrences > 1 && !replace_all) {
        return `错误：old_string 在 ${path} 中出现 ${occurrences} 次（不唯一）。请提供更长的上下文，或设 replace_all=true。`;
      }
      const next = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
      try {
        await tauriInvoke<void>('write_plugin_file', { pluginId, path, content: next });
        opts.onFilesChanged();
        return `已编辑 ${path}（替换 ${replace_all ? occurrences : 1} 处）。`;
      } catch (e) {
        return `写入失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const Glob = tool({
    name: 'Glob',
    description:
      '列出当前插件目录下的全部源文件路径（文件树）。修改前先 Glob 了解结构，再 Read 具体文件。' +
      '跳过 data/.venv/node_modules 等运行时目录。',
    parameters: z.object({}),
    async execute(): Promise<string> {
      const pluginId = requirePluginId();
      try {
        const files = await tauriInvoke<string[]>('list_plugin_files', { pluginId });
        if (!files.length) return '插件目录为空。';
        return files.join('\n');
      } catch (e) {
        return `列文件失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const CreatePlugin = tool({
    name: 'CreatePlugin',
    description:
      '初始化一个新插件目录（写入 manifest.json，标记 draft:true）并落盘全部初始文件到应用插件目录。' +
      '首次生成插件时调用；后续修改用 Read/Write/Edit。' +
      '约束：entry 必须存在于 files；client→ui/index.html、nodejs→index.js(+package.json)、python→main.py(+requirements.txt)。',
    parameters: z.object({
      id: z.string().regex(/^[a-z0-9-]+$/, 'id 仅小写字母/数字/连字符'),
      name: z.string(),
      version: z.string().default('0.1.0'),
      description: z.string().default(''),
      runtime_type: z.enum(['client', 'nodejs', 'python']),
      entry: z.string(),
      capabilities: z
        .array(
          z.object({
            kind: z.string(),
            reason: z.string().default(''),
            risk: z.enum(['none', 'low', 'medium', 'high']).default('low'),
            requires_admin: z.boolean().default(false),
          }),
        )
        .nullable()
        .optional()
        .describe('插件能力声明；调用平台 LLM 时必须含 llm.chat'),
      files: z.array(z.object({ path: z.string(), content: fileContentSchema })).min(1),
    }),
    async execute(args): Promise<string> {
      const draftFiles = args.files.map((file) => ({
        path: file.path,
        content: normalizeToolFileContent(file.content),
      }));
      const capabilities = (args.capabilities?.length
        ? args.capabilities
        : [{ kind: 'ui.view', reason: '展示插件界面', risk: 'low' as const, requires_admin: false }]) as StagedPlugin['capabilities'];
      const draft: StagedPlugin = {
        id: args.id,
        name: args.name,
        version: args.version,
        description: args.description,
        runtime_type: args.runtime_type,
        entry: args.entry,
        visibility: 'tenant',
        capabilities,
        files: draftFiles,
      };
      const err = validateStagedCompleteness(draft.runtime_type, draft.entry, draft.files);
      if (err) return `错误：${err}`;
      // manifest.json（含 draft:true）+ 全部源文件落盘到 plugins_root/{id}/。
      const manifestContent = `${JSON.stringify({ ...buildStagedManifest(draft), draft: true }, null, 2)}\n`;
      const files = [
        { path: 'manifest.json', content: manifestContent },
        ...draft.files.filter((f) => f.path !== 'manifest.json'),
      ];
      try {
        await tauriInvoke<void>('write_plugin_files', { pluginId: args.id, files });
        // 标记 draft（双保险：即使 manifest 文本拼接失败，也确保 draft 标记落地）。
        await tauriInvoke<void>('set_plugin_draft_flag', { pluginId: args.id, draft: true });
        draft.files.forEach((f) => readPaths.add(f.path));
        readPaths.add('manifest.json');
        opts.onPluginCreated(args.id, draft);
        return `已创建插件「${args.name}」(${args.id})，落盘到本地插件目录，可在草稿页运行。`;
      } catch (e) {
        return `创建失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const Check = tool({
    name: 'Check',
    description:
      '校验当前插件的完整性（入口/必需文件/路径合法/能力声明）。生成或修改后调用，按返回问题修复。',
    parameters: z.object({}),
    async execute(): Promise<string> {
      const pluginId = requirePluginId();
      let files: string[];
      try {
        files = await tauriInvoke<string[]>('list_plugin_files', { pluginId });
      } catch (e) {
        return `读取插件失败：${e instanceof Error ? e.message : String(e)}`;
      }
      let manifestRaw = '';
      try {
        manifestRaw = await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: 'manifest.json' });
      } catch {
        return '错误：缺少 manifest.json。';
      }
      let manifest: { runtime_type?: string; entry?: string; capabilities?: Array<{ kind?: string }> };
      try {
        manifest = JSON.parse(manifestRaw);
      } catch {
        return '错误：manifest.json 解析失败（JSON 非法）。';
      }
      const runtime = (manifest.runtime_type ?? 'client') as 'client' | 'nodejs' | 'python';
      const entry = manifest.entry ?? '';
      const draftFiles = files.map((p) => ({ path: p, content: '' }));
      const err = validateStagedCompleteness(runtime, entry, draftFiles);
      if (err) return `发现问题：${err}`;
      // 语法校验：读回所有源码文件，做括号配对 + 常见错误模式检查。
      // 这是质量兜底——AI 可能写出语法错误代码（如 os.path.xxx 无效属性、括号不配对），
      // Check 必须抓出来让模型自我修复，而不是"校验通过"放行跑不起来的插件。
      // 同时收集 codeFiles 的 content，供后续能力声明检测复用（避免二次读取）。
      const syntaxIssues: string[] = [];
      const codeFileList: { path: string; content: string }[] = [];
      const codeFiles = files.filter((p) => /\.(py|js|ts|html)$/i.test(p));
      for (const filePath of codeFiles) {
        let content = '';
        try {
          content = await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: filePath });
        } catch {
          continue;
        }
        codeFileList.push({ path: filePath, content });
        // 语法校验只对 py/js/ts（HTML 无括号配对语义）。
        if (/\.(py|js|ts)$/i.test(filePath)) {
          const issue = checkCodeSyntax(filePath, content);
          if (issue) syntaxIssues.push(issue);
        }
      }
      if (syntaxIssues.length) {
        return `错误：发现 ${syntaxIssues.length} 个语法问题，必须修复后再交付：\n${syntaxIssues.join('\n')}`;
      }
      // 能力声明检测：扫描代码推断实际用到的能力，对比 manifest 声明，找出缺漏。
      // 缺漏的能力运行时会被 capability 网关拒绝（如用了网络请求但没声明 net.fetch），
      // Check 必须抓出来提示 AI 补充，让能力声明与代码实际一致。
      const declaredKinds = (manifest.capabilities ?? []).map((c) => c.kind).filter((k): k is string => Boolean(k));
      const capResult = detectCapabilities(codeFileList, declaredKinds);
      if (capResult.missing.length) {
        const hints = capResult.missing.map((k) => {
          const rule = [
            { kind: 'llm.chat', fix: '调用平台 LLM 须声明 llm.chat（capabilities 加 {kind:"llm.chat"}）' },
            { kind: 'image.generate', fix: '调用平台生图须声明 image.generate' },
            { kind: 'net.fetch', fix: '发起网络请求须声明 net.fetch' },
            { kind: 'fs.read', fix: '读取文件须声明 fs.read' },
            { kind: 'fs.write', fix: '写入文件须声明 fs.write' },
            { kind: 'clipboard', fix: '访问剪贴板须声明 clipboard' },
            { kind: 'storage.kv', fix: '使用本地存储须声明 storage.kv' },
            { kind: 'system.notify', fix: '发送系统通知须声明 system.notify' },
          ].find((r) => r.kind === k);
          return `- ${k}：${rule?.fix ?? '代码用到了但未声明'}`;
        }).join('\n');
        return `发现问题：代码用到了以下能力但 manifest 未声明（运行时会被拒绝）：\n${hints}\n请用 CreatePlugin 或编辑 manifest.json 补充这些 capabilities 后重新 Check。`;
      }
      return '校验通过：入口与必需文件齐备，路径合法，代码语法检查无问题，能力声明与代码实际一致。';
    },
  });

  const WebSearch = tool({
    name: 'WebSearch',
    description:
      '联网搜索：需要最新信息、查 API/库用法、了解第三方服务或核实事实时调用。无需配置。' +
      '返回若干结果（标题/链接/摘要）。澄清需求请用 AskQuestion，不要用本工具替代。',
    parameters: z.object({
      query: z.string().min(1).describe('搜索关键词，尽量具体'),
      // limit 故意不在这里做强校验：不同模型/中转会发数字、字符串、null、空串甚至非法值，
      // zod 严格校验任一不合法都触发 InvalidToolInputError（用户反馈的 WebSearch 失败根因）。
      // 改为「宽松接收（含 null）+ execute 内手动归一化」，任何值都回落默认值，绝不报错。
      limit: z.union([z.number(), z.string(), z.null()]).optional().describe('期望结果条数，默认 8'),
    }),
    async execute({ query, limit }): Promise<string> {
      // 归一化 limit：接受 number/string，非法/越界一律回落默认 8，永不抛错。
      const parsedLimit = (() => {
        const n = typeof limit === 'string' ? Number(limit) : typeof limit === 'number' ? limit : NaN;
        if (!Number.isFinite(n)) return 8;
        return Math.min(20, Math.max(1, Math.trunc(n)));
      })();
      try {
        const resp = await api<{
          query: string;
          results: Array<{ title: string; url: string; snippet: string; source: string }>;
          // 后端诊断位：所有源都失败（fetch 失败/被墙）时为 true，与「真无结果」区分。
          allSourcesFailed?: boolean;
          sourcesSkipped?: Array<{ source: string; reason: string }>;
        }>(
          '/api/search',
          { method: 'POST', body: { query, limit: parsedLimit } },
        );
        const results = Array.isArray(resp.results) ? resp.results : [];
        // 全源故障：以「错误：」前缀返回，触发 adapter 的 error 判定让工具卡片标红，
        // 并把跳过的源摘要透出，便于用户/管理员定位（是网络/上游问题，而非真的无结果）。
        if (results.length === 0 && resp.allSourcesFailed) {
          const skipped = Array.isArray(resp.sourcesSkipped) ? resp.sourcesSkipped : [];
          const detail = skipped.length
            ? `（不可达源：${skipped.slice(0, 4).map((s) => s.source).join('、')}）`
            : '';
          return `错误：所有搜索源当前不可达，稍后重试或联系管理员配置搜索源。${detail}`;
        }
        if (!results.length) return '未搜到结果，可换更具体的关键词重试。';
        return results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join('\n\n');
      } catch (e) {
        return `错误：搜索失败：${(e as ApiError).message || String(e)}`;
      }
    },
  });

  const ListTeamPlugins = tool({
    name: 'ListTeamPlugins',
    description:
      '列出当前团队已有插件（id/名字/描述/版本/运行类型）。用于避免重复造轮子、参考命名，或用户询问团队插件时。',
    parameters: z.object({}),
    async execute(): Promise<string> {
      try {
        const rows = await api<Array<{ id: string; name: string; description?: string; version?: string; runtime_type?: string }>>(
          '/api/plugins/available',
        );
        const plugins: TeamPluginBrief[] = (Array.isArray(rows) ? rows : []).map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? '',
          version: p.version ?? '',
          runtime_type: p.runtime_type ?? '',
        }));
        if (!plugins.length) return '团队暂无已有插件。';
        return plugins.map((p) => `- ${p.name} (${p.id}) v${p.version} [${p.runtime_type}] ${p.description}`).join('\n');
      } catch (e) {
        return `查询失败：${(e as ApiError).message || String(e)}`;
      }
    },
  });

  const AskQuestion = tool({
    name: 'AskQuestion',
    description:
      '信息不足、需求有歧义、或需用户在多方案间选择时，发起结构化提问（不要用纯文本提问）。' +
      '能给 options 就给，减少用户打字。返回用户的回答。',
    parameters: z.object({
      question: z.string().describe('要澄清的问题，一句话'),
      options: z
        .array(z.object({ label: z.string(), value: z.string() }))
        .optional()
        .describe('可选预设选项；省略则只让用户自由输入'),
      allowFreeText: z.boolean().default(true),
      multiSelect: z.boolean().default(false),
    }),
    async execute(args, runContext): Promise<string> {
      // toolCallId 用于 UI 关联提问卡片与挂起的 deferred。Agents SDK 在 runContext 暴露调用上下文。
      const toolCallId = (runContext as { toolCall?: { id?: string } })?.toolCall?.id ?? `ask-${Date.now()}`;
      const res = await opts.onAskQuestion(
        {
          question: args.question,
          options: args.options,
          allowFreeText: args.allowFreeText,
          multiSelect: args.multiSelect,
        },
        toolCallId,
      );
      return res.answer;
    },
  });

  // Todo 列表：本 agent run 内的可变副本。run 开始时从 opts.getTodos() 读上一轮状态，
  // 工具调用替换后调 opts.onTodoUpdate 同步给 UI 持久化（localStorage）。跨轮延续。
  const todos: TodoItem[] = (opts.getTodos() ?? []).map((t) => ({ ...t }));

  const TodoWrite = tool({
    name: 'TodoWrite',
    description:
      '更新任务清单（用于复杂多步任务的进度跟踪）。传入完整清单替换当前状态；' +
      '每完成一步就把对应项置 completed 并开始下一项。简单单步任务不必用。',
    parameters: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().describe('该步要做什么，一句话'),
            status: z.enum(['pending', 'in_progress', 'completed']),
            priority: z.enum(['high', 'medium', 'low']),
          }),
        )
        .describe('完整任务清单（覆盖式替换）；同一时间至多一项 in_progress'),
    }),
    async execute(args): Promise<string> {
      const next = args.todos ?? [];
      // 校验：至多一项 in_progress（约束模型聚焦当前步骤，避免并行「进行中」混乱）。
      const inProgress = next.filter((t) => t.status === 'in_progress').length;
      if (inProgress > 1) {
        return '错误：清单中同时进行中的任务超过 1 项。请把其余 in_progress 改回 pending 或 completed 后重试。';
      }
      // 覆盖式替换内部副本并同步 UI（持久化 + 渲染）。
      todos.length = 0;
      todos.push(...next.map((t) => ({ ...t })));
      opts.onTodoUpdate(todos.map((t) => ({ ...t })));
      if (todos.length === 0) return '已清空任务清单。';
      const done = todos.filter((t) => t.status === 'completed').length;
      const current = todos.find((t) => t.status === 'in_progress');
      const summary = current ? `（当前：${current.content}）` : '';
      const lines = todos.map((t, i) => {
        const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
        const tag = `[${t.priority}]`;
        return `${i + 1}. [${mark}] ${tag} ${t.content}`;
      });
      return `已更新任务清单（${done}/${todos.length} 完成）${summary}：\n${lines.join('\n')}`;
    },
  });

  const DateTime = tool({
    name: 'DateTime',
    description:
      '获取当前的真实日期和时间。当用户提到「今天」「现在」「本周」「最近」等相对时间词、' +
      '或需要把日期放进搜索查询（如「今日新闻」「2026年XX月XX日」）时，先调用本工具拿到准确日期，' +
      '避免用训练数据里的旧日期。',
    parameters: z.object({}).describe('无参数；直接返回当前日期时间'),
    async execute(): Promise<string> {
      const now = new Date();
      const date = now.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
      });
      const time = now.toLocaleTimeString('zh-CN', { hour12: false });
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const iso = now.toISOString().slice(0, 10);
      return `当前时间：${date} ${time}（时区 ${tz}）\nISO 日期：${iso}`;
    },
  });

  /**
   * WebFetch —— 抓取网页正文。
   *
   * 为什么需要它：WebSearch 只返回搜索片段（snippet），拿不到网页正文。但很多问题的答案在
   * 正文里（如「今日新闻头条」的内容、「某文档的 API 用法」、「教程的具体步骤」）。
   * 典型用法：WebSearch 找到相关链接 → WebFetch 抓取该链接的正文。
   *
   * 实现：走后端 /api/search/fetch（后端调 Jina Reader 做正文抽取 + markdown 化）。
   * 为什么不前端直连 Jina：客户端（尤其大陆网络）直连 r.jina.ai 被墙不可达，
   * 但后端服务器可达。与 WebSearch 同一出口模式（前端 → 后端 → 上游）。
   */
  const WebFetch = tool({
    name: 'WebFetch',
    description:
      '抓取指定 URL 网页的正文内容（自动抽取正文 + 转 markdown，去噪）。' +
      'WebSearch 只返回摘要；要网页正文细节（新闻全文、文档原文、教程步骤）时，' +
      '先用 WebSearch 找到链接，再用本工具抓正文。一次只抓一个 URL。',
    parameters: z.object({
      url: z.string().url().describe('要抓取的网页 URL（必须是完整 http(s):// 链接）'),
      // maxLength 容错（与 WebSearch limit 同模式）：部分模型会把数字序列化成字符串/null。
      maxLength: z.union([z.number(), z.string(), z.null()]).optional().describe('正文最大字符数，默认 6000'),
    }),
    async execute({ url, maxLength }): Promise<string> {
      // 归一化 maxLength：非法值回落默认 6000，clamp 到 [500, 20000]。
      const limit = (() => {
        const n = typeof maxLength === 'string' ? Number(maxLength) : typeof maxLength === 'number' ? maxLength : NaN;
        if (!Number.isFinite(n)) return 6_000;
        return Math.min(20_000, Math.max(500, Math.trunc(n)));
      })();
      try {
        const resp = await api<{
          url: string;
          content: string;
          truncated: boolean;
          fetchedVia: 'jina' | 'direct' | 'fail';
          error?: string;
        }>('/api/search/fetch', { method: 'POST', body: { url, maxLength: limit }, timeoutMs: 45_000 });
        if (resp.fetchedVia === 'fail' || !resp.content) {
          return `错误：抓取失败${resp.error ? `：${resp.error}` : '（网页不可达或为 JS 渲染页）'}。`;
        }
        const note = resp.truncated ? `\n\n（正文超过 ${limit} 字符，已截断；如需更多可加大 maxLength）` : '';
        // fetchedVia=direct 表示用了降级抓取（质量较低），标注一下便于模型判断可信度。
        const viaNote = resp.fetchedVia === 'direct' ? '（降级抓取，正文可能含噪音）' : '';
        return `URL: ${url}${viaNote}\n\n${resp.content}${note}`;
      } catch (e) {
        // 网络错误 / 超时 → 错误前缀触发工具卡片标红。
        const msg = (e as Error)?.message || String(e);
        return `错误：抓取失败：${msg}`;
      }
    },
  });

  /**
   * RunPlugin —— 试运行当前插件（nodejs/python）并返回 stdout/stderr。
   *
   * 闭环关键（对齐 Claude Code/Cline 的「写→跑→看报错→自修」）：
   * - 生成或修改代码后调用，验证能否真正跑起来（而非仅靠 Check 的括号配对粗校验）。
   * - 失败时返回真实 stderr（Python 的 Traceback、Node 的堆栈），据此修复后重试。
   * - 复用 Rust 已实现的 run_plugin_script（沙箱 + 15s 超时 + UTF-8 + LLM 桥），接线即可。
   *
   * 限制：
   * - 仅 nodejs/python 运行时可试跑；client（HTML）需在插件页用「运行」按钮预览（iframe 沙箱）。
   * - nodejs 若声明 package.json + scripts.start（如 electron），需专属运行时，预览拦截并提示。
   */
  const RunPlugin = tool({
    name: 'RunPlugin',
    description:
      '试运行当前插件（nodejs/python）并返回控制台输出（stdout/stderr）。' +
      '生成或修改代码后必须调用验证能否跑起来；若有报错，读取 stderr 信息修复后重试，直到正常运行。' +
      'client(HTML) 插件不支持试跑（请在插件页用运行按钮预览）。',
    parameters: z.object({
      entry: z.string().optional().describe('可选：指定入口文件（缺省用 manifest.entry）'),
    }),
    async execute({ entry }): Promise<string> {
      const pluginId = requirePluginId();
      // 收集插件当前全部文件（磁盘上的最新内容）。
      let files: string[];
      try {
        files = await tauriInvoke<string[]>('list_plugin_files', { pluginId });
        if (!files.length) return '错误：插件目录为空，没有可运行的文件。';
      } catch (e) {
        return `错误：列文件失败：${e instanceof Error ? e.message : String(e)}`;
      }
      // 读 manifest 拿 runtime_type + entry。
      let manifestRaw = '';
      try {
        manifestRaw = await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: 'manifest.json' });
      } catch {
        return '错误：缺少 manifest.json，无法确定运行时类型和入口。';
      }
      let manifest: { runtime_type?: string; entry?: string };
      try {
        manifest = JSON.parse(manifestRaw);
      } catch {
        return '错误：manifest.json 解析失败（JSON 非法）。';
      }
      const runtimeRaw = (manifest.runtime_type ?? 'client') as string;
      // 仅 nodejs/python 可试跑；client/cloud 给出明确指引。
      if (runtimeRaw !== 'nodejs' && runtimeRaw !== 'python') {
        return `当前插件运行时为 ${runtimeRaw}，不支持试跑。client(HTML) 插件请在「插件」页用「运行」按钮预览。`;
      }
      const runtime = runtimeRaw as ScriptRuntime;
      const entryPath = entry?.trim() || manifest.entry || '';
      if (!entryPath) return '错误：manifest 未声明 entry，且未传入 entry 参数。';
      // 组装 ScriptFile[]（逐文件读回内容）。
      const scriptFiles: ScriptFile[] = [];
      for (const p of files) {
        try {
          const content = await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: p });
          scriptFiles.push({ path: p, content });
        } catch (e) {
          return `错误：读取 ${p} 失败：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      // 调 Rust run_plugin_script（沙箱一次性执行 + 捕获输出）。
      const result = await runPluginScript({
        pluginId,
        runtime,
        entry: entryPath,
        files: scriptFiles,
        capabilities: [], // 试跑不注入 LLM 桥能力（纯验证代码能否跑）
      });
      // 格式化为 AI 可读文本。
      const trim = (s: string, max: number) => s.length > max ? s.slice(0, max) + `\n…(已截断，共 ${s.length} 字符)` : s;
      // 依赖安装日志前缀（若有）：让 AI 知道装了什么/是否成功，便于判断依赖问题。
      const installNote = result.installLog ? `[依赖] ${result.installLog}\n` : '';
      if (result.ok && !result.failure) {
        const out = result.stdout?.trim() || '(无输出)';
        return `${installNote}✅ 运行成功（退出码 0，耗时 ${result.elapsedMs ?? '?'}ms）\n输出：\n${trim(out, 2000)}`;
      }
      if (result.failure === 'interpreter_missing') {
        return `${installNote}错误：运行时缺失。${result.stderr || ''}`;
      }
      if (result.failure === 'timeout') {
        return `${installNote}错误：运行超时（15s）。部分输出：\nstdout: ${trim(result.stdout || '', 1000)}\nstderr: ${trim(result.stderr || '', 1000)}`;
      }
      // nonzero_exit / spawn_failed（含装依赖失败）：返回 stderr 供模型定位修复。
      const exitInfo = result.exitCode != null ? `（退出码 ${result.exitCode}）` : '';
      return `${installNote}❌ 运行失败${exitInfo}：\nstderr:\n${trim(result.stderr || '(无 stderr)', 2000)}${result.stdout?.trim() ? `\n\nstdout:\n${trim(result.stdout, 1000)}` : ''}`;
    },
  });

  /**
   * DeleteFile —— 删除当前插件目录下的单个文件。
   *
   * 重构/清理场景：移除废弃文件、删掉旧版实现、清理临时文件。
   * 此前只能覆盖（Write 空内容）不能真删，导致重构后多余文件残留。
   * 复用 Rust delete_plugin_file（canonicalize 前缀断言防穿越，与 Read 同款安全）。
   */
  const DeleteFile = tool({
    name: 'DeleteFile',
    description:
      '删除当前插件目录下的单个文件。重构或清理时移除不再需要的文件（如旧实现、临时文件、废弃模块）。' +
      '删除目录请改用删除整个插件重建。删除是不可逆操作，确认文件确实不需要再调用。',
    parameters: z.object({
      path: z.string().describe('相对插件目录的文件路径，如 old-impl.py / utils/deprecated.js'),
    }),
    async execute({ path }): Promise<string> {
      const pluginId = requirePluginId();
      if (!isSafePath(path)) return `错误：非法文件路径 ${path}（禁绝对路径/空段/../隐藏段）`;
      try {
        await deletePluginFile(pluginId, path);
        readPaths.delete(path); // 清理 read-before-edit 跟踪（文件已不存在）
        return `已删除 ${path}。`;
      } catch (e) {
        return `删除失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  /**
   * MoveFile —— 移动或重命名当前插件目录下的文件。
   *
   * 重构场景：调整目录结构、重命名文件、把代码从单文件拆分到子目录。
   * 比「Read 旧文件 → Write 新路径 → Delete 旧文件」三步更高效（原子 rename）。
   * 复用 Rust move_plugin_file（段级路径校验防穿越 + 目标自动建子目录）。
   */
  const MoveFile = tool({
    name: 'MoveFile',
    description:
      '移动或重命名当前插件目录下的文件。重构时调整文件位置/名字（如把 main.py 移到 src/main.py）。' +
      '比「Read→Write新路径→删旧文件」更高效；目标已存在会覆盖；自动创建目标子目录。',
    parameters: z.object({
      from: z.string().describe('源文件路径（相对插件目录，须已存在）'),
      to: z.string().describe('目标路径（相对插件目录）'),
    }),
    async execute({ from, to }): Promise<string> {
      const pluginId = requirePluginId();
      if (!isSafePath(from)) return `错误：非法源路径 ${from}`;
      if (!isSafePath(to)) return `错误：非法目标路径 ${to}`;
      if (from === to) return '错误：源路径与目标路径相同，无需移动。';
      try {
        await movePluginFile(pluginId, from, to);
        // 更新 read-before-edit 跟踪：旧路径失效，新路径视为已知内容（已读）。
        readPaths.delete(from);
        readPaths.add(to);
        return `已移动 ${from} → ${to}。`;
      } catch (e) {
        return `移动失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  /**
   * Grep —— 在当前插件的所有源文件里搜索内容（正则匹配）。
   *
   * 重构/排查场景：找某个函数/类/变量在哪些文件被定义或引用，定位 import 关系、查找硬编码值。
   * Glob 只列文件名不搜内容；Read 只看单个文件；Grep 跨文件搜索，是代码理解的基础能力。
   * 实现纯前端：list_plugin_files + 逐文件 read + 正则匹配，避免新增 Rust 依赖。
   * 匹配结果格式：`path:line: 匹配行内容`（grep -rn 风格，模型熟悉）。
   */
  const Grep = tool({
    name: 'Grep',
    description:
      '在当前插件的所有源文件里搜索内容（支持正则）。用于查找函数/变量/字符串的定义与引用、' +
      '定位 import 关系、排查硬编码值。返回匹配的 文件:行号:内容 列表。区分大小写。',
    parameters: z.object({
      pattern: z.string().min(1).describe('搜索的正则表达式，如 \\bdef\\s+main\\b 或 onClick'),
      // glob 过滤同 Edit.replace_all：宽松接收，execute 内归一化。
      glob: z.union([z.string(), z.null()]).optional().describe('可选：只搜匹配的文件（如 *.py / *.js），缺省搜全部源文件'),
    }),
    async execute({ pattern, glob }): Promise<string> {
      const pluginId = requirePluginId();
      // 编译正则（非法正则回落为字面量匹配，避免工具整体失败）。
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'u');
      } catch {
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u');
      }
      // 收集要搜的文件。
      let files: string[];
      try {
        files = await tauriInvoke<string[]>('list_plugin_files', { pluginId });
      } catch (e) {
        return `列文件失败：${e instanceof Error ? e.message : String(e)}`;
      }
      // glob 过滤（简单后缀/通配匹配，如 *.py / ui/*）。
      const globStr = typeof glob === 'string' && glob.trim() ? glob.trim() : null;
      if (globStr) {
        const filterRe = new RegExp('^' + globStr.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'u');
        files = files.filter((f) => filterRe.test(f));
      }
      if (!files.length) return '没有匹配的文件可搜索。';
      // 逐文件读取 + 搜索（限制单文件最多返回 20 个匹配，避免超长输出）。
      const MAX_MATCHES_PER_FILE = 20;
      const MAX_TOTAL = 60;
      const results: string[] = [];
      let total = 0;
      for (const filePath of files) {
        if (total >= MAX_TOTAL) break;
        let content: string;
        try {
          content = await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: filePath });
        } catch {
          continue; // 二进制/读取失败跳过
        }
        const lines = content.split('\n');
        let fileMatches = 0;
        for (let i = 0; i < lines.length; i++) {
          if (fileMatches >= MAX_MATCHES_PER_FILE) {
            results.push(`${filePath}:(更多匹配已省略)`);
            break;
          }
          if (regex.test(lines[i])) {
            const snippet = lines[i].trim().slice(0, 200);
            results.push(`${filePath}:${i + 1}: ${snippet}`);
            fileMatches++;
            total++;
            if (total >= MAX_TOTAL) {
              results.push(`(结果已达上限 ${MAX_TOTAL}，如需更多请缩小范围或换关键词)`);
              break;
            }
          }
        }
      }
      if (!results.length) return `未找到匹配「${pattern}」的内容。`;
      return `找到 ${total} 处匹配：\n${results.join('\n')}`;
    },
  });

  return {
    tools: [Read, Write, Edit, Glob, CreatePlugin, Check, WebSearch, ListTeamPlugins, AskQuestion, TodoWrite, DateTime, WebFetch, RunPlugin, DeleteFile, MoveFile, Grep],
    /** 重置 read-before-edit 跟踪（每次新 run 开始时调用）。 */
    resetReadTracking() {
      readPaths.clear();
    },
  };
}

/**
 * 代码语法粗校验（纯前端，不依赖 Python/Node 运行时）。
 *
 * 检查项：
/**
 * 能力声明检测：扫描代码推断插件实际用到的能力，对比 manifest 声明，找出缺漏/多余。
 *
 * 解决问题：AI 创建插件时常漏声明能力（如用了网络请求却没声明 net.fetch），运行时被 capability
 * 网关拒绝。本函数在 Check 时扫描代码特征（import/函数调用），自动推断用到的能力并对比声明，
 * 缺漏时提示 AI 补充，让能力声明与代码实际一致。
 *
 * 检测规则（按代码特征匹配，宽松避免漏检）：
 *  - 调平台 LLM/生图：sdk.llm / sdk.image / LLM 桥 → llm.chat / image.generate
 *  - 网络请求：requests / fetch / urllib / http / aiohttp → net.fetch
 *  - 文件读写：open( / fs.readFile / fs.writeFile / pathlib → fs.read + fs.write
 *  - 剪贴板：clipboard / pyperclip → clipboard
 *  - 存储：localStorage / kv / sqlite → storage.kv
 *  - 系统通知：notify / notification / toast → system.notify
 *
 * 返回 { missing: 缺漏的能力, declared: 已声明的能力, detected: 检测到的能力 }。
 * missing 非空时 Check 应提示 AI 补充。
 */
export function detectCapabilities(
  codeFiles: { path: string; content: string }[],
  declaredKinds: string[],
): { missing: string[]; declared: string[]; detected: string[] } {
  // 代码特征 → 能力 kind 的映射（正则，宽松匹配 import/调用/标识符）。
  // 注意：ua.*（ui.view）默认所有有界面的插件都该有，不靠代码检测（HTML 插件必有界面）。
  const rules: Array<{ kind: string; pattern: RegExp; desc: string }> = [
    { kind: 'llm.chat', pattern: /sdk\.llm|llm\.chat|chat_completion|LLM_PLUGIN_BRIDGE|lingfang.*llm/i, desc: '调用了平台 LLM 能力' },
    { kind: 'image.generate', pattern: /sdk\.image|image\.generate|generate_image/i, desc: '调用了平台生图能力' },
    { kind: 'net.fetch', pattern: /\brequests\b|\bfetch\s*\(|urllib|aiohttp|http\.client|\bhttpx\b|axios/i, desc: '发起了网络请求' },
    { kind: 'fs.read', pattern: /\bopen\s*\(|read_file|readFile|pathlib|os\.path\.|os\.listdir/i, desc: '读取了文件' },
    { kind: 'fs.write', pattern: /open\s*\([^)]*['"][wa]|write_?file|\.write\s*\(|shutil\.(?:move|copy)/i, desc: '写入了文件' },
    { kind: 'clipboard', pattern: /clipboard|pyperclip/i, desc: '访问了剪贴板' },
    { kind: 'storage.kv', pattern: /localStorage|sessionStorage|sqlite|\.kv\b|key_value|keyvalue/i, desc: '使用了本地存储' },
    { kind: 'system.notify', pattern: /notification|notify\s*\(|toast|plyer\.notification/i, desc: '发送了系统通知' },
  ];
  const detected = new Set<string>();
  for (const { content } of codeFiles) {
    for (const { kind, pattern } of rules) {
      if (pattern.test(content)) detected.add(kind);
    }
  }
  const detectedArr = Array.from(detected);
  // 缺漏：检测到但没声明（运行时会被网关拒绝）。
  const missing = detectedArr.filter((k) => !declaredKinds.includes(k));
  return { missing, declared: declaredKinds, detected: detectedArr };
}

/**
 * 代码语法粗校验（纯前端，不依赖 Python/Node 运行时）。
 *
 * 检查项：
 *  - 括号配对：() [] {} 计数必须相等（不配对 = 几乎肯定语法错）。
 *  - 字符串/注释感知：跳过字符串和注释内的括号，避免误报。
 *  - 常见错误模式：os.path.xxx 无效属性、未闭合的字符串等。
 *
 * 不是精确语法分析（那需 py_compile），但能抓 AI 最常犯的粗错，
 * 阻止"语法错却 Check 通过"的情况。返回问题描述或 null（无问题）。
 */
function checkCodeSyntax(filePath: string, content: string): string | null {
  const issues: string[] = [];

  // 1. 字符串/注释感知的括号配对检查。
  //    逐字符扫描，跳过单引号/双引号字符串和注释（# ... for Python, // for JS）。
  const stack: Array<{ char: string; line: number }> = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  let i = 0;
  let line = 1;
  let inString: string | null = null; // ' or " or """
  let inComment = false;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1] ?? '';
    if (ch === '\n') { line++; inComment = false; i++; continue; }
    if (inComment) { i++; continue; }
    if (inString) {
      if (ch === '\\') { i += 2; continue; } // 转义字符跳过
      if (ch === inString) inString = null;
      i++; continue;
    }
    // 进入注释（Python # 或 JS //）
    if (ch === '#' || (ch === '/' && next === '/')) { inComment = true; i++; continue; }
    // 进入字符串
    if (ch === '"' || ch === "'") { inString = ch; i++; continue; }
    // 括号
    if (opens.has(ch)) { stack.push({ char: ch, line }); i++; continue; }
    if (ch in pairs) {
      if (stack.length === 0 || stack[stack.length - 1].char !== pairs[ch]) {
        issues.push(`${filePath} 第 ${line} 行：括号 "${ch}" 不配对（多余或顺序错误）`);
        // 不 break，继续找更多问题
      } else {
        stack.pop();
      }
      i++; continue;
    }
    i++;
  }
  if (stack.length > 0) {
    const last = stack[stack.length - 1];
    issues.push(`${filePath} 第 ${last.line} 行：括号 "${last.char}" 未闭合（缺少对应的右括号）`);
  }

  // 2. 常见 AI 错误模式：os.path.xxx 后面跟非法内容（如 os.path.ffmpeg）
  //    匹配 os.path. 后接非下划线/字母开头的标识符
  const invalidAttr = content.match(/os\.path\.([a-z][_a-z0-9]*)/gi);
  // 已知的合法 os.path 属性
  const validOsPath = new Set(['join', 'exists', 'isfile', 'isdir', 'dirname', 'basename', 'abspath', 'split', 'splitext', 'expanduser', 'normpath', 'realpath', 'relpath', 'getsize', 'getmtime', 'getatime', 'sep', 'altsep', 'linesep', 'curdir', 'pardir']);
  if (invalidAttr) {
    for (const m of invalidAttr) {
      const attr = m.split('.').pop()!.toLowerCase();
      if (!validOsPath.has(attr)) {
        issues.push(`${filePath}：疑似无效属性 "${m}"（os.path.${attr} 不是标准方法）`);
      }
    }
  }

  return issues.length ? issues.slice(0, 5).join('；') : null;
}
