import type { PluginCapability } from '@lingfang/contract';
import { formatTimestamp } from './time';

export type PlatformRole = 'NONE' | 'PLATFORM_ADMIN';
export type TeamRole = string;
export type OnboardingState = 'NEEDS_INVITATION' | 'PENDING_APPROVAL' | 'APPLICATION_REJECTED' | 'TEAM_SPACE' | 'TEAM_ADMIN_SPACE' | 'PLATFORM_ADMIN_WEB_ONLY';

export interface Session {
  token: string | null;
  userId: string | null;
  displayName: string | null;
  email: string | null;
  tenantId: string | null;
  tenantName: string | null;
  role: TeamRole | null;
  isPlatformAdmin: boolean;
  onboarding: OnboardingState | null;
  application?: TeamAdminApplication | null;
  /** RBAC：当前用户拥有的全部权限码（平台 + 团队），前端据此做入口门控。空数组表示无权限。 */
  permissions: string[];
}

export interface CollabSessionResponse {
  token?: string;
  user: { id: string; email: string; displayName: string; platformRole: PlatformRole; status: string };
  team: { id: string; name: string; slug: string; role: TeamRole; teamRoleId?: string | null } | null;
  /** RBAC：当前用户权限码列表（后端 sessionFor 注入）。 */
  permissions?: string[];
  application: TeamAdminApplication | null;
  onboarding: OnboardingState;
}

export interface TeamAdminApplication {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  teamName: string;
  reviewReason?: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  balanceCents: number;
  allowPublicJoin?: boolean;
  description?: string;
}

export interface PlatformInfo {
  platformName: string;
  logoUrl: string;
}

/** 公开团队发现页条目（GET /api/teams/public）。 */
export interface PublicTeam {
  id: string;
  name: string;
  slug: string;
  description: string;
  memberCount: number;
}

/** 当前团队公开发现设置（GET /api/teams/current/profile）。 */
export interface TeamProfile {
  id: string;
  name: string;
  allowPublicJoin: boolean;
  description: string;
}

export interface TeamMember {
  userId: string;
  role: TeamRole;
  /** RBAC：成员当前团队角色 id（经 teamRoleId 关联到 Role）。过渡期与 role 枚举并存；旧后端可能不返回。 */
  teamRoleId?: string | null;
  /** 角色显示名（来自关联 Role.name，自定义角色如「开发者」也正确）。role 为 null 时为 null。 */
  roleName?: string | null;
  /** 角色编码（来自关联 Role.code）。role 为 null 或无 code 时为 null。 */
  roleCode?: string | null;
  joinedAt: string;
  user: { id: string; email: string; displayName: string; status: string };
}

export interface InvitationCode {
  id: string;
  displayCodePrefix: string;
  code?: string;
  status: string;
  maxUses: number;
  usedCount: number;
  expiresAt?: string | null;
  createdAt: string;
}

export interface BalanceLedger {
  id: string;
  amountCents: number;
  direction: 'CREDIT' | 'DEBIT';
  reason: string;
  createdAt: string;
}

export type AssistantOutputStream = 'stdout' | 'stderr' | 'thought' | 'tool';

export interface DraftTurnSegment {
  stream: AssistantOutputStream;
  text: string;
}

export interface DraftTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  segments?: DraftTurnSegment[];
}

export interface DraftFile {
  path: string;
  content: string;
}

export interface DraftDiagnostic {
  stage: string;
  status: string;
  message: string;
}

export interface PluginDraft {
  id: string;
  status: string;
  files: DraftFile[];
  turns: DraftTurn[];
  diagnostics: DraftDiagnostic[];
  [k: string]: unknown;
}

// 一键 AI 修复跨页载荷：插件启动/运行报错 → 跳创建器（FloatingCreator）预填。
// 携带预填提示词（报错 + 修复指引）+ 出错插件（作为引用注入源码，让 AI 基于现有代码改）。
// 创建器消费后即清空（用完即弃），不持久化。
export interface PendingAutoFix {
  /** 预填到创建器输入框的提示词：插件信息 + 报错 + 修复指引。 */
  prompt: string;
  /** 出错插件：作为 referencedPlugin 注入源码到上下文。 */
  plugin: LoadedPlugin;
}

// 草稿编辑跨页载荷：草稿列表点「编辑」→ 跳创建器恢复对话历史（task 06-25 增强）。
// 携带草稿完整对象 + 对话轮次，创建器消费后恢复 turns + referencedPlugin。
export interface PendingDraftEdit {
  /** 草稿插件完整对象（含 files）。 */
  draft: LoadedPlugin;
  /** 对话轮次（从 _meta.turns 恢复）。 */
  turns: unknown[];
}

