import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { badRequest, forbidden, insufficientBalance, notFound, publicUser } from '../common';
import { AuthService } from './auth.service';

// 邀请码哈希唯一入口：生成与兑换必须共用同一归一规则。
// 修复 INVITE-CASE：生成时 code 经 toUpperCase() 后哈希（见 createInvitation），库中 codeHash 均为大写规范形。
// 兑换若按用户原始大小写哈希，则小写/混合输入会查无记录、误报"邀请码无效"。
// 故在此统一 trim + toUpperCase 归一：生成侧已大写（哈希不变、存量兼容），兑换侧任意大小写均可匹配。
const INVITE_CODE_PREFIX = 'LF-';
const INVITE_CODE_RANDOM_BYTES = 9;
const INVITE_CODE_RANDOM_CHARS = 12;
const INVITE_CODE_LENGTH = INVITE_CODE_PREFIX.length + INVITE_CODE_RANDOM_CHARS;
const INVITE_DISPLAY_PREFIX_LENGTH = 7;

const normalizeInviteCode = (code: string) => code.trim().toUpperCase();
const hashInvite = (code: string) => createHash('sha256').update(normalizeInviteCode(code)).digest('hex');

function requireCompleteInviteCode(code: string) {
  const normalized = normalizeInviteCode(code);
  if (!normalized.startsWith(INVITE_CODE_PREFIX) || normalized.length < INVITE_CODE_LENGTH) {
    throw badRequest('请输入完整邀请码');
  }
  return normalized;
}

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
    // 修复 H7：此前 .catch 无差别吞掉所有 DB 错误（连接断/字段超长/外键失败）并伪装成
    // 「返回已有 PENDING」，DB 故障被掩盖成 404，且极端时序下可能创建重复 PENDING。
    // schema 无 unique 约束，并发 create 不会触发 P2002，故仅显式兜底 P2002，其余错误正常抛出。
    const application = await this.prisma.teamAdminApplication.create({
      data: { userId, teamName: input.teamName?.trim() || '新团队', reason: input.reason?.trim() || '' },
    }).catch((error) => {
      if (error?.code === 'P2002') {
        // 并发命中唯一约束（理论 schema 无 unique，保险）：退化为返回已有 PENDING。
        return this.prisma.teamAdminApplication.findFirstOrThrow({ where: { userId, status: 'PENDING' } });
      }
      throw error;
    });
    await this.audit(userId, 'team_admin_application.created', 'TeamAdminApplication', application.id, { teamName: application.teamName });
    return { application };
  }

  async myApplication(userId: string) {
    const application = await this.prisma.teamAdminApplication.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return { application };
  }

  async redeemInvitation(userId: string, code: string) {
    const normalizedCode = requireCompleteInviteCode(code);
    const invite = await this.prisma.invitationCode.findUnique({ where: { codeHash: hashInvite(normalizedCode) }, include: { team: true } });
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

  /**
   * 公开团队发现（Top1「注册即孤儿」解法）：列出 allowPublicJoin=true + ACTIVE 的团队。
   * 供未入团/已注册用户在发现页浏览，可一键直接加入（joinPublicTeam）。
   * 仅返回非敏感字段（id/name/description/memberCount），按成员数降序（活跃团队优先），限 50 条。
   * 不需要登录态：用户注册后即可在 onboarding 页看到入口，打破「必须邀请码」冷启动。
   */
  async listPublicTeams() {
    const teams = await this.prisma.team.findMany({
      where: { allowPublicJoin: true, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // 按成员数降序（活跃团队优先），稳定排序兜底 createdAt。
    const sorted = [...teams].sort((a, b) => b._count.memberships - a._count.memberships);
    return {
      teams: sorted.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        description: t.description,
        memberCount: t._count.memberships,
      })),
    };
  }

  /**
   * 公开团队直接加入（无需邀请码、无需审批）：allowPublicJoin=true + ACTIVE 的团队，
   * 用户点击「加入」直接写入 ACTIVE 成员（角色 MEMBER）。
   * 复用 upsert 重新激活已 REMOVED 成员并刷新 joinedAt（与 redeemInvitation 同模式）。
   * 返回最新 session（team 已变更，前端据此进入团队空间）。
   */
  async joinPublicTeam(userId: string, teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw notFound('团队不存在');
    if (team.status !== 'ACTIVE') throw forbidden('团队当前不可加入');
    if (!team.allowPublicJoin) throw forbidden('该团队未开放公开加入');
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMembership.upsert({
        where: { teamId_userId: { teamId, userId } },
        create: { teamId, userId, role: 'MEMBER' },
        // 重新激活已 REMOVED 成员时刷新 joinedAt（与 redeemInvitation 的 TEAM-06 修复对齐），
        // 否则 ensureCurrentTeam 按 joinedAt desc 选当前团队会错指。
        update: { status: 'ACTIVE', role: 'MEMBER', joinedAt: new Date() },
      });
      await tx.auditLog.create({
        data: { actorUserId: userId, action: 'team.public_joined', targetType: 'Team', targetId: teamId, metadata: { teamId } },
      });
    });
    return this.auth.me(userId);
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
    const code = `${INVITE_CODE_PREFIX}${randomBytes(INVITE_CODE_RANDOM_BYTES).toString('base64url').toUpperCase()}`;
    const invite = await this.prisma.invitationCode.create({
      data: {
        teamId: membership.teamId,
        createdById: actorId,
        codeHash: hashInvite(code),
        displayCodePrefix: code.slice(0, INVITE_DISPLAY_PREFIX_LENGTH),
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

  /**
   * 团队管理员更新团队公开发现设置（allowPublicJoin + description）。
   * allowPublicJoin 切换是否出现在「发现公开团队」列表；description 为发现页展示的简介。
   * 仅 TEAM_ADMIN 可操作，限当前团队（防越权改他团）。
   */
  async updateTeamProfile(actorId: string, input: { allowPublicJoin?: boolean; description?: string }) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const data: { allowPublicJoin?: boolean; description?: string } = {};
    if (typeof input.allowPublicJoin === 'boolean') data.allowPublicJoin = input.allowPublicJoin;
    if (input.description !== undefined) data.description = input.description.trim().slice(0, 500); // 简介限 500 字防滥用
    if (Object.keys(data).length === 0) return this.teamProfile(membership.teamId);
    await this.prisma.team.update({ where: { id: membership.teamId }, data });
    await this.audit(actorId, 'team.profile.updated', 'Team', membership.teamId, data);
    return this.teamProfile(membership.teamId);
  }

  /** 团队公开信息（发现页 / TeamManage 展示用）：allowPublicJoin + description。 */
  async teamProfile(teamId: string) {
    const team = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { id: true, name: true, allowPublicJoin: true, description: true },
    });
    return { team };
  }

  /** 当前团队公开信息（TEAM_ADMIN/普通成员均可读，TeamManage 展示开关状态）。 */
  async currentTeamProfile(actorId: string) {
    const membership = await this.auth.ensureCurrentTeam(actorId);
    return this.teamProfile(membership.teamId);
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
      // 修复 H4：auditLog 写入移入事务，保证「余额变更必有审计」原子性。
      // 此前事务外 audit() 在 DB 抖动时丢失，与 balanceLedger 不一致，破坏安全追溯链。
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'team.balance.consumed', targetType: 'Team', targetId: membership.teamId, metadata: { amountCents: amount, reason: input.reason || 'usage' } } });
    });
    return this.balance(userId);
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}
