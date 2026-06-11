// 身份与租户契约（见 docs/02 §A）。
import { z } from 'zod';

export const TenantRole = z.enum(['owner', 'admin', 'developer', 'member']);
export type TenantRole = z.infer<typeof TenantRole>;

export const User = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  display_name: z.string().min(1),
  status: z.enum(['active', 'disabled']).default('active'),
  created_at: z.string().datetime(),
});
export type User = z.infer<typeof User>;

export const Tenant = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  owner_user_id: z.string().min(1),
  status: z.enum(['active', 'suspended']).default('active'),
  created_at: z.string().datetime(),
});
export type Tenant = z.infer<typeof Tenant>;

export const Membership = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  role: TenantRole,
  status: z.enum(['active', 'invited', 'disabled']).default('active'),
  joined_at: z.string().datetime(),
});
export type Membership = z.infer<typeof Membership>;

// —— 请求 / 响应 ——
export const RegisterRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  display_name: z.string().min(1),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

// 登录返回的 JWT 与当前上下文（tenant_id 在用户尚未选租户时为 null）
export const AuthSession = z.object({
  token: z.string().min(1),
  user_id: z.string().min(1),
  tenant_id: z.string().min(1).nullable(),
  role: TenantRole.nullable(),
});
export type AuthSession = z.infer<typeof AuthSession>;

export const CreateTenantRequest = z.object({ name: z.string().min(1), slug: z.string().min(1) });
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const InviteMemberRequest = z.object({
  email: z.string().email(),
  role: TenantRole.default('member'),
});
export type InviteMemberRequest = z.infer<typeof InviteMemberRequest>;
