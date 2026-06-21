// RBAC 授权装饰器。
//
// 用法：
//   @RequirePermission('platform.user.list')            // 单权限（命中即放行）
//   @RequirePermission('team.member.invite', 'team.member.remove')  // 多权限 OR 语义
//
// 设计：
//  - 装饰器只写 metadata，实际校验在 PermissionsGuard（src/permissions.guard.ts）。
//  - 与现有 imperative ensureXxx 并存：迁移期旧 service 内部 ensureXxx 仍工作，
//    新 controller 方法挂装饰器；Phase C 迁移完成后逐步替换内部 ensureXxx。
import { SetMetadata } from '@nestjs/common';

/** metadata key：handler/controller 上声明的权限码数组。 */
export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * 声明访问该路由所需权限码（任一命中即放行，OR 语义）。
 *
 * @param codes 权限码，必须来自 permission-codes.ts 注册表。
 */
export const RequirePermission = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);
