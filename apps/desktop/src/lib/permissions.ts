// RBAC 前端权限判断 helper。
// session.permissions 由后端 sessionFor 注入（平台 + 团队角色权限码合并）。
// 前端入口门控统一用这些 helper，替代旧 session.role === 'TEAM_ADMIN' 枚举判定。

/** 判断当前权限集是否拥有指定权限码（任一命中即 true，OR 语义）。 */
export function hasPermission(permissions: string[], ...codes: string[]): boolean {
  if (codes.length === 0) return false;
  return codes.some((code) => permissions.includes(code));
}

/** 判断是否拥有任意团队管理权限（用于「团队管理」入口门控）。
 *  排除三个基线只读权限（dashboard.view/plugin.list/balance.view），只有管理类权限才算团队管理员。 */
const TEAM_BASELINE_READONLY = new Set([
  'team.dashboard.view',
  'team.plugin.list',
  'team.balance.view',
]);
export function isTeamManager(permissions: string[]): boolean {
  return permissions.some((p) => p.startsWith('team.') && !TEAM_BASELINE_READONLY.has(p));
}

/** 判断是否拥有任意平台权限（用于平台管理相关入口门控）。 */
export function isPlatformManager(permissions: string[]): boolean {
  return permissions.some((p) => p.startsWith('platform.'));
}
