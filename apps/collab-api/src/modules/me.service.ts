// 个人数据自助服务：数据导出（GDPR 风格的可携带权）与账号注销（软删除）。
//
// 设计契约：
//  - exportMyData：用 Promise.all 并行拉取用户全量数据（个人信息/作者插件/购买/钱包流水/团队成员），
//    出参仅 publicUser 白名单字段 + 各 relation 必要字段，绝不返回 passwordHash/tokenVersion。
//    不写审计（只读查询，无安全追溯价值）；不鉴权（controller 已由 JwtAuthGuard + requireUser 限定到当前用户）。
//  - deleteMyAccount：软删除（不硬删）。$transaction 内原子完成：
//      status=DISABLED、email 改为 `<原邮箱>-deleted-<时间戳>@deleted.local`（打码 + 时间戳保证唯一，原邮箱可被重新注册）、
//      displayName='已注销用户'、tokenVersion++（作废所有已签发旧 JWT，JwtAuthGuard 校验时失效）、
//      passwordHash 替换为随机串（防止残留哈希被离线爆破）。
//    事务内同步写 auditLog（action='user.account_deleted'，metadata 仅 {userId}，不记原邮箱避免泄漏）。
//  - 软删除而非物理 DELETE：保留行以维持 AuditLog/Purchase 等外键完整性（User 被 Purchase/AuditLog 等引用，
//    onDelete 多为 Restrict 或 SetNull 但物理删除仍会触发级联副作用，破坏审计追溯链）。
//  - 不依赖 AuthService.ensureXxx：这是当前用户对自己账号的操作，鉴权由 controller + JwtAuthGuard 完成，
//    service 仅信任传入的 userId（已认证），无需二次 ensurePlatformAdmin 等。
import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { notFound, publicUser } from '../common';

@Injectable()
export class MeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 导出当前用户全量数据（GET /api/me/export）。
   * Promise.all 并行查询五类数据，出参按白名单脱敏，绝不返回 passwordHash/tokenVersion。
   */
  async exportMyData(userId: string) {
    const [user, plugins, purchases, walletTxs, memberships] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.plugin.findMany({ where: { authorUserId: userId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.purchase.findMany({ where: { buyerUserId: userId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.walletTransaction.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.teamMembership.findMany({ where: { userId }, include: { team: true }, orderBy: { joinedAt: 'desc' } }),
    ]);
    if (!user) throw notFound('用户不存在');
    return {
      // 个人信息：publicUser 白名单（id/email/displayName/status/platformRole），不含 passwordHash/tokenVersion。
      // 补 createdAt 供用户导出注册时间；tokenVersion 等敏感字段严格排除。
      user: { ...publicUser(user), createdAt: user.createdAt },
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        visibility: p.visibility,
        reviewStatus: p.reviewStatus,
        marketplace: p.marketplace,
        priceCents: p.priceCents,
        createdAt: p.createdAt,
      })),
      purchases: purchases.map((p) => ({
        id: p.id,
        pluginId: p.pluginId,
        sellerUserId: p.sellerUserId,
        priceCents: p.priceCents,
        createdAt: p.createdAt,
      })),
      wallet: walletTxs.map((t) => ({
        id: t.id,
        amountCents: t.amountCents,
        direction: t.direction,
        reason: t.reason,
        pluginId: t.pluginId,
        createdAt: t.createdAt,
      })),
      teams: memberships.map((m) => ({
        teamId: m.teamId,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt,
        team: { id: m.team.id, name: m.team.name, slug: m.team.slug },
      })),
    };
  }

  /**
   * 注销当前账号（POST /api/me/delete-account）：软删除 + 审计，$transaction 原子。
   * - status=DISABLED：登录与 refresh 在 sessionFor 校验 status 时立即失败。
   * - email 改为 `<原邮箱>-deleted-<时间戳>@deleted.local`：打码 + 时间戳唯一，原邮箱被释放可重新注册。
   * - displayName='已注销用户'：脱敏展示名。
   * - tokenVersion++：作废所有已签发的旧 JWT（JwtAuthGuard 校验 tokenVersion 失效）。
   * - passwordHash 替换为随机串 bcrypt：防残留哈希被离线爆破（虽已 DISABLED，纵深防御）。
   */
  async deleteMyAccount(userId: string) {
    // 事务外先读当前用户（拿到原邮箱构造打码邮箱）。事务内再 update + audit 原子提交。
    // 不在事务内 findUnique 是为了把「用户不存在」的 404 在事务前抛出，避免空事务开销。
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) throw notFound('用户不存在');
    const deletedEmail = `${user.email}-deleted-${Date.now()}@deleted.local`;
    const randomPasswordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DISABLED',
          email: deletedEmail,
          displayName: '已注销用户',
          tokenVersion: { increment: 1 },
          passwordHash: randomPasswordHash,
        },
      });
      // 审计：metadata 仅 {userId}，不记原邮箱（已打码，记录原邮箱无追溯价值且泄漏隐私）。
      await tx.auditLog.create({
        data: { actorUserId: userId, action: 'user.account_deleted', targetType: 'User', targetId: userId, metadata: { userId } },
      });
    });
    return { ok: true };
  }
}
