// 审计 action 分类 + 中文说明注册表（组D 审计完善核心）。
//
// 设计动机：此前 audit action 是裸字符串散落各 service，audit-view 只能原样展示（如 "team.balance.consumed"），
// 无分类筛选、无人类可读说明。现集中维护：
//   1. ACTION_LABEL：action → 中文说明，audit-view 展示中文而非裸字符串。
//   2. ACTION_CATEGORY：action → 模块分类（auth/team/plugin/marketplace/wallet/llm/admin/system）。
//   3. CATEGORIES：分类元数据（key + 中文 + 说明），供 audit-view 分类筛选下拉。
//
// 归类策略（不破坏现有 action 字面量）：按 action 前缀推断分类，未注册的 action 用前缀兜底。
//   - admin.*     → admin（平台管理员操作）
//   - auth.*      → auth（鉴权会话）
//   - team.*      → team（团队/成员/余额）
//   - invitation.*→ team（邀请码归入团队）
//   - team_admin_application.* → team（团队管理员申请归入团队）
//   - plugin.*    → plugin（插件生命周期）
//   - marketplace.* / plugin.marketplace.* → marketplace（市场）
//   - wallet.*    → wallet（钱包交易）
//   - llm.* / llm_binding.* → llm（租户 LLM 绑定）
//   - system.* / platform_admin.* / admin.setting.* → system（平台配置/启动）
//
// 与前端 types.ts 的 ACTION_LABEL 保持单一来源：后端不直接返回 label（避免泄露未授权数据），
// 前端自带 ACTION_LABEL 镜像（admin 视图本就在受信环境）。本注册表供后端 adminAuditCategories 端点
// 返回分类元数据，供前端筛选下拉渲染（前后端分类 key 对齐）。

export type AuditCategoryKey =
  | 'auth'
  | 'team'
  | 'plugin'
  | 'marketplace'
  | 'wallet'
  | 'llm'
  | 'admin'
  | 'system';

export interface AuditCategoryMeta {
  key: AuditCategoryKey;
  label: string;
  description: string;
}

// 分类元数据：audit-view 分类筛选下拉的选项来源（key 对齐 action 前缀）。
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

// action → 中文说明。注册所有已知 action，未注册的用 action 字面量兜底（前端 actionLabel 同款逻辑）。
// 注意：与前端 apps/collab-admin/src/lib/types.ts ACTION_LABEL 保持镜像（单一概念，两处定义因前后端隔离）。
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  // === auth（鉴权会话）===
  'auth.register': '注册账号',
  'auth.login.success': '登录成功',
  'auth.login.failed': '登录失败',
  'auth.logout': '退出登录',
  'auth.token.refreshed': '刷新会话令牌',
  'auth.password.reset': '重置密码',
  'auth.email.verified': '邮箱验证通过',

  // === team（团队/成员/邀请/申请）===
  'team_admin_application.created': '提交团队管理员申请',
  'team_admin_application.approved': '通过团队管理员申请',
  'team_admin_application.rejected': '驳回团队管理员申请',
  'team.public_joined': '加入公开团队',
  'team.member.removed': '移除团队成员',
  'team.member.role_changed': '调整团队成员角色',
  'team.status.suspended': '停用团队',
  'team.status.activated': '启用团队',
  'team.profile.updated': '更新团队资料',
  'team.balance.consumed': '消耗团队余额',
  'invitation.created': '创建邀请码',
  'invitation.disabled': '停用邀请码',
  'invitation.redeemed': '兑换邀请码',

  // === plugin（插件生命周期）===
  'plugin.uploaded': '上传插件',
  'plugin.draft.edited': '编辑插件草稿',
  'plugin.price.set': '设置插件定价',
  'plugin.enabled': '启用插件',
  'plugin.disabled': '禁用插件',
  'plugin.marketplace.submitted': '提交插件到市场',
  'plugin.marketplace.installed': '安装市场插件',
  'plugin.marketplace.rated': '评价市场插件',

  // === rbac（角色与插件授权）===
  'role.created': '创建角色',
  'role.updated': '更新角色',
  'role.deleted': '删除角色',
  'role.assigned': '分配成员角色',
  'role.revoked': '撤销成员角色',
  'plugin.grant.set': '设置插件授权',
  'plugin.grant.removed': '移除插件授权',

  // === marketplace（市场）===
  'marketplace.plugin.installed': '市场安装插件',

  // === wallet（钱包交易）===
  'wallet.signup_bonus': '注册赠送',
  'wallet.purchase': '购买插件扣款',
  'wallet.sale': '插件销售收入',
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

  // === system（平台配置/启动）===
  'admin.setting.updated': '更新平台设置',
  'admin.setting.test_email': '测试 SMTP 邮件',
  'admin.setting.secret_revealed': '查看敏感配置明文',
  'platform_admin.bootstrap': '引导平台管理员',
};

// 前缀 → 分类映射（用于推断未注册 action 的分类，保证新 action 不丢分类）。
const PREFIX_CATEGORY: Array<{ prefix: string; category: AuditCategoryKey }> = [
  { prefix: 'admin.setting', category: 'system' },
  { prefix: 'platform_admin', category: 'system' },
  { prefix: 'admin.', category: 'admin' },
  { prefix: 'auth.', category: 'auth' },
  { prefix: 'llm_binding.', category: 'llm' },
  { prefix: 'invitation.', category: 'team' },
  { prefix: 'team_admin_application.', category: 'team' },
  // RBAC：团队角色/插件授权归 team 分类；平台角色动作由显式表覆盖归 admin。
  { prefix: 'role.', category: 'team' },
  { prefix: 'plugin.grant.', category: 'team' },
  { prefix: 'team.', category: 'team' },
  { prefix: 'plugin.marketplace.', category: 'marketplace' },
  { prefix: 'marketplace.', category: 'marketplace' },
  { prefix: 'plugin.', category: 'plugin' },
  { prefix: 'wallet.', category: 'wallet' },
  { prefix: 'system.', category: 'system' },
];

/** 推断 action 的分类：先查显式注册表，未命中则按前缀兜底，均未命中归 system（未知配置类）。 */
export function auditActionCategory(action: string): AuditCategoryKey {
  // 显式分类表（覆盖需要跨前缀归类的特殊 action，如 platform_admin.bootstrap → system）。
  const explicit = ACTION_CATEGORY_EXPLICIT[action];
  if (explicit) return explicit;
  for (const { prefix, category } of PREFIX_CATEGORY) {
    if (action.startsWith(prefix)) return category;
  }
  return 'system';
}

/** action → 中文说明：未注册时原样返回（与前端 actionLabel 同款兜底语义）。 */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] || action;
}

// 显式分类覆盖表：处理跨前缀归类的特殊情况。
// 例如 platform_admin.bootstrap 归 system（启动引导，非 admin 治理操作）；
// user.account_deleted 归 auth（账号生命周期操作：注销属于身份范畴，便于按账户维度筛选）。
const ACTION_CATEGORY_EXPLICIT: Record<string, AuditCategoryKey> = {
  'platform_admin.bootstrap': 'system',
  'user.account_deleted': 'auth',
};
