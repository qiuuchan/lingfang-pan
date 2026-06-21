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
    { code: 'platform.user.update', label: '编辑用户', description: '编辑用户资料、重置密码' },
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
  ]),
  defineModule('PLATFORM', 'platform.plugin', '插件市场', 40, [
    { code: 'platform.plugin.list_all', label: '查看全部插件', description: '查看平台所有插件（含各团队私有）' },
    { code: 'platform.plugin.review', label: '审核市场插件', description: '审核市场上架申请、批准/拒绝/下架' },
    { code: 'platform.plugin.manage', label: '管理插件', description: '平台级编辑/删除任意插件' },
  ]),
  defineModule('PLATFORM', 'platform.application', '申请审批', 50, [
    { code: 'platform.application.review', label: '审批团队管理员申请', description: '审批用户提交的开团申请' },
  ]),
  defineModule('PLATFORM', 'platform.llm', '模型服务', 60, [
    { code: 'platform.llm.provider.manage', label: '管理模型服务', description: '管理 LLM 网关目录、激活 provider' },
  ]),
  defineModule('PLATFORM', 'platform.release', '版本发布', 70, [
    { code: 'platform.release.manage', label: '管理版本发布', description: '发布/归档应用版本、上传产物' },
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
    { code: 'team.role.manage', label: '管理团队角色', description: '创建/编辑本团队自定义角色与权限' },
  ]),
  defineModule('TEAM', 'team.plugin', '插件管理', 40, [
    { code: 'team.plugin.list', label: '查看团队插件', description: '查看本团队可用插件列表' },
    { code: 'team.plugin.upload', label: '上传插件', description: '为本团队上传新插件' },
    { code: 'team.plugin.edit', label: '编辑插件', description: '编辑本团队插件元数据/草稿/价格' },
    { code: 'team.plugin.delete', label: '删除插件', description: '删除本团队插件' },
    { code: 'team.plugin.install', label: '安装市场插件', description: '将市场插件安装到本团队' },
    { code: 'team.plugin.enable', label: '启用/禁用插件', description: '启用/禁用本团队已安装插件' },
    { code: 'team.plugin.submit_marketplace', label: '提交市场上架', description: '将本团队插件提交到市场审核' },
  ]),
  defineModule('TEAM', 'team.plugin.grant', '插件授权', 50, [
    { code: 'team.plugin.grant.manage', label: '管理插件授权', description: '为本团队插件按用户/角色设置 allow/deny' },
  ]),
  defineModule('TEAM', 'team.balance', '团队余额', 60, [
    { code: 'team.balance.view', label: '查看团队余额', description: '查看本团队余额与流水' },
    { code: 'team.balance.consume', label: '消耗团队余额', description: '调用消耗团队余额的接口' },
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
// 凡是创建内置角色的地方（auth.service createTeamForApplication、setup、seed-admin、seed-rbac）必须写对应 code。

/** 系统平台管理员角色 code。 */
export const SYSTEM_PLATFORM_ADMIN_ROLE_CODE = 'platform_admin';

/** 系统团队管理员角色 code。 */
export const SYSTEM_TEAM_ADMIN_ROLE_CODE = 'team_admin';

/** 系统成员角色 code。 */
export const SYSTEM_TEAM_MEMBER_ROLE_CODE = 'team_member';
