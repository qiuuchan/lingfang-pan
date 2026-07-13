// 权限码注册表（单一事实来源）。
//
// 设计要点：
//  - 权限码为预定义字符串（dot.notation，形如 "team.member.invite"），不可由用户自由新增。
//  - 分两层 scope：PLATFORM（平台级，管平台资源）/ TEAM（团队级，管团队内资源）。
//  - 权限按「模块 → 操作」两级组织：PermissionModule（父级，如「插件管理」）含若干 PermissionCodeDef（子操作）。
//    前端按模块折叠展示两级勾选树；moduleKey 即旧版 group 字段（向后兼容保留）。
//  - 此文件是后端授权检查 + seed PermissionEntry/PermissionGroup 表 + 前端 admin 勾选面板的共同来源。
//  - 新增操作时：先在此注册码 → seed 到 PermissionEntry 表 → 在对应 controller 方法挂 @RequirePermission。
//
// 命名约定：<scope>.<resource>.<action>（如 platform.user.create、team.plugin.install）。
// moduleKey 取 <scope>.<resource>（即 code 去掉最后一段 action）；特殊地 team.plugin.grant 单独成模块。

export type PermissionScope = 'PLATFORM' | 'TEAM';

/** 单条权限码定义（= 一个操作节点，两级树的叶子）。 */
export interface PermissionCodeDef {
  code: string;
  label: string;
  scope: PermissionScope;
  /** 分组键（= moduleKey，向后兼容保留）。 */
  group: string;
  /** 所属模块键（与 group 相同，新代码优先用此字段）。 */
  moduleKey: string;
  /** 所属模块显示名（如「插件管理」）。同一模块下多权限共享同一值。 */
  moduleLabel: string;
  /** 模块排序（升序），同一模块共享。 */
  moduleOrder: number;
  description: string;
}

/** 权限模块定义（两级树的父级：模块 → 操作列表）。 */
export interface PermissionModuleDef {
  moduleKey: string;
  moduleLabel: string;
  scope: PermissionScope;
  sortOrder: number;
  /** 该模块下的全部操作权限码。 */
  operations: PermissionCodeDef[];
}

/**
 * 模块构建 helper：把扁平 (moduleKey, moduleLabel, sortOrder, [operations]) 合并为两级结构 + 同步填充每个 def 的 moduleKey/moduleLabel/moduleOrder/group。
 * operations 入参为简化定义（不含 moduleKey/moduleLabel/moduleOrder/group，由本函数回填）。
 */
function defineModule(
  scope: PermissionScope,
  moduleKey: string,
  moduleLabel: string,
  sortOrder: number,
  ops: Array<{ code: string; label: string; description: string }>,
): PermissionModuleDef {
  const operations: PermissionCodeDef[] = ops.map((op) => ({
    code: op.code,
    label: op.label,
    scope,
    group: moduleKey,
    moduleKey,
    moduleLabel,
    moduleOrder: sortOrder,
    description: op.description,
  }));
  return { moduleKey, moduleLabel, scope, sortOrder, operations };
}

