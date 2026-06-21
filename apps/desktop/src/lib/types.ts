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

export interface LoadedPlugin {
  id: string;
  name: string;
  description?: string;
  version: string;
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
  files?: DraftFile[];
  manifest?: unknown;
  reviewStatus?: string;
  reviewReason?: string;
  marketplace?: boolean;
  priceCents?: number;
  updatedAt?: string;
}

export type SettingsTab = 'cli' | 'gateway' | 'plugins' | 'backend';
export type AccountSettingsTab = 'account' | 'team' | 'wallet' | 'settings';

export type View = 'home' | 'creator' | 'team' | 'team-admin' | 'plugins' | 'author-center' | 'settings' | 'market' | 'wallet' | 'review';

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
