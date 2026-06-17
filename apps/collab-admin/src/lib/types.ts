export type View = 'dashboard' | 'users' | 'platformAdmins' | 'teams' | 'plugins' | 'applications' | 'audit' | 'llmProviders' | 'settings' | 'releases';
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
export type ReleaseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type ReleaseChannel = 'STABLE' | 'BETA';
export type AssetPlatform = 'WINDOWS' | 'DARWIN' | 'LINUX';
export type AssetArch = 'X86_64' | 'AARCH64' | 'UNIVERSAL';

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

// 组D 审计完善：分类元数据 + action 推断分类辅助。
// 与后端 apps/collab-api/src/modules/audit-actions.ts 对齐（key 一一对应），audit-view 据此渲染分类筛选下拉。
export type AuditCategoryKey =
  | 'auth' | 'team' | 'plugin' | 'marketplace' | 'wallet' | 'llm' | 'admin' | 'system';

export type AuditCategoryMeta = {
  key: AuditCategoryKey;
  label: string;
  description: string;
};

export const AUDIT_CATEGORIES: AuditCategoryMeta[] = [
  { key: 'auth', label: '鉴权会话', description: '登录/登出/注册/找回密码/token 刷新' },
  { key: 'team', label: '团队', description: '团队创建/停用、成员管理、邀请码、团队管理员申请' },
  { key: 'plugin', label: '插件', description: '插件上传/编辑/审核/安装生命周期' },
  { key: 'marketplace', label: '市场', description: '市场上架/购买/评分' },
  { key: 'wallet', label: '钱包', description: '钱包余额变动/赠送/购买扣款' },
  { key: 'llm', label: 'LLM 绑定', description: '租户 API Key 绑定/解绑/解密' },
  { key: 'admin', label: '平台管理', description: '平台管理员对用户/团队/插件/provider/release 的治理操作' },
  { key: 'system', label: '系统配置', description: '平台设置/SMTP 测试/启动引导' },
];

// 前缀 → 分类映射（与后端 PREFIX_CATEGORY 对齐），用于推断未注册 action 的分类。
// 跨前缀归类的特殊情况（platform_admin.bootstrap → system, user.account_deleted → auth）在 explicit 中处理。
const AUDIT_CATEGORY_EXPLICIT: Record<string, AuditCategoryKey> = {
  'platform_admin.bootstrap': 'system',
  'user.account_deleted': 'auth',
};
const AUDIT_PREFIX_CATEGORY: Array<{ prefix: string; category: AuditCategoryKey }> = [
  { prefix: 'admin.setting', category: 'system' },
  { prefix: 'platform_admin', category: 'system' },
  { prefix: 'admin.', category: 'admin' },
  { prefix: 'auth.', category: 'auth' },
  { prefix: 'llm_binding.', category: 'llm' },
  { prefix: 'invitation.', category: 'team' },
  { prefix: 'team_admin_application.', category: 'team' },
  { prefix: 'team.', category: 'team' },
  { prefix: 'plugin.marketplace.', category: 'marketplace' },
  { prefix: 'marketplace.', category: 'marketplace' },
  { prefix: 'plugin.', category: 'plugin' },
  { prefix: 'wallet.', category: 'wallet' },
  { prefix: 'system.', category: 'system' },
];

/** 推断 action 的分类：先查显式覆盖表，未命中则按前缀兜底，均未命中归 system。 */
export function auditCategory(action: string): AuditCategoryKey {
  const explicit = AUDIT_CATEGORY_EXPLICIT[action];
  if (explicit) return explicit;
  for (const { prefix, category } of AUDIT_PREFIX_CATEGORY) {
    if (action.startsWith(prefix)) return category;
  }
  return 'system';
}

/** 分类 key → 中文 label。 */
export function categoryLabel(key: AuditCategoryKey): string {
  return AUDIT_CATEGORIES.find((c) => c.key === key)?.label || key;
}

// 组B 团队管理完善：/api/admin/teams/:id/detail 聚合视图类型。
// 与后端 adminTeamDetail 返回结构一一对应：成员数 + 插件列表 + 购买记录 + 余额流水摘要。
export type TeamLedgerEntry = {
  id?: string;
  teamId: string;
  amountCents: number;
  direction: LedgerDirection;
  reason: string;
  actorUserId?: string | null;
  createdAt: string;
};

export type TeamPurchaseEntry = {
  id: string;
  pluginId: string;
  pluginName: string;
  priceCents: number;
  createdAt: string;
};