export interface LoadedPlugin {
  id: string;
  name: string;
  description?: string;
  version: string;
  /** 已安装版本（PluginInstallation.version，仅已安装的市场插件有）。
   *  前端对比 version（云端最新版）vs installedVersion 判断是否有更新。 */
  installedVersion?: string;
  builtin?: boolean;
  entry: string;
  status?: string;
  source?: 'builtin' | 'published' | 'installed' | 'platform' | 'team' | 'marketplace';
  // 作者用户 ID（来自后端 publicPlugin.authorUserId）：用于前端判断「能否修改该插件」。
  // 权限规则（与后端 ensurePluginManager 一致）：作者本人 或 当前用户是 TEAM_ADMIN 可改。
  authorUserId?: string;
  // 运行时类型（manifest.runtime_type）：决定插件运行方式（client=软件内 iframe，nodejs/python=独立进程）。
  // 来源：collab-api 的 publicPlugin 已返回该字段（plugin-package.ts 解析），内置插件未返回时回退 'client'。
  // task 06-16-plugin-system-rebuild 组C：Plugins.tsx 据此渲染「运行」/「打开」按钮分派。
  runtime_type?: 'client' | 'nodejs' | 'python' | 'cloud';
  capabilities?: Array<PluginCapability | { kind?: string } | string>;
  files?: DraftFile[];
  manifest?: unknown;
  reviewStatus?: string;
  reviewReason?: string;
  marketplace?: boolean;
  priceCents?: number;
  updatedAt?: string;
  // 本地草稿插件标记（task 06-25-local-draft-storage）
  draft?: boolean;
  local?: boolean;
  versionCount?: number; // 历史版本数（.versions/vN 目录数）
  _meta?: {
    createdAt: string;
    updatedAt: string;
    source: string;
    publishedToTeam?: boolean;
    conversationId?: string;
    turns?: unknown; // 对话轮次（编辑时恢复）
  };
}

export type SettingsTab = 'general' | 'cli' | 'gateway' | 'plugins' | 'backend' | 'about';
// 06-24 计费钱包重构：原 'team' | 'wallet' 两个独立悬浮窗合并为 'team-wallet'（团队钱包）。
export type AccountSettingsTab = 'account' | 'team-wallet' | 'settings';

// 路线 A：插件中心改为悬浮窗（pluginCenterOpen），原 'plugins' | 'author-center' | 'market'
// 三个主区 view 已删除。'creator' 保留为 setView 拦截键（拦截后开创建器悬浮窗，非主区渲染）；
// 'team-wallet' | 'settings' 同为 setView 拦截转独立悬浮窗。
export type View = 'home' | 'creator' | 'team-wallet' | 'team-admin' | 'settings' | 'review';

// RBAC：团队角色 + 权限码 + 插件授权（与后端 Role/PermissionEntry/PluginGrant + contract rbac.ts 对齐）。
export type RoleScope = 'PLATFORM' | 'TEAM';
export type PluginGrantSubject = 'USER' | 'ROLE';
export type PluginGrantEffect = 'ALLOW' | 'DENY';

export interface PermissionEntry {
  code: string;
  label: string;
  scope: RoleScope;
  group: string;
  moduleKey: string;
  moduleLabel: string;
  moduleOrder: number;
  description: string;
  createdAt: string;
}

/** 权限模块定义（两级结构父级：模块 → 操作列表）。 */
export interface PermissionModule {
  moduleKey: string;
  moduleLabel: string;
  scope: RoleScope;
  sortOrder: number;
  operations: PermissionEntry[];
}

/** 权限分组（可编辑显示名，覆盖 moduleLabel）。 */
export interface PermissionGroup {
  scope: RoleScope;
  groupKey: string;
  displayName: string;
  sortOrder: number;
  isSystem: boolean;
  customized?: boolean;
}

export interface Role {
  id: string;
  name: string;
  code: string | null;
  scope: RoleScope;
  teamId: string | null;
  isSystem: boolean;
  description: string;
  permissions: string[];
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginGrantRow {
  id: string;
  teamId: string;
  pluginId: string;
  subjectKind: PluginGrantSubject;
  subjectId: string;
  effect: PluginGrantEffect;
  createdBy: string | null;
  createdAt: string;
}

/** 通用时间格式化：ISO 字符串 → zh-CN 本地时间（24h），解析失败返回 '—'。
 *  委托给 lib/time 的 formatTimestamp，兼容旧版 epoch.毫秒Z 格式（Task 4a 修复）。 */
export function formatTime(iso: string | null | undefined): string {
  return formatTimestamp(iso);
}

// === Task 7 通知中心 ===
// 后端 Notification 模型（apps/collab-api/prisma/schema.prisma）经 publicNotification 出参：
// camelCase + createdAt ISO 字符串。type 为语义串（plugin_approved / new_version 等），前端按映射展示。

/** 通知条目（GET /api/notifications 返回的元素结构）。 */
export interface NotificationItem {
  id: string;
  /** 语义类型（plugin_approved / plugin_rejected / plugin_delisted / application_approved /
   *  application_rejected / password_reset_by_admin / purchased / purchase_sale / new_version / …）。 */
  type: string;
  title: string;
  body: string;
  read: boolean;
  /** 关联实体类型/id（前端据此跳转，如 plugin → 市场详情）。 */
  relatedType?: string | null;
  relatedId?: string | null;
  createdAt: string;
}

/** GET /api/notifications 响应。 */
export interface NotificationsResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

