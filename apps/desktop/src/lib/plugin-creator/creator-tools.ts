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
            runtime_type: args.runtime_type, entry: args.entry, visibility: 'team',
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

/** 创建器工具集（供 streamText tools 用）。 */
export const creatorTools = { upload_plugin: uploadPluginTool };
