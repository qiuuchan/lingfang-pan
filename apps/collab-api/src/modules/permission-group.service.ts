import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { badRequest, forbidden, notFound } from '../common';
import { AuthService } from './auth.service';
import { BUILTIN_PERMISSION_GROUPS, type PermissionScope } from './permissions/permission-codes';

/**
 * 权限分组显示名管理。
 *
 * 权限码本身不可由用户自由增删（permission-codes.ts 注册表为准），
 * 但每个 moduleKey 的「显示名」可由管理员自定义覆盖（如把「插件管理」改成「插件中心」）。
 *
 * 数据模型：PermissionGroup 每行对应一个已注册的内置模块（groupKey 受白名单约束，不允许新增模块）。
 *  - seed 写入内置行（isSystem=true，displayName=内置默认）。
 *  - upsertGroup：管理员改名 → 直接 update 内置行的 displayName（保留 isSystem=true）。
 *  - deleteGroup：「重置为默认」语义 → 把 displayName 恢复成 BUILTIN_PERMISSION_GROUPS 的默认值。
 *  - listGroups：合并内置基线 + DB 行，标注 customized（当前显示名是否偏离默认）。
 *
 * scope 隔离：PLATFORM 分组用 platform.role.manage 守卫；TEAM 分组用 team.role.update 守卫 + 归属当前团队。
 */
@Injectable()
export class PermissionGroupService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  /** 列出某 scope 的全部权限分组（内置基线 + DB 覆盖合并，标注 customized）。 */
  async listGroups(userId: string, scope: PermissionScope) {
    await this.ensureManagePermission(scope, userId);
    if (scope === 'TEAM') await this.resolveCurrentTeam(userId);

    const builtin = BUILTIN_PERMISSION_GROUPS.filter((g) => g.scope === scope);
    const rows = await this.prisma.permissionGroup.findMany({
      where: { scope },
      orderBy: { sortOrder: 'asc' },
    });
    const rowByGroupKey = new Map(rows.map((r) => [r.groupKey, r]));
    const merged = builtin.map((b) => {
      const row = rowByGroupKey.get(b.groupKey);
      const displayName = row?.displayName ?? b.displayName;
      return {
        scope: b.scope,
        groupKey: b.groupKey,
        displayName,
        sortOrder: row?.sortOrder ?? b.sortOrder,
        isSystem: true, // 分组（moduleKey）恒为内置：不可删除模块本身，仅可改名
        customized: !!row && row.displayName !== b.displayName,
      };
    });
    return { groups: merged };
  }

  /** upsert 权限分组显示名（管理员改名）。groupKey 必须是已注册的 moduleKey。 */
  async upsertGroup(
    userId: string,
    scope: PermissionScope,
    input: { groupKey: string; displayName: string }
  ) {
    await this.ensureManagePermission(scope, userId);
    if (scope === 'TEAM') await this.resolveCurrentTeam(userId);
    const builtin = this.assertGroupKeyRegistered(scope, input.groupKey);

    const row = await this.prisma.permissionGroup.upsert({
      where: { scope_groupKey: { scope, groupKey: input.groupKey } },
      update: { displayName: input.displayName },
      create: {
        scope,
        groupKey: input.groupKey,
        displayName: input.displayName,
        isSystem: true,
        sortOrder: builtin.sortOrder,
      },
    });
    await this.audit(
      userId,
      'permission_group.upserted',
      'PermissionGroup',
      `${scope}:${input.groupKey}`,
      {
        scope,
        groupKey: input.groupKey,
        displayName: input.displayName,
      }
    );
    return {
      group: {
        scope: row.scope,
        groupKey: row.groupKey,
        displayName: row.displayName,
        sortOrder: row.sortOrder,
        isSystem: row.isSystem,
      },
    };
  }

  /** 重置分组显示名为内置默认（「删除自定义覆盖」语义）。 */
  async deleteGroup(userId: string, scope: PermissionScope, groupKey: string) {
    await this.ensureManagePermission(scope, userId);
    if (scope === 'TEAM') await this.resolveCurrentTeam(userId);
    const builtin = this.assertGroupKeyRegistered(scope, groupKey);
    const row = await this.prisma.permissionGroup.findUnique({
      where: { scope_groupKey: { scope, groupKey } },
    });
    if (!row) throw notFound('权限分组尚未自定义，无需重置');
    // 重置为内置默认显示名（保留行，因为内置模块始终存在）
    await this.prisma.permissionGroup.update({
      where: { scope_groupKey: { scope, groupKey } },
      data: { displayName: builtin.displayName },
    });
    await this.audit(userId, 'permission_group.reset', 'PermissionGroup', `${scope}:${groupKey}`, {
      scope,
      groupKey,
      resetTo: builtin.displayName,
    });
    return { ok: true };
  }

  // ============ 内部 helper ============

  /** 校验 groupKey 是已注册的内置 moduleKey（不允许凭空新增模块），返回内置定义。 */
  private assertGroupKeyRegistered(scope: PermissionScope, groupKey: string) {
    const builtin = BUILTIN_PERMISSION_GROUPS.find(
      (g) => g.scope === scope && g.groupKey === groupKey
    );
    if (!builtin) throw badRequest(`未知的权限分组键：${groupKey}（不允许新增模块）`);
    return builtin;
  }

  /** 按 scope 选择管理权限码并校验。 */
  private async ensureManagePermission(scope: PermissionScope, userId: string) {
    const code = scope === 'PLATFORM' ? 'platform.role.manage' : 'team.role.update';
    await this.auth.ensurePermission(userId, code);
  }

  /** 解析当前团队 membership（与 role.service 同款：ACTIVE + team ACTIVE）。 */
  private async resolveCurrentTeam(userId: string) {
    const membership = await this.prisma.teamMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { team: { select: { status: true } } },
      orderBy: { joinedAt: 'desc' },
    });
    if (!membership) throw forbidden('请先加入团队');
    if (membership.team.status !== 'ACTIVE') throw forbidden('团队当前不可用');
    return membership;
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: unknown
  ) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType, targetId, metadata: metadata as object },
    });
  }
}
