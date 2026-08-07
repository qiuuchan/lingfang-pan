// 用户通知服务（组B：通知系统）。
//
// 设计契约：
//  - 通知是用户级（不强制团队归属）：listForUser/markRead/markAllRead 均按 userId 隔离，
//    controller 用 requireUser(req).id（当前登录用户），无需 ensureCurrentTeam。
//  - create 为内部触发入口（admin/economy 等业务 service 调用），不暴露 HTTP。
//    调用方必须用 try/catch 包裹，触发失败只记日志不抛错，绝不阻塞主操作（见各埋点）。
//  - 出参字段 camelCase，createdAt 转 ISO 字符串，与 release.service 的 publicRelease 风格一致。
//  - 未读数用 count({ where: { userId, read: false } }) 单独查询，列表与未读数一次返回（前端省一次请求）。
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Notification } from '@prisma/client';
import { notFound } from '../common';
import { PrismaService } from '../prisma.service';

/** 通知内部触发入参中的可选关联实体（relatedType/relatedId，前端据此跳转详情）。 */
export interface NotificationRelated {
  relatedType?: string;
  relatedId?: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** GET /api/notifications：当前用户通知列表（按时间倒序，默认 50 条）+ 未读数。
   *  - opts.unreadOnly=true 时仅返回未读（前端「未读」tab 用）。
   *  - limit clamp 到 [1,100]，与 release.list 的 clamp 风格一致。 */
  async listForUser(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    const limit =
      opts.limit === undefined ? 50 : Math.min(100, Math.max(1, Math.floor(opts.limit)));
    const where: { userId: string; read?: boolean } = { userId };
    if (opts.unreadOnly) where.read = false;

    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
      this.prisma.notification.count({ where: { userId, read: false } }),
    ]);
    return {
      notifications: items.map((n) => this.publicNotification(n)),
      unreadCount,
    };
  }

  /** POST /api/notifications/:id/read：标记单条为已读（按 userId 隔离，越权访问返回 not_found）。
   *  - 用 updateMany({ where: { id, userId } }) 而非 update({ where: { id } })：
   *    返回 count=0 即「该通知不属于此用户或不存在」，统一映射为 not_found（不泄漏存在性）。 */
  async markRead(id: string, userId: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { id, userId, read: false },
      data: { read: true },
    });
    if (updated.count === 0) throw notFound('通知不存在');
    return { ok: true };
  }

  /** POST /api/notifications/read-all：当前用户全部标记为已读（updateMany，无匹配时 count=0 也算成功）。 */
  async markAllRead(userId: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { ok: true, updatedCount: updated.count };
  }

  /** 内部触发：创建一条通知。调用方必须用 try/catch 包裹，失败仅记日志不抛错（不阻塞主操作）。
   *  - title/body 由调用方构造文案；type 为业务类型串（如 plugin_approved）。
   *  - related 可选，指向触发实体（如 { relatedType: 'Plugin', relatedId: 'p1' }）。 */
  async create(
    userId: string,
    type: string,
    title: string,
    body: string,
    related?: NotificationRelated
  ) {
    return this.prisma.notification.create({
      data: {
        userId,
        type,
        title,
        body,
        relatedType: related?.relatedType,
        relatedId: related?.relatedId,
      },
    });
  }

  /** 通知出参：camelCase + createdAt 转 ISO 字符串（与 release.publicRelease 风格一致）。 */
  private publicNotification(n: Notification) {
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      read: n.read,
      relatedType: n.relatedType,
      relatedId: n.relatedId,
      createdAt: n.createdAt.toISOString(),
    };
  }
}
