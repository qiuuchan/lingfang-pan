// creator-tools.ts —— 创建器 agent 的工具集（Vercel AI SDK tool 形态）。
//
// 模型生成插件后，自己调用 upload_plugin 工具完成上传（而非吐代码块让用户手动点）。
// 工具在渲染进程执行（经 /api/plugins/upload），结果回传给模型，形成 agent 闭环。
import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { api, type ApiError } from '@/lib/api';

const uploadParams = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id 仅小写字母/数字/连字符'),
  name: z.string(),
  version: z.string().default('0.1.0'),
  description: z.string().default(''),
  runtime_type: z.enum(['client', 'nodejs', 'python']),
  entry: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
});
type UploadArgs = z.infer<typeof uploadParams>;

/** upload_plugin：校验 + 上传插件到团队空间。模型确定 manifest + files 后调用。 */
export const uploadPluginTool = tool({
  description:
    '把生成的插件上传到团队空间。当插件的 manifest 与全部文件都齐备时调用此工具完成上传。' +
    '调用前请确保：entry 存在于 files；client→ui/index.html、nodejs→index.js(+package.json)、python→main.py(+requirements.txt)。' +
    '返回 { ok, message } 供你判断是否成功并告知用户。',
  inputSchema: zodSchema(uploadParams),
  execute: async (args: UploadArgs) => {
    const safe = (p: string) => p && !p.includes('\\') && !/^[\\/]/.test(p) && !p.split('/').some((s) => !s || s === '.' || s === '..');
    if (!args.files.every((f) => safe(f.path))) {
      return { ok: false as const, message: '文件路径非法（禁绝对路径/空段/../）' };
    }
    if (!args.files.some((f) => f.path === args.entry)) {
      return { ok: false as const, message: `入口文件 ${args.entry} 不在 files 中` };
    }
    try {
      await api('/api/plugins/upload', {
        method: 'POST',
        body: {
          manifest: {
            id: args.id, name: args.name, version: args.version, description: args.description,
            runtime_type: args.runtime_type, entry: args.entry, visibility: 'tenant',
            capabilities: [{ kind: 'ui.view', reason: '展示插件界面', risk: 'low' }],
          },
          files: args.files,
          priceCents: 0,
        },
      });
      return { ok: true as const, message: `插件「${args.name}」已上传到团队空间`, name: args.name };
    } catch (e) {
      return { ok: false as const, message: `上传失败：${(e as ApiError).message || String(e)}` };
    }
  },
});

/** 创建器工具集（仅 upload_plugin；向后兼容旧引用）。 */
export const creatorTools = { upload_plugin: uploadPluginTool };

// ── ask_question：人在环（human-in-the-loop）澄清提问工具 ──────────────────
//
// 信息不足/有歧义/需在多方案中选择时，模型调用此工具结构化提问，而非纯文本。
// 「执行结果」是用户的回答，无法在前端自动算出 → 采用 deferred-execute：
// execute 返回一个等待用户作答的 Promise（由 FloatingCreator 注入的 onAskQuestion 提供），
// 用户作答后 resolve，SDK 自动把 { answer } 回灌，同一个 streamText 多步循环继续。
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

/** ask_question 作答结果（回灌给模型）。 */
export interface AskQuestionResult {
  answer: string;
}

/**
 * 工厂：构造创建器工具集。ask_question 的 execute 调用注入的 onAskQuestion，
 * 由前端在用户作答后 resolve（人在环）。upload_plugin 维持静态定义。
 */
export function createCreatorTools(opts: {
  onAskQuestion: (args: AskQuestionArgs, toolCallId: string) => Promise<AskQuestionResult>;
}) {
  const askQuestionTool = tool({
    description:
      '当信息不足、需求有歧义、或需要用户在多个方案中选择时，调用此工具向用户发起结构化提问（不要用纯文本提问）。' +
      '能用预设 options 就给选项，减少用户打字。返回 { answer }：用户的回答，据此继续后续流程。',
    inputSchema: zodSchema(askQuestionParams),
    execute: (args: AskQuestionArgs, { toolCallId }): Promise<AskQuestionResult> =>
      opts.onAskQuestion(args, toolCallId),
  });
  return { upload_plugin: uploadPluginTool, ask_question: askQuestionTool };
}
