import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { forbidden, type AuthUser } from './common';
import { PrismaService } from './prisma.service';

export interface RelayAuth {
  teamId: string;
  userId: string;
}

declare global {
  namespace Express {
    interface Request {
      relayAuth?: RelayAuth;
    }
  }
}

/** Ensures relay billing can only use the exact team signed into the JWT. */
@Injectable()
export class RelayTeamGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user?.teamId) throw forbidden('请先加入团队');

    const membership = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: user.teamId, userId: user.id } },
      include: { team: { select: { status: true } } },
    });
    if (!membership || membership.status !== 'ACTIVE') throw forbidden('当前团队成员关系已失效');
    if (membership.team.status !== 'ACTIVE') throw forbidden('团队当前不可用');

    request.relayAuth = { teamId: user.teamId, userId: user.id };
    return true;
  }
}
