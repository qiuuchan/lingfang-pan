import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from './prisma.service';
import { IS_PUBLIC_KEY, forbidden, type AuthUser } from './common';
import { PERMISSIONS_KEY } from './modules/auth.decorators';
import { isPlatformPermission } from './modules/permissions/permission-codes';

/**
 * 缓存在 request 上的已解析权限集合 key（单请求内避免重复查库）。
 * 同一请求多个 guard 实例 / 多次 canActivate 复用同一解析结果。
 */
const RESOLVED_PERMS_KEY = '__resolvedPermissions';

/**
 * RBAC 权限守卫。
 *
 * 解析逻辑：
 *  1. 无 @RequirePermission metadata → 放行（交给 @Public 或无权限要求的路由，由 service 内部自校验）。
 *  2. 取请求声明的权限码，按 scope 分两组：平台级（platform.*）/ 团队级（team.*）。
 *  3. 平台级权限：查 User.platformRoleId → Role.permissions，取并集。
 *  4. 团队级权限：精确解析 JWT teamId 对应的 membership（ACTIVE + team ACTIVE）
 *     → teamRoleId → Role.permissions。
 *  5. OR 语义：声明的任一权限码命中已解析权限集即放行；否则 forbidden()。
 *  6. 请求级缓存：同 request 多次解析复用（permissionSet + resolvedTeamMembership）。
 *
 * 性能：平台角色权限在 JwtAuthGuard 已 select platformRoleId，此处只查一次 Role.permissions；
 * 团队角色需一次 membership + role 查询。低并发平台可接受，后续可加缓存层。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // @Public 路由直接放行（与 JwtAuthGuard 一致语义）
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // 未声明权限要求的路由：放行（向后兼容现有无装饰器路由，由 service 内部 ensureXxx 兜底）
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) throw forbidden('请先登录');

    const requiredSet = new Set(required);
    const platformRequired = [...requiredSet].filter(isPlatformPermission);
    const teamRequired = [...requiredSet].filter((c) => !isPlatformPermission(c));

    const resolved = await this.resolvePermissions(request, user, platformRequired.length > 0, teamRequired.length > 0);

    // OR 语义：任一所求权限码命中即放行
    const hit = required.some((code) => resolved.has(code));
    if (!hit) throw forbidden('权限不足');
    return true;
  }

  /**
   * 解析当前请求用户的全部权限码集合（带请求级缓存）。
   * 当 needPlatform/needTeam 为 false 时跳过对应解析以减少查库。
   */
  private async resolvePermissions(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: any,
    user: AuthUser,
    needPlatform: boolean,
    needTeam: boolean,
  ): Promise<Set<string>> {
    const cached = request[RESOLVED_PERMS_KEY] as { perms: Set<string> } | undefined;
    if (cached) return cached.perms;

    const perms = new Set<string>();

    if (needPlatform && user.platformRoleId) {
      const role = await this.prisma.role.findUnique({
        where: { id: user.platformRoleId },
        select: { permissions: true },
      });
      if (role) for (const code of role.permissions) perms.add(code);
    }

    if (needTeam) {
      const membership = await this.resolveCurrentTeamMembership(user.id, user.teamId);
      // SUSPENDED 团队不解析团队权限（与 AuthService.ensureCurrentTeam 同款拦截语义：TEAM-03 修复）。
      if (membership?.status === 'ACTIVE' && membership.teamRoleId && membership.team.status === 'ACTIVE') {
        const role = await this.prisma.role.findUnique({
          where: { id: membership.teamRoleId },
          select: { permissions: true },
        });
        if (role) for (const code of role.permissions) perms.add(code);
      }
    }

    request[RESOLVED_PERMS_KEY] = { perms };
    return perms;
  }

  /**
   * 精确解析 JWT 绑定团队 membership，且团队须 ACTIVE，否则返回 null。
   * 抽到此处供 guard 自解析，避免与 AuthService 循环依赖。
   */
  private async resolveCurrentTeamMembership(userId: string, teamId: string | null) {
    if (!teamId) return null;
    return this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId } },
      include: { team: { select: { status: true } } },
    });
  }
}