// ============ 平台级权限（scope=PLATFORM）============
// 管平台全局资源：用户、团队、插件市场审核、申请、LLM 网关、版本发布、平台管理员、审计、设置。
export const PLATFORM_MODULES: PermissionModuleDef[] = [
  defineModule('PLATFORM', 'platform.dashboard', '仪表盘', 10, [
    { code: 'platform.dashboard.view', label: '查看仪表盘', description: '查看平台运营仪表盘与统计概览' },
  ]),
  defineModule('PLATFORM', 'platform.user', '用户管理', 20, [
    { code: 'platform.user.list', label: '查看用户', description: '查看平台用户列表与详情' },
    { code: 'platform.user.create', label: '创建用户', description: '由平台管理员创建新用户账号' },
    { code: 'platform.user.update_profile', label: '编辑用户资料', description: '编辑用户资料（不含密码）' },
    { code: 'platform.user.reset_password', label: '重置用户密码', description: '管理员强制重置用户密码' },
    { code: 'platform.user.disable', label: '禁用用户', description: '禁用/删除用户账号' },
    { code: 'platform.user.role.assign', label: '分配平台角色', description: '为用户分配/撤销平台级角色' },
  ]),
  defineModule('PLATFORM', 'platform.team', '团队管理', 30, [
    { code: 'platform.team.list', label: '查看团队', description: '查看平台所有团队列表与详情' },
    { code: 'platform.team.create', label: '创建团队', description: '由平台管理员创建团队' },
    { code: 'platform.team.update', label: '编辑团队', description: '编辑团队资料' },
    { code: 'platform.team.suspend', label: '停用团队', description: '挂起/删除团队' },
    { code: 'platform.team.adjust_balance', label: '调整团队余额', description: '为团队加款/扣款' },
    { code: 'platform.team.set_admin', label: '指定团队管理员', description: '为团队任命/撤销团队管理员' },
    { code: 'platform.team.member.role', label: '管理团队成员角色', description: '平台管理员调整任意团队成员角色' },
    { code: 'platform.team.role.manage', label: '管理团队角色', description: '平台管理员管理任意团队的自定义角色与权限' },
  ]),
  defineModule('PLATFORM', 'platform.plugin', '插件市场', 40, [
    { code: 'platform.plugin.list_all', label: '查看全部插件', description: '查看平台所有插件（含各团队私有）' },
    { code: 'platform.plugin.review', label: '审核市场插件', description: '审核市场上架申请、批准/拒绝/下架' },
    { code: 'platform.plugin.edit', label: '编辑插件', description: '平台级编辑任意插件元数据/版本/定价/可见性' },
    { code: 'platform.plugin.delete', label: '删除插件', description: '平台级物理删除任意插件（含已上架）' },
  ]),
  defineModule('PLATFORM', 'platform.application', '申请审批', 50, [
    { code: 'platform.application.review', label: '审批团队管理员申请', description: '审批用户提交的开团申请' },
  ]),
  defineModule('PLATFORM', 'platform.llm', '模型服务', 60, [
    { code: 'platform.llm.provider.manage', label: '管理模型服务', description: '管理 LLM 网关目录、激活 provider（旧 BYOK，过渡期保留）' },
  ]),
  // 计费与模型中转（Relay + 灵石）：渠道管理 / 模型定价 / 版本配置 / 灵石账户 / 调用日志。
  // 这些是平台级运营资源，仅平台管理员可操作（团队级灵石查看走 team.credits.view，见下）。
  defineModule('PLATFORM', 'platform.billing', '计费与中转', 62, [
    { code: 'platform.billing.channel.manage', label: '管理渠道', description: '管理上游渠道、范围绑定、优先级/权重、健康测试' },
    { code: 'platform.billing.pricing.manage', label: '管理模型定价', description: '配置每个模型/能力的灵石单价与计费单位' },
    { code: 'platform.billing.tier.manage', label: '管理模型版本', description: '配置快速版/高级版的底层模型与参数' },
    { code: 'platform.billing.credit.adjust', label: '调整团队灵石', description: '为团队灵石账户加款/扣款' },
    { code: 'platform.billing.call_log.view', label: '查看调用日志', description: '查看全平台 AI 调用日志（多维度查询）' },
  ]),
  defineModule('PLATFORM', 'platform.release', '版本发布', 70, [
    { code: 'platform.release.manage', label: '管理版本发布', description: '发布/归档应用版本、上传产物' },
  ]),
  defineModule('PLATFORM', 'platform.ticket', '工单反馈', 75, [
    { code: 'platform.ticket.view', label: '查看工单', description: '查看用户提交的帮助与反馈工单及附件' },
    { code: 'platform.ticket.manage', label: '处理工单', description: '回复工单、变更状态与优先级' },
  ]),
  defineModule('PLATFORM', 'platform.admin', '平台管理员', 80, [
    { code: 'platform.admin.manage', label: '管理平台管理员', description: '任命/撤销平台管理员' },
  ]),
  defineModule('PLATFORM', 'platform.role', '平台角色', 90, [
    { code: 'platform.role.manage', label: '管理平台角色', description: '创建/编辑平台级自定义角色与权限分配' },
  ]),
  defineModule('PLATFORM', 'platform.audit', '审计日志', 100, [
    { code: 'platform.audit.view', label: '查看审计日志', description: '查看平台审计日志' },
  ]),
  defineModule('PLATFORM', 'platform.setting', '平台设置', 110, [
    { code: 'platform.setting.manage', label: '管理平台设置', description: '编辑平台设置（SMTP/极验/Gitee/平台信息）' },
  ]),
];

