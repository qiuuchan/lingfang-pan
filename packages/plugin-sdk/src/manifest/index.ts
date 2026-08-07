// manifest 校验入口：Zod schema + 业务规则双层校验。
// 导出 validateManifest 函数和 ManifestError / ManifestResult 类型。
// 同时透传 @lingfang/contract 的类型，让插件作者只需 import 这一个入口。
import { PluginManifest as PluginManifestSchema } from '@lingfang/contract';
import type { PluginManifest } from '@lingfang/contract';
import { RULES, type ManifestError } from './rules.ts';

export type { ManifestError } from './rules.ts';
export type {
  PluginManifest,
  PluginCapability,
  CapabilityKind,
  RuntimeType,
} from '@lingfang/contract';

export type ManifestResult =
  { success: true; manifest: PluginManifest } | { success: false; errors: ManifestError[] };

/**
 * 校验插件 manifest（任意 JSON 输入）。
 *
 * 1. Zod schema 校验（字段类型、必填、枚举约束）
 * 2. 业务规则校验（id 命名、version 合法性、entry 匹配等 7 条规则）
 *
 * 返回 ManifestResult：success=true 时 manifest 为解析后的 PluginManifest；
 * success=false 时 errors 包含所有违规（Zod + 业务规则合并）。
 */
export function validateManifest(input: unknown): ManifestResult {
  const parsed = PluginManifestSchema.safeParse(input);

  if (!parsed.success) {
    const errors: ManifestError[] = parsed.error.issues.map((issue) => ({
      code: 'schema_invalid',
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return { success: false, errors };
  }

  const manifest = parsed.data;

  // 逐条运行业务规则，收集所有错误
  const businessErrors: ManifestError[] = [];
  for (const rule of RULES) {
    const ruleErrors = rule(manifest);
    businessErrors.push(...ruleErrors);
  }

  if (businessErrors.length > 0) {
    return { success: false, errors: businessErrors };
  }

  return { success: true, manifest };
}
