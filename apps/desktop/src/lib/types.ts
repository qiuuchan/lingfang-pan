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
}

export interface CollabSessionResponse {
  token?: string;
  user: { id: string; email: string; displayName: string; platformRole: PlatformRole; status: string };
  team: { id: string; name: string; slug: string; role: TeamRole } | null;
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

// 组C 极验：GET /api/platform-info 公开端点响应（不鉴权）。
// geetestCaptchaId 空串=未配置极验，前端不显验证码（开发态跳过）。
// geetestScenes 逗号分隔的场景白名单（login/register/forgot），前端按当前表单场景决定是否强制验证码。
export interface PlatformInfo {
  platformName: string;
  logoUrl: string;
  geetestCaptchaId: string;
  geetestScenes: string;
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

export interface DraftTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
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

export type View = 'home' | 'team' | 'team-manage' | 'plugins' | 'settings' | 'market' | 'wallet' | 'review';