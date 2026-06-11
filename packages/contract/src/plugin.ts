// 插件与能力契约（见 docs/02 §B）。
import { z } from 'zod';

export const RuntimeType = z.enum(['client', 'cloud']);
export type RuntimeType = z.infer<typeof RuntimeType>;

export const CapabilityKind = z.enum([
  'ui.view', 'fs.pick', 'fs.read', 'fs.write', 'net.fetch',
  'clipboard', 'llm.chat', 'storage.kv',
  'system.info', 'system.screenshot', 'system.notify',
]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

export const CapabilityRisk = z.enum(['none', 'low', 'medium', 'high']);
export type CapabilityRisk = z.infer<typeof CapabilityRisk>;

export const PluginCapability = z.object({
  kind: CapabilityKind,
  reason: z.string().default(''),
  risk: CapabilityRisk.default('low'),
  requires_admin: z.boolean().default(false),
  scope: z.record(z.unknown()).optional(),
});
export type PluginCapability = z.infer<typeof PluginCapability>;

// 插件清单（也是 AI 生成时必须产出的 manifest.json 结构）
export const PluginManifest = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  runtime_type: RuntimeType.default('client'),
  entry: z.string().min(1),
  visibility: z.enum(['private', 'tenant']).default('tenant'),
  capabilities: z.array(PluginCapability).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

// 已发布的插件（成品）
export const Plugin = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  author_tenant_id: z.string().min(1),
  runtime_type: RuntimeType,
  entry: z.string().min(1),
  capabilities: z.array(PluginCapability).default([]),
  visibility: z.enum(['private', 'tenant']).default('tenant'),
  status: z.enum(['listed', 'disabled']).default('listed'),
  created_at: z.string().datetime(),
});
export type Plugin = z.infer<typeof Plugin>;

export const PluginInstallation = z.object({
  tenant_id: z.string().min(1),
  plugin_id: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(['installed', 'disabled']).default('installed'),
  installed_by: z.string().min(1),
  installed_at: z.string().datetime(),
});
export type PluginInstallation = z.infer<typeof PluginInstallation>;

export const PluginGrant = z.object({
  tenant_id: z.string().min(1),
  plugin_id: z.string().min(1),
  subject_kind: z.enum(['user', 'role']),
  subject_id: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
});
export type PluginGrant = z.infer<typeof PluginGrant>;

/** 授权解析：deny 优先；user 级优先于 role 级；owner/admin 默认可用。 */
export function resolveGrant(
  grants: PluginGrant[],
  userId: string,
  role: string,
): boolean {
  const userGrants = grants.filter((g) => g.subject_kind === 'user' && g.subject_id === userId);
  if (userGrants.some((g) => g.effect === 'deny')) return false;
  if (userGrants.some((g) => g.effect === 'allow')) return true;
  const roleGrants = grants.filter((g) => g.subject_kind === 'role' && g.subject_id === role);
  if (roleGrants.some((g) => g.effect === 'deny')) return false;
  if (roleGrants.some((g) => g.effect === 'allow')) return true;
  return role === 'owner' || role === 'admin';
}