// ============ 团队级权限（scope=TEAM）============
// 管团队内资源：成员、角色、插件（含授权）、余额、邀请码、资料。
export const TEAM_MODULES: PermissionModuleDef[] = [
  defineModule('TEAM', 'team.dashboard', '团队概览', 10, [
    { code: 'team.dashboard.view', label: '查看团队概览', description: '查看本团队信息、余额、成员数概览' },
  ]),
  defineModule('TEAM', 'team.member', '成员管理', 20, [
    { code: 'team.member.list', label: '查看团队成员', description: '查看本团队成员列表' },
    { code: 'team.member.invite', label: '邀请成员', description: '生成/管理团队邀请码' },
    { code: 'team.member.remove', label: '移除成员', description: '将成员移出团队' },
    { code: 'team.member.role.assign', label: '分配成员角色', description: '为本团队成员分配/更换团队角色' },
  ]),
  defineModule('TEAM', 'team.role', '团队角色', 30, [
    { code: 'team.role.create', label: '创建团队角色', description: '为本团队创建自定义角色' },
    { code: 'team.role.update', label: '编辑团队角色', description: '编辑本团队自定义角色与权限' },
    { code: 'team.role.delete', label: '删除团队角色', description: '删除本团队自定义角色' },
  ]),
  defineModule('TEAM', 'team.plugin', '插件管理', 40, [
    { code: 'team.plugin.list', label: '查看团队插件', description: '查看本团队可用插件列表' },
    { code: 'team.plugin.upload', label: '上传插件', description: '为本团队上传新插件' },
    { code: 'team.plugin.edit_metadata', label: '编辑插件元数据', description: '编辑插件名称/描述/图标，不重置审核态、不改源码' },
    { code: 'team.plugin.edit_draft', label: '编辑插件草稿', description: '重新上传/编辑已上传插件的草稿包' },
    { code: 'team.plugin.edit_price', label: '设置插件定价', description: '设置插件定价，不改源码、不触发审核流程' },
    { code: 'team.plugin.delete', label: '删除插件', description: '删除本团队插件' },
    { code: 'team.plugin.install', label: '安装市场插件', description: '将市场插件安装到本团队' },
    { code: 'team.plugin.enable', label: '启用/禁用插件', description: '启用/禁用本团队已安装插件' },
    { code: 'team.plugin.submit_marketplace', label: '提交市场上架', description: '将本团队插件提交到市场审核' },
  ]),
  defineModule('TEAM', 'team.plugin.grant', '插件授权', 50, [
    { code: 'team.plugin.grant.manage', label: '管理插件授权', description: '为本团队插件按用户/角色设置 allow/deny' },
  ]),
  defineModule('TEAM', 'team.balance', '团队余额', 60, [
    { code: 'team.balance.view', label: '查看团队余额', description: '查看本团队余额与流水（人民币·市场）' },
    { code: 'team.balance.consume', label: '消耗团队余额', description: '调用消耗团队余额的接口' },
  ]),
  // 计费/中转 · 团队灵石（AI 用量计费货币，独立于人民币余额）。普通成员可查；调整仅平台 Admin。
  defineModule('TEAM', 'team.credits', '团队灵石', 62, [
    { code: 'team.credits.view', label: '查看团队灵石', description: '查看本团队灵石余额与流水（AI 用量计费）' },
  ]),
  defineModule('TEAM', 'team.profile', '团队资料', 70, [
    { code: 'team.profile.update', label: '编辑团队资料', description: '编辑本团队名称、简介、公开加入开关' },
  ]),
];

// ============ 向下兼容扁平导出（旧代码消费 PermissionCodeDef[]）============

/** 全部权限模块（平台 + 团队）。 */
export const ALL_MODULES: PermissionModuleDef[] = [...PLATFORM_MODULES, ...TEAM_MODULES];

/** 全部权限码定义（平台 + 团队，扁平）。seed 时全量 upsert 到 PermissionEntry 表。 */
export const ALL_PERMISSIONS: PermissionCodeDef[] = ALL_MODULES.flatMap((m) => m.operations);

/** 平台级权限码（扁平）。 */
export const PLATFORM_PERMISSIONS: PermissionCodeDef[] = PLATFORM_MODULES.flatMap((m) => m.operations);

/** 团队级权限码（扁平）。 */
export const TEAM_PERMISSIONS: PermissionCodeDef[] = TEAM_MODULES.flatMap((m) => m.operations);

/** 权限码白名单集合（授权检查/角色权限写入时校验 code 合法性）。 */
export const PERMISSION_CODE_SET: Set<string> = new Set(ALL_PERMISSIONS.map((p) => p.code));

/** 按 scope 过滤的权限码集合，供角色编辑页只展示本 scope 可选权限。 */
export function permissionCodesByScope(scope: PermissionScope): PermissionCodeDef[] {
  return ALL_PERMISSIONS.filter((p) => p.scope === scope);
}

/** 按 scope 过滤的权限模块（两级结构，前端勾选树数据源）。 */
export function permissionModulesByScope(scope: PermissionScope): PermissionModuleDef[] {
  return ALL_MODULES.filter((m) => m.scope === scope);
}

/**
 * 内置权限分组（seed 写 PermissionGroup 表用）。
 * 每条 = 一个内置模块的显示名覆盖基线，isSystem=true。
 */
export const BUILTIN_PERMISSION_GROUPS: Array<{
  scope: PermissionScope;
  groupKey: string;
  displayName: string;
  sortOrder: number;
}> = ALL_MODULES.map((m) => ({
  scope: m.scope,
  groupKey: m.moduleKey,
  displayName: m.moduleLabel,
  sortOrder: m.sortOrder,
}));

