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

const fileContentSchema = z.union([z.string(), z.array(z.string())]).describe('文件完整内容；复杂多行源码可用字符串数组逐行传入。');

function normalizeToolFileContent(content: string | string[]): string {
  return Array.isArray(content) ? content.join('\n') : content;
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
      let manifest: { runtime_type?: string; entry?: string };
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
      return '校验通过：入口与必需文件齐备，路径合法。';
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

  return {
    tools: [Read, Write, Edit, Glob, CreatePlugin, Check, WebSearch, ListTeamPlugins, AskQuestion, TodoWrite, DateTime, WebFetch],
    /** 重置 read-before-edit 跟踪（每次新 run 开始时调用）。 */
    resetReadTracking() {
      readPaths.clear();
    },
  };
}
