// 插件草稿契约——产品核心对象（见 docs/02 §A、docs/01 §10 生成数据流）。
import { z } from 'zod';

export const PluginDraftFile = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type PluginDraftFile = z.infer<typeof PluginDraftFile>;

export const PluginDraftTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: z.string().datetime(),
});
export type PluginDraftTurn = z.infer<typeof PluginDraftTurn>;

export const PluginDraftDiagnostic = z.object({
  stage: z.enum(['schema', 'security', 'preview']),
  status: z.enum(['pass', 'fail']),
  message: z.string(),
});
export type PluginDraftDiagnostic = z.infer<typeof PluginDraftDiagnostic>;

export const PluginDraftStatus = z.enum(['generating', 'ready', 'invalid', 'published']);
export type PluginDraftStatus = z.infer<typeof PluginDraftStatus>;

export const PluginDraft = z.object({
  id: z.string().min(1),
  tenant_id: z.string().min(1),
  created_by: z.string().min(1),
  title: z.string().default(''),
  source_prompt: z.string(),
  status: PluginDraftStatus.default('generating'),
  files: z.array(PluginDraftFile).default([]),
  turns: z.array(PluginDraftTurn).default([]),
  diagnostics: z.array(PluginDraftDiagnostic).default([]),
  updated_at: z.string().datetime(),
});
export type PluginDraft = z.infer<typeof PluginDraft>;

// —— 请求 ——
export const CreateDraftRequest = z.object({
  title: z.string().optional(),
  prompt: z.string().min(1), // 用户首次的自然语言描述
});
export type CreateDraftRequest = z.infer<typeof CreateDraftRequest>;

// 生成/迭代：再来一句描述
export const GenerateRequest = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;
