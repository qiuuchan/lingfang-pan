export type View = 'dashboard' | 'users' | 'platformAdmins' | 'teams' | 'plugins' | 'applications' | 'audit' | 'llmProviders' | 'settings';
export type UserStatus = 'ACTIVE' | 'DISABLED';
export type PlatformRole = 'NONE' | 'PLATFORM_ADMIN';
export type TeamStatus = 'ACTIVE' | 'SUSPENDED';
export type PluginStatus = 'ENABLED' | 'DISABLED';
export type PluginReviewStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type PluginVisibility = 'PUBLIC' | 'TEAM' | 'PRIVATE';
export type PluginRuntimeType = 'CLIENT' | 'NODE' | 'PYTHON';
export type ApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type TeamRole = 'TEAM_ADMIN' | 'MEMBER';
export type LedgerDirection = 'CREDIT' | 'DEBIT';

export type User = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  platformRole: PlatformRole;
};

export type TeamMember = {
  teamId: string;
  userId: string;
  role: TeamRole;
  status: string;
  joinedAt: string;
  user: User;
};

export type Team = {
  id: string;
  name: string;
  slug: string;
  status: TeamStatus;
  balanceCents: number;
  memberCount?: number;
  members?: TeamMember[];
  // 后端 adminTeams 返回完整 Team 行（...team 展开），补充管理端详情所需字段。
  allowPublicJoin?: boolean;
  description?: string;
  createdAt?: string;
};

// 插件完整字段：后端 publicPlugin（apps/collab-api/src/modules/plugin-package.ts）实际返回上述全部字段，
// 此前前端只声明了 4 个，导致详情 Sheet 无法展示 capabilities / 文件列表 / 审核状态等治理信息。
// files / manifest / capabilities 后端存为 Json，前端按 unknown 持有，渲染时再做结构化降级。
export type PluginFileEntry = { path?: string; size?: number; hash?: string } & Record<string, unknown>;
export type Plugin = {
  id: string;
  name: string;
  description: string;
  status: PluginStatus;
  updatedAt?: string;
  version?: string;
  entry?: string;
  runtimeType?: string;
  runtime_type?: string;
  visibility?: PluginVisibility;
  teamId?: string | null;
  authorUserId?: string | null;
  files?: PluginFileEntry[] | unknown;
  manifest?: Record<string, unknown> | unknown;
  capabilities?: unknown;
  contentHash?: string;
  reviewStatus?: PluginReviewStatus;
  reviewReason?: string;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  marketplace?: boolean;
  priceCents?: number;
  installCount?: number;
  ratingCount?: number;
  ratingSum?: number;
  createdAt?: string;
};

// LLM provider 目录项（镜像后端 LlmProviderAdmin 出参，见 packages/contract/src/llm.ts）。
// isActive 是核心视图概念：全表最多一条 true（事务维护唯一），代表「当前启用」的模型服务。
export type LlmProviderStatus = 'ENABLED' | 'DISABLED';
export type LlmProvider = {
  id: string;
  provider: string;
  name: string;
  apiUrl: string;
  status: LlmProviderStatus;
  models: string[];
  description: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Application = {
  id: string;
  teamName: string;
  reason: string;
  status: ApplicationStatus;
  reviewReason: string;
  createdAt?: string;
  reviewedAt?: string | null;
  user: User;
  reviewedBy?: User | null;
};

export type AuditLog = {
  id: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: unknown;
  createdAt: string;
  actor?: User | null;
};

export const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '正常',
  DISABLED: '已禁用',
  SUSPENDED: '已停用',
  ENABLED: '已启用',
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  DRAFT: '草稿',
  NONE: '普通用户',
  PLATFORM_ADMIN: '平台管理员',
  TEAM_ADMIN: '团队管理员',
  MEMBER: '成员',
  CREDIT: '入账',
  DEBIT: '扣减',
  PUBLIC: '公开',
  TEAM: '团队',
  PRIVATE: '私有',
  CLIENT: '客户端',
  NODE: 'Node 服务',
  PYTHON: 'Python 服务',
  marketplace: '已上架市场',
  true: '是',
  false: '否',
};

export const ACTION_LABEL: Record<string, string> = {
  'team_admin_application.approved': '通过团队管理员申请',
  'team_admin_application.created': '提交团队管理员申请',
  'team_admin_application.rejected': '驳回团队管理员申请',
  'admin.team_admin.assigned': '指定团队管理员',
  'admin.team_admin.revoked': '撤销团队管理员',
  'admin.team.balance_adjusted': '调整团队余额',
  'admin.team.created': '创建团队',
  'admin.team.updated': '更新团队信息',
  'admin.user.created': '创建用户',
  'admin.user.updated': '更新用户信息',
  'admin.user.disabled': '禁用用户',
  'admin.plugin.created': '登记平台插件',
  'admin.plugin.updated': '更新插件治理状态',
  'invitation.created': '创建邀请码',
  'invitation.disabled': '停用邀请码',
  'invitation.redeemed': '兑换邀请码',
  'team.member.removed': '移除团队成员',
};

export const TARGET_LABEL: Record<string, string> = {
  User: '用户',
  Team: '团队',
  Plugin: '插件',
  TeamAdminApplication: '团队管理员申请',
  InvitationCode: '邀请码',
};

export function labelOf(value?: string | null) {
  if (!value) return '—';
  return STATUS_LABEL[value] || value;
}

export function actionLabel(value: string) {
  return ACTION_LABEL[value] || value;
}

export function targetLabel(value: string) {
  return TARGET_LABEL[value] || value;
}

export function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN');
}

export function yuanToCents(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('金额格式不正确');
  return Math.round(amount * 100);
}

export function activeMembers(team: Team) {
  return (team.members || []).filter((member) => member.status === 'ACTIVE');
}

export function teamAdmins(team: Team) {
  return activeMembers(team).filter((member) => member.role === 'TEAM_ADMIN');
}

export function adminNames(team: Team) {
  const names = teamAdmins(team).map((member) => member.user.displayName || member.user.email);
  return names.length ? names.join('、') : '—';
}

// ADMIN-VIEW-08 修复：localizeMetadata 此前对每个字符串 value 无差别 labelOf，
// 命中 STATUS_LABEL 即替换——审计 metadata 含大量业务字符串（reason/name/displayName），
// 恰好等于状态码字面量（PENDING/ACTIVE/NONE/CREDIT 等）的业务文本会被错误翻译（如团队名 NONE 显示「普通用户」）。
// 现改为白名单：仅对已知枚举 key（direction/status/platformRole/role）做 labelOf，其余原样输出；
// 对 amountCents 这类已知金额字段做分→元格式化，避免裸露的 cents 数值。
const METADATA_LOCALIZE_KEYS = new Set(['direction', 'status', 'platformRole', 'role']);

export function localizeMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  return Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>).map(([key, value]) => {
      if (METADATA_LOCALIZE_KEYS.has(key) && typeof value === 'string') return [key, labelOf(value)];
      if (key === 'amountCents' && (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) {
        // 分→元格式化，裸露的 cents 不便阅读。
        return [key, `${(Number(value) / 100).toFixed(2)} 元`];
      }
      return [key, value];
    }),
  );
}