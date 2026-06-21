// 权限码注册表（单一事实来源）。
//
// 设计要点：
//  - 权限码为预定义字符串（dot.notation，形如 "team.member.invite"），不可由用户自由新增。
//  - 分两层 scope：PLATFORM（平台级，管平台资源）/ TEAM（团队级，管团队内资源）。
//  - 此文件是后端授权检查 + seed PermissionEntry 表 + 前端 admin 勾选面板的共同来源。
//  - 新增操作时：先在此注册码 → seed 到 PermissionEntry 表 → 在对应 controller 方法挂 @RequirePermission。
//
// 命名约定：<scope>.<resource>.<action>（如 platform.user.create、team.plugin.install）。
// group 字段用于前端按分组渲染勾选树（取 <scope>.<resource> 前缀）。

export type PermissionScope = 'PLATFORM' | 'TEAM';

export interface PermissionCodeDef {
  code: string;
  label: string;
  scope: PermissionScope;
  /** 分组键，前端按 group 折叠展示。通常取 code 去掉最后一段 action。 */
  group: string;
  description: string;
}

// —— 平台级权限（scope=PLATFORM）——
// 管平台全局资源：用户、团队、插件市场审核、申请、LLM 网关、版本发布、平台管理员、审计、设置。
export const PLATFORM_PERMISSIONS: PermissionCodeDef[] = [
  // dashboard
  { code: 'platform.dashboard.view', label: '查看仪表盘', scope: 'PLATFORM', group: 'platform.dashboard', description: '查看平台运营仪表盘与统计概览' },
  // user
  { code: 'platform.user.list', label: '查看用户', scope: 'PLATFORM', group: 'platform.user', description: '查看平台用户列表与详情' },
  { code: 'platform.user.create', label: '创建用户', scope: 'PLATFORM', group: 'platform.user', description: '由平台管理员创建新用户账号' },
  { code: 'platform.user.update', label: '编辑用户', scope: 'PLATFORM', group: 'platform.user', description: '编辑用户资料、重置密码' },
  { code: 'platform.user.disable', label: '禁用用户', scope: 'PLATFORM', group: 'platform.user', description: '禁用/删除用户账号' },
  { code: 'platform.user.role.assign', label: '分配平台角色', scope: 'PLATFORM', group: 'platform.user', description: '为用户分配/撤销平台级角色' },
  // team
  { code: 'platform.team.list', label: '查看团队', scope: 'PLATFORM', group: 'platform.team', description: '查看平台所有团队列表与详情' },
  { code: 'platform.team.create', label: '创建团队', scope: 'PLATFORM', group: 'platform.team', description: '由平台管理员创建团队' },
  { code: 'platform.team.update', label: '编辑团队', scope: 'PLATFORM', group: 'platform.team', description: '编辑团队资料' },
  { code: 'platform.team.suspend', label: '停用团队', scope: 'PLATFORM', group: 'platform.team', description: '挂起/删除团队' },
  { code: 'platform.team.adjust_balance', label: '调整团队余额', scope: 'PLATFORM', group: 'platform.team', description: '为团队加款/扣款' },
  { code: 'platform.team.set_admin', label: '指定团队管理员', scope: 'PLATFORM', group: 'platform.team', description: '为团队任命/撤销团队管理员' },
  { code: 'platform.team.member.role', label: '管理团队成员角色', scope: 'PLATFORM', group: 'platform.team', description: '平台管理员调整任意团队成员角色' },
  // plugin (marketplace governance)
  { code: 'platform.plugin.list_all', label: '查看全部插件', scope: 'PLATFORM', group: 'platform.plugin', description: '查看平台所有插件（含各团队私有）' },
  { code: 'platform.plugin.review', label: '审核市场插件', scope: 'PLATFORM', group: 'platform.plugin', description: '审核市场上架申请、批准/拒绝/下架' },
  { code: 'platform.plugin.manage', label: '管理插件', scope: 'PLATFORM', group: 'platform.plugin', description: '平台级编辑/删除任意插件' },
  // application
  { code: 'platform.application.review', label: '审批团队管理员申请', scope: 'PLATFORM', group: 'platform.application', description: '审批用户提交的开团申请' },
  // llm provider
  { code: 'platform.llm.provider.manage', label: '管理模型服务', scope: 'PLATFORM', group: 'platform.llm', description: '管理 LLM 网关目录、激活 provider' },
  // release
  { code: 'platform.release.manage', label: '管理版本发布', scope: 'PLATFORM', group: 'platform.release', description: '发布/归档应用版本、上传产物' },
  // platform admin & role
  { code: 'platform.admin.manage', label: '管理平台管理员', scope: 'PLATFORM', group: 'platform.admin', description: '任命/撤销平台管理员' },
  { code: 'platform.role.manage', label: '管理平台角色', scope: 'PLATFORM', group: 'platform.role', description: '创建/编辑平台级自定义角色与权限分配' },
  // audit & setting
  { code: 'platform.audit.view', label: '查看审计日志', scope: 'PLATFORM', group: 'platform.audit', description: '查看平台审计日志' },
  { code: 'platform.setting.manage', label: '管理平台设置', scope: 'PLATFORM', group: 'platform.setting', description: '编辑平台设置（SMTP/极验/Gitee/平台信息）' },
];