/** 判断权限码是否属于平台级。 */
export function isPlatformPermission(code: string): boolean {
  return code.startsWith('platform.');
}

/** 判断权限码是否属于团队级。 */
export function isTeamPermission(code: string): boolean {
  return code.startsWith('team.');
}

/**
 * 旧权限码 → 新码集合的扩张映射（单一事实来源，供 seed 迁移使用）。
 *
 * 设计：4 个「敏感度混合」旧码被拆细。迁移时把命中旧码的角色权限「展开」为对应新码集合（去重），
 * 其余权限码保留。这样新权限守卫（挂在更细的新码上）不会因旧角色丢权限——旧角色原本拥有的能力被新码完整覆盖。
 *
 * 注意：只扩张、不收缩。映射是单向的（旧→新），不定义反向（新→旧合并会有损）。
 */
export const LEGACY_PERMISSION_EXPANSION: Record<string, string[]> = {
  'team.plugin.edit': ['team.plugin.edit_metadata', 'team.plugin.edit_draft', 'team.plugin.edit_price'],
  'platform.user.update': ['platform.user.update_profile', 'platform.user.reset_password'],
  'team.role.manage': ['team.role.create', 'team.role.update', 'team.role.delete'],
  'platform.plugin.manage': ['platform.plugin.edit', 'platform.plugin.delete'],
};

/** 旧权限码集合（快速判断某码是否已废弃，需扩张）。 */
export const LEGACY_PERMISSION_CODES: Set<string> = new Set(Object.keys(LEGACY_PERMISSION_EXPANSION));

/** Permissions retired with external relay-key access. They must never survive in custom roles. */
export const RETIRED_PERMISSION_CODES = new Set([
  'team.api_key.manage',
  'platform.billing.api_key.manage',
  'platform.billing.relay_docs.view',
]);

export function stripRetiredPermissions(current: readonly string[]): { permissions: string[]; changed: boolean } {
  const permissions = current.filter((code) => !RETIRED_PERMISSION_CODES.has(code));
  return { permissions, changed: permissions.length !== current.length };
}

/**
 * 把一个角色的当前权限码数组按 LEGACY_PERMISSION_EXPANSION 扩张为新码集合（幂等纯函数）。
 *
 * 算法：遍历 current，命中旧码则展开为对应新码集合，其余码原样保留；去重。
 * 返回 { permissions: 新数组, changed: 是否发生变更 }。
 *  - 幂等：current 已无旧码时 changed=false（调用方据此跳过 update）。
 *
 * 抽离为纯函数供单测构造 fixture 直接断言扩张正确性 + 二次跑 no-op，无需 mock Prisma。
 */
export function expandLegacyPermissions(current: string[]): { permissions: string[]; changed: boolean } {
  let changed = false;
  const expanded = new Set<string>();
  for (const code of current) {
    if (LEGACY_PERMISSION_CODES.has(code)) {
      const target = LEGACY_PERMISSION_EXPANSION[code];
      if (target) {
        for (const c of target) expanded.add(c);
        changed = true;
      }
    } else {
      expanded.add(code);
    }
  }
  return { permissions: [...expanded], changed };
}

// === 内置系统角色 id（与 migration 20260621190000 + seed-rbac.ts 一致的确定性占位）===
// 凡是写 platformRole='PLATFORM_ADMIN' 的地方，必须同步写 platformRoleId=SYSTEM_PLATFORM_ADMIN_ROLE_ID，
// 否则新权限守卫解析不到平台角色权限，旧平台管理员会被锁死（迁移期双写一致性要求）。

/** 系统平台管理员角色 id（migration 固定占位，seed-rbac upsert 同一 id）。 */
export const SYSTEM_PLATFORM_ADMIN_ROLE_ID = '00000000-0000-0000-0000-platform0001';

/** 团队级系统角色 id 拼接前缀（每团队两条：管理员 + 成员）。 */
export const teamAdminRoleId = (teamId: string) => `team-admin-${teamId}`;
export const teamMemberRoleId = (teamId: string) => `team-member-${teamId}`;

// === 内置系统角色 code（与 migration 20260622100000 回填一致）===
// 系统团队管理员检测应基于 code（而非 name 字符串比较，避免脆弱）。
// 凡是创建内置角色的地方（setup、seed-admin、seed-rbac、管理端审批事务）必须写对应 code。

/** 系统平台管理员角色 code。 */
export const SYSTEM_PLATFORM_ADMIN_ROLE_CODE = 'platform_admin';

/** 系统团队管理员角色 code。 */
export const SYSTEM_TEAM_ADMIN_ROLE_CODE = 'team_admin';

/** 系统成员角色 code。 */
export const SYSTEM_TEAM_MEMBER_ROLE_CODE = 'team_member';
