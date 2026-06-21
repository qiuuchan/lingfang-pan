// RBAC（角色 + 权限码 + 插件授权）契约（见 .trellis 权限系统完善任务）。
//
// 设计要点：
//  - 角色分两层 scope：PLATFORM（平台级，管平台资源，全局唯一）/ TEAM（团队级，归属某 team）。
//  - 权限码为代码注册表预定义（不可由用户自由新增），字符串形如 "team.member.invite"。
//  - 插件授权走独立表：团队管理员为团队内插件按 user/role 设置 allow/deny，deny 优先。
//  - 契约字段一律 camelCase（与 collab-api HTTP 响应 / Prisma 模型对齐，见 identity.ts CONTRACT-07）。
//
// 注意：identity.ts 中的 TenantRole（owner|admin|developer|member）为历史 dead schema，
// 实际角色以本文件 Role 模型为准；新代码不要引用 TenantRole。
import { z } from 'zod';

/** 角色 scope：PLATFORM 平台级（全局）/ TEAM 团队级（归属某 team）。 */
export const RoleScope = z.enum(['PLATFORM', 'TEAM']);
export type RoleScope = z.infer<typeof RoleScope>;

/** 插件授权主体类型：USER 指定用户 / ROLE 指定角色（对该角色下所有成员生效）。 */
export const PluginGrantSubject = z.enum(['USER', 'ROLE']);
export type PluginGrantSubject = z.infer<typeof PluginGrantSubject>;

/** 插件授权效果：ALLOW 放行 / DENY 拒绝（deny 优先，见 resolvePluginAccess）。 */
export const PluginGrantEffect = z.enum(['ALLOW', 'DENY']);
export type PluginGrantEffect = z.infer<typeof PluginGrantEffect>;

/** 权限码注册表镜像（HTTP 响应，供前端 admin 展示/分组勾选）。权限码本体由后端 permission-codes.ts 定义。 */
export const PermissionEntry = z.object({
  code: z.string().min(1),
  label: z.string(),
  scope: RoleScope,
  group: z.string(),
  description: z.string().default(''),
  createdAt: z.string().datetime(),
});
export type PermissionEntry = z.infer<typeof PermissionEntry>;

/** 角色（HTTP 响应，对齐 Prisma Role 模型 camelCase）。 */
export const Role = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  scope: RoleScope,
  teamId: z.string().nullable(),
  isSystem: z.boolean().default(false),
  description: z.string().default(''),
  permissions: z.array(z.string()).default([]),
  memberCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Role = z.infer<typeof Role>;

/** 插件授权行（HTTP 响应，对齐 Prisma PluginGrant 模型 camelCase）。 */
export const PluginGrantRow = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  pluginId: z.string().min(1),
  subjectKind: PluginGrantSubject,
  subjectId: z.string().min(1),
  effect: PluginGrantEffect,
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type PluginGrantRow = z.infer<typeof PluginGrantRow>;

// ——— 请求体 DTO（创建/更新角色、设置插件授权） ———

export const CreateRoleRequest = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
  permissions: z.array(z.string().min(1)).default([]),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;

export const UpdateRoleRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(255).optional(),
  permissions: z.array(z.string().min(1)).optional(),
});
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequest>;

export const AssignRoleRequest = z.object({
  userId: z.string().min(1),
  roleId: z.string().min(1),
});
export type AssignRoleRequest = z.infer<typeof AssignRoleRequest>;

export const SetPluginGrantRequest = z.object({
  subjectKind: PluginGrantSubject,
  subjectId: z.string().min(1),
  effect: PluginGrantEffect,
});
export type SetPluginGrantRequest = z.infer<typeof SetPluginGrantRequest>;