// —— 团队级权限（scope=TEAM）——
// 管团队内资源：成员、角色、插件（含授权）、余额、邀请码、资料。
export const TEAM_PERMISSIONS: PermissionCodeDef[] = [
  // dashboard
  { code: 'team.dashboard.view', label: '查看团队概览', scope: 'TEAM', group: 'team.dashboard', description: '查看本团队信息、余额、成员数概览' },
  // member
  { code: 'team.member.list', label: '查看团队成员', scope: 'TEAM', group: 'team.member', description: '查看本团队成员列表' },
  { code: 'team.member.invite', label: '邀请成员', scope: 'TEAM', group: 'team.member', description: '生成/管理团队邀请码' },
  { code: 'team.member.remove', label: '移除成员', scope: 'TEAM', group: 'team.member', description: '将成员移出团队' },
  { code: 'team.member.role.assign', label: '分配成员角色', scope: 'TEAM', group: 'team.member', description: '为本团队成员分配/更换团队角色' },
  // role
  { code: 'team.role.manage', label: '管理团队角色', scope: 'TEAM', group: 'team.role', description: '创建/编辑本团队自定义角色与权限' },
  // plugin
  { code: 'team.plugin.list', label: '查看团队插件', scope: 'TEAM', group: 'team.plugin', description: '查看本团队可用插件列表' },
  { code: 'team.plugin.upload', label: '上传插件', scope: 'TEAM', group: 'team.plugin', description: '为本团队上传新插件' },
  { code: 'team.plugin.edit', label: '编辑插件', scope: 'TEAM', group: 'team.plugin', description: '编辑本团队插件元数据/草稿/价格' },
  { code: 'team.plugin.delete', label: '删除插件', scope: 'TEAM', group: 'team.plugin', description: '删除本团队插件' },
  { code: 'team.plugin.install', label: '安装市场插件', scope: 'TEAM', group: 'team.plugin', description: '将市场插件安装到本团队' },
  { code: 'team.plugin.enable', label: '启用/禁用插件', scope: 'TEAM', group: 'team.plugin', description: '启用/禁用本团队已安装插件' },
  { code: 'team.plugin.submit_marketplace', label: '提交市场上架', scope: 'TEAM', group: 'team.plugin', description: '将本团队插件提交到市场审核' },
  // plugin grant
  { code: 'team.plugin.grant.manage', label: '管理插件授权', scope: 'TEAM', group: 'team.plugin.grant', description: '为本团队插件按用户/角色设置 allow/deny' },
  // balance
  { code: 'team.balance.view', label: '查看团队余额', scope: 'TEAM', group: 'team.balance', description: '查看本团队余额与流水' },
  { code: 'team.balance.consume', label: '消耗团队余额', scope: 'TEAM', group: 'team.balance', description: '调用消耗团队余额的接口' },
  // profile
  { code: 'team.profile.update', label: '编辑团队资料', scope: 'TEAM', group: 'team.profile', description: '编辑本团队名称、简介、公开加入开关' },
];

/** 全部权限码定义（平台 + 团队）。seed 时全量 upsert 到 PermissionEntry 表。 */
export const ALL_PERMISSIONS: PermissionCodeDef[] = [...PLATFORM_PERMISSIONS, ...TEAM_PERMISSIONS];

/** 权限码白名单集合（授权检查/角色权限写入时校验 code 合法性）。 */
export const PERMISSION_CODE_SET: Set<string> = new Set(ALL_PERMISSIONS.map((p) => p.code));

/** 按.scope 过滤的权限码集合，供角色编辑页只展示本 scope 可选权限。 */
export function permissionCodesByScope(scope: PermissionScope): PermissionCodeDef[] {
  return ALL_PERMISSIONS.filter((p) => p.scope === scope);
}

/** 判断权限码是否属于平台级。 */
export function isPlatformPermission(code: string): boolean {
  return code.startsWith('platform.');
}

/** 判断权限码是否属于团队级。 */
export function isTeamPermission(code: string): boolean {
  return code.startsWith('team.');
}
