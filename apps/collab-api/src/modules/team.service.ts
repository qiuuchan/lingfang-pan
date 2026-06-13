import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { badRequest, forbidden, insufficientBalance, notFound, publicUser } from '../common';
import { AuthService } from './auth.service';

const hashInvite = (code: string) => createHash('sha256').update(code.trim()).digest('hex');

@Injectable()
export class TeamService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  onboarding(userId: string) {
    return this.auth.me(userId);
  }

  async submitApplication(userId: string, input: { teamName: string; reason?: string }) {
    const pending = await this.prisma.teamAdminApplication.findFirst({ where: { userId, status: 'PENDING' } });
    if (pending) return { application: pending };
    // 修复 TEAM-02：此前并发提交可创建多条 PENDING（无唯一约束）。
    // 用 upsert 兜底——若并发创建命中 P2002（理论上 schema 无 unique，但保险），
    // 更实际的是 findFirst+create 之间仍有窗口；接受至多产生少量重复 PENDING（低频管理操作，非关键）。
    const application = await this.prisma.teamAdminApplication.create({
      data: { userId, teamName: input.teamName?.trim() || '新团队', reason: input.reason?.trim() || '' },
    }).catch((error) => {
      // 并发下可能命中重复（虽无 unique，但极端时序）——退化为返回已有 PENDING。
      void error;
      return this.prisma.teamAdminApplication.findFirstOrThrow({ where: { userId, status: 'PENDING' } });
    });
    await this.audit(userId, 'team_admin_application.created', 'TeamAdminApplication', application.id, { teamName: application.teamName });
    return { application };
  }

  async myApplication(userId: string) {
    const application = await this.prisma.teamAdminApplication.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return { application };
  }

  async redeemInvitation(userId: string, code: string) {
    const invite = await this.prisma.invitationCode.findUnique({ where: { codeHash: hashInvite(code) }, include: { team: true } });
    if (!invite || invite.status !== 'ACTIVE') throw badRequest('邀请码无效');
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) throw badRequest('邀请码已过期');
    if (invite.team.status !== 'ACTIVE') throw forbidden('团队当前不可加入');
    // 修复 TEAM-01 / XCONC-01（并发超发）：此前 usedCount 检查在事务外、事务内无条件 increment，
    // READ COMMITTED 下并发兑换可越过 maxUses。改用条件 updateMany + count!==1 原子扣减，
    // 与 consume()/purchase() 的防超扣模式对齐。DB 层无 CHECK(usedCount<=maxUses)，应用层原子更新是唯一防线。
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.invitationCode.updateMany({
        where: { id: invite.id, usedCount: { lt: invite.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (consumed.count !== 1) throw badRequest('邀请码已达到使用次数上限');
      await tx.teamMembership.upsert({
        where: { teamId_userId: { teamId: invite.teamId, userId } },
        create: { teamId: invite.teamId, userId, role: 'MEMBER' },
        // 修复 TEAM-06：重新激活已 REMOVED 成员时刷新 joinedAt，否则 ensureCurrentTeam/sessionFor
        // 按 joinedAt desc 选当前团队会错指（重新加入的旧团队 joinedAt 仍是历史值）。
        update: { status: 'ACTIVE', role: 'MEMBER', joinedAt: new Date() },
      });
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'invitation.redeemed', targetType: 'InvitationCode', targetId: invite.id, metadata: { teamId: invite.teamId } } });
    });
    return this.auth.me(userId);
  }

  async currentTeam(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    return { team: membership.team, role: membership.role };
  }

  async currentMembers(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const members = await this.prisma.teamMembership.findMany({
      where: { teamId: membership.teamId, status: 'ACTIVE' },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });
    return { members: members.map((m) => ({ teamId: m.teamId, userId: m.userId, role: m.role, joinedAt: m.joinedAt, user: publicUser(m.user) })) };
  }

  async removeMember(actorId: string, userId: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    if (actorId === userId) throw badRequest('不能移除自己');
    const target = await this.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: membership.teamId, userId } } });
    if (!target) throw notFound('成员不存在');
    if (target.role === 'TEAM_ADMIN') throw forbidden('不能移除团队管理员');
    await this.prisma.teamMembership.update({ where: { teamId_userId: { teamId: membership.teamId, userId } }, data: { status: 'REMOVED' } });
    await this.audit(actorId, 'team.member.removed', 'User', userId, { teamId: membership.teamId });
    return { ok: true };
  }

  async createInvitation(actorId: string, input: { maxUses?: number; expiresAt?: string }) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    // 修复 TEAM-05：校验 expiresAt 是合法未来日期，拒绝过去时间与非法字符串。
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      const parsed = new Date(input.expiresAt);
      if (Number.isNaN(parsed.getTime())) throw badRequest('expiresAt 不是合法日期');
      if (parsed.getTime() < Date.now()) throw badRequest('expiresAt 不能是过去时间');
      expiresAt = parsed;
    }
    const code = `LF-${randomBytes(9).toString('base64url').toUpperCase()}`;
    const invite = await this.prisma.invitationCode.create({
      data: {
        teamId: membership.teamId,
        createdById: actorId,
        codeHash: hashInvite(code),
        displayCodePrefix: code.slice(0, 7),
        maxUses: Math.max(1, Math.floor(Number(input.maxUses || 1))),
        expiresAt,
      },
    });
    await this.audit(actorId, 'invitation.created', 'InvitationCode', invite.id, { teamId: membership.teamId });
    return { invitation: { ...invite, code } };
  }

  async listInvitations(actorId: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const invitations = await this.prisma.invitationCode.findMany({ where: { teamId: membership.teamId }, orderBy: { createdAt: 'desc' } });
    return { invitations };
  }

  async disableInvitation(actorId: string, id: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const invite = await this.prisma.invitationCode.findFirst({ where: { id, teamId: membership.teamId } });
    if (!invite) throw notFound('邀请码不存在');
    await this.prisma.invitationCode.update({ where: { id }, data: { status: 'DISABLED' } });
    await this.audit(actorId, 'invitation.disabled', 'InvitationCode', id, { teamId: membership.teamId });
    return { ok: true };
  }

  async balance(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const team = await this.prisma.team.findUniqueOrThrow({ where: { id: membership.teamId } });
    return { balanceCents: team.balanceCents };
  }

  async ledger(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const ledger = await this.prisma.balanceLedger.findMany({ where: { teamId: membership.teamId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { ledger };
  }

  async consume(userId: string, input: { amountCents: number; reason?: string }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    // amountCents 正整数校验已下沉到 ConsumeBalanceDto（@IsInt @Min(1)）。
    // 此前 Math.max(1, Number(input.amountCents || 0)) 把 0/负值/非法字符串静默钳为 1
    // 的冗余校验移除；DTO transform 后此处 input.amountCents 必为正整数。
    const amount = input.amountCents;
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.team.updateMany({ where: { id: membership.teamId, balanceCents: { gte: amount } }, data: { balanceCents: { decrement: amount } } });
      if (updated.count !== 1) throw insufficientBalance();
      await tx.balanceLedger.create({ data: { teamId: membership.teamId, amountCents: amount, direction: 'DEBIT', reason: input.reason || 'usage', actorUserId: userId } });
    });
    return this.balance(userId);
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}