export type TeamDetailPlugin = {
  id: string;
  name: string;
  status: PluginStatus;
  visibility: PluginVisibility;
  reviewStatus: PluginReviewStatus;
  marketplace: boolean;
  priceCents: number;
  installCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TeamDetail = {
  team: Team;
  memberCount: number;
  pluginCount: number;
  plugins: TeamDetailPlugin[];
  purchases: TeamPurchaseEntry[];
  ledgerSummary: { totalCreditCents: number; totalDebitCents: number; netCents: number };
  recentLedger: TeamLedgerEntry[];
};

// 组C 用户管理完善：/api/admin/users/:id/detail 聚合视图类型。
// 与后端 adminUserDetail 返回结构一一对应：登录历史 + 钱包 + 团队 memberships + 钱包流水。
export type UserDetail = {
  user: User & { createdAt?: string; emailVerified?: string | null };
  loginHistory: Array<{
    id: string;
    action: string;
    metadata?: unknown;
    createdAt: string;
  }>;
  wallet: { balanceCents: number };
  teams: Array<{
    teamId: string;
    role: TeamRole;
    status: string;
    joinedAt: string;
    team: { id: string; name: string; slug: string; status: TeamStatus; balanceCents: number };
  }>;
  walletTransactions: Array<{
    id: string;
    amountCents: number;
    direction: LedgerDirection;
    reason: string;
    pluginId?: string | null;
    createdAt: string;
  }>;
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
  // === auth（鉴权会话）组D 补全 ===
  'auth.register': '注册账号',
  'auth.login.success': '登录成功',
  'auth.login.failed': '登录失败',
  'auth.logout': '退出登录',
  'auth.token.refreshed': '刷新会话令牌',
  'auth.password.reset': '重置密码',
  'auth.email.verified': '邮箱验证通过',
  // === team（团队/成员/邀请/申请）===
  'team_admin_application.approved': '通过团队管理员申请',
  'team_admin_application.created': '提交团队管理员申请',
  'team_admin_application.rejected': '驳回团队管理员申请',
  'team.public_joined': '加入公开团队',
  'team.member.removed': '移除团队成员',
  'team.profile.updated': '更新团队资料',
  'team.balance.consumed': '消耗团队余额',
  'invitation.created': '创建邀请码',
  'invitation.disabled': '停用邀请码',
  'invitation.redeemed': '兑换邀请码',
  // === plugin（插件生命周期）===
  'plugin.uploaded': '上传插件',
  'plugin.draft.edited': '编辑插件草稿',
  'plugin.marketplace.submitted': '提交插件到市场',
  'plugin.marketplace.installed': '安装市场插件',
  'plugin.marketplace.rated': '评价市场插件',
  // === marketplace（市场）===
  'marketplace.plugin.installed': '市场安装插件',
  // === wallet（钱包交易）===
  'wallet.purchase': '购买插件扣款',
  'user.account_deleted': '注销账号',
  // === llm（租户 LLM 绑定）===
  'llm_binding.upserted': '更新 LLM 绑定',
  'llm_binding.deleted': '删除 LLM 绑定',
  'llm_binding.key_decrypted': '解密 LLM API Key',
  // === admin（平台管理员治理）===
  'admin.user.created': '创建用户',
  'admin.user.updated': '更新用户信息',
  'admin.user.disabled': '禁用用户',
  'admin.user.password_reset': '管理员重置用户密码',
  'admin.user.role_changed': '调整用户平台角色',
  'admin.team.created': '创建团队',
  'admin.team.updated': '更新团队信息',
  'admin.team.deleted': '停用团队',
  'admin.team.balance_adjusted': '调整团队余额',
  'admin.team_admin.assigned': '指定团队管理员',
  'admin.team_admin.revoked': '撤销团队管理员',
  'admin.plugin.approved': '审核通过插件',
  'admin.plugin.rejected': '驳回插件',
  'admin.plugin.updated': '更新插件治理状态',
  'admin.plugin.created': '登记平台插件',
  'admin.plugin.unlisted': '下架市场插件',
  'admin.plugin.delisted': '下架市场插件',
  'admin.llm_provider.created': '创建 LLM Provider',
  'admin.llm_provider.updated': '更新 LLM Provider',
  'admin.llm_provider.deleted': '删除 LLM Provider',
  'admin.llm_provider.activated': '启用 LLM Provider',
  'admin.release.created': '创建版本',
  'admin.release.updated': '更新版本信息',
  'admin.release.published': '发布版本',
  'admin.release.archived': '归档版本',
  'admin.release.asset_added': '登记版本产物',
  'admin.release.asset_deleted': '删除版本产物',
  // 组B 团队管理完善：成员角色切换 + 团队启停（前缀分类 team.member.* / team.status.*）。
  'team.member.role_changed': '调整团队成员角色',
  'team.status.suspended': '停用团队',
  'team.status.activated': '启用团队',
  // === system（平台配置）===
  'admin.setting.updated': '更新平台设置',
  'admin.setting.test_email': '测试 SMTP 邮件',
  'platform_admin.bootstrap': '引导平台管理员',
};

export const TARGET_LABEL: Record<string, string> = {
  User: '用户',
  Team: '团队',
  Plugin: '插件',
  TeamAdminApplication: '团队管理员申请',
  InvitationCode: '邀请码',
  TenantLlmBinding: 'LLM 绑定',
  LlmGateway: 'LLM Provider',
  Release: '版本',
  ReleaseAsset: '版本产物',
  PlatformSetting: '平台设置',
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