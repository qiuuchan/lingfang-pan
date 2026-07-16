import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AuthService } from '../auth.service';

@Injectable()
export class WebSessionService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async login(email: string, password: string) {
    const session = await this.auth.login({ email, password });
    const token = session.token;
    if (!token) throw new Error('Web 登录未能签发会话');
    return { token, session: withoutToken(session) };
  }

  current(userId: string, teamId: string | null) {
    return this.auth.webSession(userId, teamId, false);
  }

  async teams(userId: string) {
    const memberships = await this.prisma.teamMembership.findMany({
      where: { userId, status: 'ACTIVE', team: { status: 'ACTIVE' } },
      select: { role: true, teamRoleId: true, team: { select: { id: true, name: true, slug: true } } },
      orderBy: { joinedAt: 'desc' },
    });
    return { teams: memberships.map((membership) => ({ ...membership.team, role: membership.role, teamRoleId: membership.teamRoleId })) };
  }

  async switchTeam(userId: string, teamId: string) {
    const session = await this.auth.switchWebTeam(userId, teamId);
    const token = session.token;
    if (!token) throw new Error('团队切换未能签发会话');
    return { token, session: withoutToken(session) };
  }
}

function withoutToken<T extends { token?: string }>(session: T): Omit<T, 'token'> {
  const { token: _token, ...safe } = session;
  return safe;
}
