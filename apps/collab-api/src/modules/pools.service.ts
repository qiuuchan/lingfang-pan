import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';

/** 团队端资源池服务（获取可用池子）。与 channel.service.ts 中的 PoolService（管理端 CRUD）区分。 */
@Injectable()
export class TeamPoolService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /**
   * 获取当前团队可用的资源池列表（SHARED 共享池 + 本团队的 DEDICATED 专用池）。
   * 供团队设置页面选择默认资源池。
   */
  async getAvailablePools(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const pools = await this.prisma.pool.findMany({
      where: {
        OR: [
          { scope: 'SHARED' },
          { scope: 'DEDICATED', teamId: membership.teamId },
        ],
      },
      select: {
        id: true,
        name: true,
        scope: true,
        description: true,
      },
      orderBy: [{ scope: 'asc' }, { name: 'asc' }],
    });
    return { pools };
  }
}
