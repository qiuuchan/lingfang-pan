// 帮助与反馈工单服务。
//
// 设计契约：
//  - 前台方法（create/listForUser/getForUser/addUserMessage）按 userId 隔离：他人工单一律 notFound（不泄漏存在性，
//    与 notification.service.markRead 同款语义）。teamId 取自 ensureCurrentTeam，无团队/团队不可用则降级为 null（工单不强制团队）。
//  - 后台方法（listAdmin/getAdmin/addAdminMessage/updateStatus）由 controller 的 @RequirePermission 把关，service 不再二次校验权限，
//    但写操作记审计 + 触发提交人通知（与 release/economy 埋点同款 try/catch 不阻塞）。
//  - 附件存后端本地磁盘 uploads/tickets/<ticketId>/<storedName>，不公开静态托管；下载经 streamAttachment 鉴权（viewer 校验）。
//  - 状态机由 ticket-package 纯函数维护：用户回复 RESOLVED→IN_PROGRESS；管理员回复 OPEN→IN_PROGRESS；CLOSED 双方不可追加。
//  - 出参 camelCase，时间转 ISO 字符串（与 notification.publicNotification / release.publicRelease 风格一致）。
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, copyFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Prisma, Ticket, TicketMessage, TicketAttachment } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import { badRequest, conflict, notFound } from '../common';
import {
  validateAttachments,
  inferAttachmentKind,
  fileExt,
  cleanTitle,
  cleanBody,
  assertAdminStatusTransition,
  nextStatusOnUserReply,
  nextStatusOnAdminReply,
  type UploadedFileLike,
  type TicketStatusValue,
} from './ticket-package';

/** 工单附件根目录（后端 cwd 下，不入仓，不公开静态托管）。 */
const UPLOADS_ROOT = ['uploads', 'tickets'];

const ADMIN_TICKET_SUMMARY_SELECT = {
  id: true,
  userId: true,
  teamId: true,
  category: true,
  title: true,
  status: true,
  priority: true,
  handlerUserId: true,
  lastReplyAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, displayName: true, email: true } },
  team: { select: { id: true, name: true } },
  _count: { select: { messages: true, attachments: true } },
} as const satisfies Prisma.TicketSelect;

type AdminTicketSummaryRow = Prisma.TicketGetPayload<{
  select: typeof ADMIN_TICKET_SUMMARY_SELECT;
}>;

export interface TicketViewer {
  userId: string;
  isAdmin: boolean;
}

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotificationService) private readonly notifications: NotificationService
  ) {}

  // === 前台方法（按 userId 隔离）===

  /** POST /api/tickets：创建工单 + 首条 USER 消息 + 首贴附件。teamId 取自当前团队（无则 null）。 */
  async create(
    userId: string,
    input: { title: string; body: string; category?: string },
    files: UploadedFileLike[]
  ) {
    const title = cleanTitle(input.title);
    const body = cleanBody(input.body);
    const category = (input.category ?? 'OTHER') as Ticket['category'];
    validateAttachments(files);

    // teamId 软获取：无团队或团队不可用不阻断提交（工单不强制团队归属）。
    let teamId: string | null = null;
    try {
      const membership = await this.auth.ensureCurrentTeam(userId);
      teamId = membership.teamId;
    } catch {
      teamId = null;
    }

    const ticket = await this.prisma.ticket.create({
      data: {
        userId,
        teamId,
        category,
        title,
        status: 'OPEN',
        priority: 'NORMAL',
        lastReplyAt: new Date(),
        messages: {
          create: { authorUserId: userId, authorRole: 'USER', body },
        },
      },
      include: { messages: true },
    });

    const firstMessage = ticket.messages[0];
    if (files.length > 0) {
      await this.persistAttachments(ticket.id, firstMessage.id, files);
    }

    return this.getForUser(userId, ticket.id);
  }

  /** GET /api/tickets：本人工单列表（按 lastReplyAt desc）+ 可选 status 过滤。 */
  async listForUser(userId: string, opts: { status?: string; limit?: number } = {}) {
    const limit = opts.limit === undefined ? 50 : Math.min(50, Math.max(1, Math.floor(opts.limit)));
    const where: Prisma.TicketWhereInput = { userId };
    if (opts.status) where.status = opts.status as Ticket['status'];
    const tickets = await this.prisma.ticket.findMany({
      where,
      orderBy: { lastReplyAt: 'desc' },
      take: limit,
      include: { _count: { select: { messages: true, attachments: true } } },
    });
    return { tickets: tickets.map((t) => this.publicTicketSummary(t)) };
  }

  /** GET /api/tickets/:id：本人工单详情（含对话时间线 + 附件）。他人/不存在 → notFound。 */
  async getForUser(userId: string, id: string) {
    const ticket = await this.loadFull(id);
    if (!ticket || ticket.userId !== userId) throw notFound('工单不存在');
    return { ticket: await this.publicTicketDetail(ticket) };
  }

  /** POST /api/tickets/:id/messages：用户追加回复（+附件）。CLOSED 不可追加；RESOLVED→IN_PROGRESS。 */
  async addUserMessage(
    userId: string,
    id: string,
    input: { body?: string },
    files: UploadedFileLike[]
  ) {
    const body = cleanBody(input.body, files.length > 0);
    if (!body && files.length === 0) throw badRequest('请填写内容或上传附件');
    validateAttachments(files);

    const message = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUnique({ where: { id } });
      if (!ticket || ticket.userId !== userId) throw notFound('工单不存在');
      if (ticket.status === 'CLOSED')
        throw badRequest('工单已关闭，无法追加回复（如需继续请新建工单）');

      const nextStatus = nextStatusOnUserReply(ticket.status as TicketStatusValue);
      const claimed = await tx.ticket.updateMany({
        where: { id, userId, status: ticket.status },
        data: { status: nextStatus, lastReplyAt: new Date() },
      });
      if (claimed.count !== 1) throw conflict('工单状态已变化，请刷新后重试');

      return tx.ticketMessage.create({
        data: { ticketId: id, authorUserId: userId, authorRole: 'USER', body },
      });
    });
    if (files.length > 0) await this.persistAttachments(id, message.id, files);
    return this.getForUser(userId, id);
  }

  // === 后台方法（@RequirePermission 把关）===

  /** GET /api/admin/tickets：全部工单列表（筛选 + 分页）。 */
  async listAdmin(opts: {
    status?: string;
    category?: string;
    teamId?: string;
    q?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 20)));
    const where: Prisma.TicketWhereInput = {};
    if (opts.status) where.status = opts.status as Ticket['status'];
    if (opts.category) where.category = opts.category as Ticket['category'];
    if (opts.teamId) where.teamId = opts.teamId;
    if (opts.q) where.title = { contains: opts.q, mode: 'insensitive' };

    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: [{ lastReplyAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: ADMIN_TICKET_SUMMARY_SELECT,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    const handlerIds = [
      ...new Set(items.map((t) => t.handlerUserId).filter((v): v is string => !!v)),
    ];
    const handlers = handlerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: handlerIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const handlerMap = new Map(handlers.map((h) => [h.id, h.displayName]));

    return {
      items: items.map((t) =>
        this.adminTicketSummary(t, handlerMap.get(t.handlerUserId ?? '') ?? null)
      ),
      total,
      page,
      pageSize,
    };
  }

  /** GET /api/admin/tickets/:id：任意工单详情。 */
  async getAdmin(id: string) {
    const ticket = await this.loadFull(id);
    if (!ticket) throw notFound('工单不存在');
    return { ticket: await this.publicTicketDetail(ticket, true) };
  }

  /** POST /api/admin/tickets/:id/messages：管理员回复（+附件）。OPEN→IN_PROGRESS，记 handler + 审计 + 通知。 */
  async addAdminMessage(
    actorId: string,
    id: string,
    input: { body?: string },
    files: UploadedFileLike[]
  ) {
    const body = cleanBody(input.body, files.length > 0);
    if (!body && files.length === 0) throw badRequest('请填写内容或上传附件');
    validateAttachments(files);

    const result = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUnique({ where: { id } });
      if (!ticket) throw notFound('工单不存在');
      if (ticket.status === 'CLOSED') throw badRequest('工单已关闭，无法追加回复');

      const nextStatus = nextStatusOnAdminReply(ticket.status as TicketStatusValue);
      const claimed = await tx.ticket.updateMany({
        where: { id, status: ticket.status },
        data: { status: nextStatus, handlerUserId: actorId, lastReplyAt: new Date() },
      });
      if (claimed.count !== 1) throw conflict('工单状态已变化，请刷新后重试');

      const message = await tx.ticketMessage.create({
        data: { ticketId: id, authorUserId: actorId, authorRole: 'ADMIN', body },
      });
      return { ticket, message, nextStatus };
    });
    if (files.length > 0) await this.persistAttachments(id, result.message.id, files);

    await this.audit(actorId, 'admin.ticket.replied', id, { status: result.nextStatus });
    this.notify(
      result.ticket.userId,
      '工单收到新回复',
      `您的工单「${result.ticket.title}」收到管理员回复`,
      id
    );
    return this.getAdmin(id);
  }

  /** PATCH /api/admin/tickets/:id：改状态（校验转移合法）/优先级。 */
  async updateStatus(actorId: string, id: string, input: { status?: string; priority?: string }) {
    if (input.status === undefined && input.priority === undefined) {
      throw badRequest('请至少提供 status 或 priority');
    }
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) throw notFound('工单不存在');

    const data: Prisma.TicketUpdateInput = {};
    if (input.status !== undefined) {
      assertAdminStatusTransition(
        ticket.status as TicketStatusValue,
        input.status as TicketStatusValue
      );
      data.status = input.status as Ticket['status'];
      data.handlerUserId = actorId;
    }
    if (input.priority !== undefined) data.priority = input.priority as Ticket['priority'];

    if (input.status !== undefined) {
      const claimed = await this.prisma.ticket.updateMany({
        where: { id, status: ticket.status },
        data,
      });
      if (claimed.count !== 1) throw conflict('工单状态已变化，请刷新后重试');
    } else {
      await this.prisma.ticket.update({ where: { id }, data });
    }
    const nextStatus = input.status ?? ticket.status;
    const nextPriority = input.priority ?? ticket.priority;
    await this.audit(actorId, 'admin.ticket.status_changed', id, {
      status: nextStatus,
      priority: nextPriority,
    });
    if (input.status !== undefined && input.status !== ticket.status) {
      this.notify(
        ticket.userId,
        '工单状态更新',
        `您的工单「${ticket.title}」状态变更为 ${this.statusLabel(nextStatus)}`,
        id
      );
    }
    return this.getAdmin(id);
  }

  // === 附件下载（前后台共用，viewer 校验）===

  /** 校验下载权限并返回文件流 + 元信息。非 admin 仅可下载本人工单附件。 */
  async streamAttachment(ticketId: string, attachmentId: string, viewer: TicketViewer) {
    const attachment = await this.prisma.ticketAttachment.findUnique({
      where: { id: attachmentId },
      include: { ticket: { select: { id: true, userId: true } } },
    });
    // 附件不存在或不属于该工单 → notFound（不泄漏跨工单存在性）。
    if (!attachment || attachment.ticketId !== ticketId) throw notFound('附件不存在');
    if (!viewer.isAdmin && attachment.ticket.userId !== viewer.userId) throw notFound('附件不存在');

    const filePath = this.attachmentPath(ticketId, attachment.storedName);
    try {
      await stat(filePath);
    } catch {
      throw notFound('附件文件已丢失');
    }
    return {
      stream: createReadStream(filePath),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  }

  // === 私有辅助 ===

  /** 落盘一批附件并写 DB 记录。目录 uploads/tickets/<ticketId>/，文件名随机前缀防冲突。 */
  private async persistAttachments(
    ticketId: string,
    messageId: string | null,
    files: UploadedFileLike[]
  ) {
    const dir = this.ticketDir(ticketId);
    await mkdir(dir, { recursive: true });
    for (const file of files) {
      const ext = fileExt(file.originalname);
      const storedName = `${randomBytes(8).toString('hex')}${ext}`;
      const filePath = resolve(dir, storedName);
      if (file.buffer) {
        await writeFile(filePath, file.buffer);
      } else if (file.path) {
        await copyFile(file.path, filePath);
      } else {
        throw badRequest('附件内容为空', { filename: file.originalname });
      }
      await this.prisma.ticketAttachment.create({
        data: {
          ticketId,
          messageId,
          filename: file.originalname,
          storedName,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          kind: inferAttachmentKind(file.mimetype, file.originalname) as TicketAttachment['kind'],
        },
      });
    }
  }

  private ticketDir(ticketId: string): string {
    return resolve(process.cwd(), ...UPLOADS_ROOT, ticketId);
  }

  private attachmentPath(ticketId: string, storedName: string): string {
    return resolve(this.ticketDir(ticketId), storedName);
  }

  /** 加载工单全量（消息时间线升序 + 附件）。 */
  private async loadFull(id: string) {
    return this.prisma.ticket.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        attachments: true,
      },
    });
  }

  private async audit(actorUserId: string, action: string, targetId: string, metadata?: unknown) {
    try {
      await this.prisma.auditLog.create({
        data: { actorUserId, action, targetType: 'Ticket', targetId, metadata: metadata as object },
      });
    } catch (err) {
      this.logger.warn(`工单审计写入失败（不阻断）：${String(err)}`);
    }
  }

  /** 触发站内通知（try/catch 不阻塞主操作，与 economy/admin 埋点同款）。 */
  private notify(userId: string, title: string, body: string, ticketId: string) {
    this.notifications
      .create(userId, 'ticket_reply', title, body, { relatedType: 'Ticket', relatedId: ticketId })
      .catch((err) => this.logger.warn(`工单通知触发失败（不阻断）：${String(err)}`));
  }

  private statusLabel(status: string): string {
    return (
      { OPEN: '待处理', IN_PROGRESS: '处理中', RESOLVED: '已解决', CLOSED: '已关闭' }[status] ??
      status
    );
  }

  // === 出参构造 ===

  private publicTicketSummary(t: Ticket & { _count?: { messages: number; attachments: number } }) {
    return {
      id: t.id,
      category: t.category,
      title: t.title,
      status: t.status,
      priority: t.priority,
      messageCount: t._count?.messages ?? 0,
      attachmentCount: t._count?.attachments ?? 0,
      lastReplyAt: t.lastReplyAt ? t.lastReplyAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private adminTicketSummary(t: AdminTicketSummaryRow, handlerName: string | null) {
    return {
      ...this.publicTicketSummary(t),
      submitter: t.user
        ? { id: t.user.id, displayName: t.user.displayName, email: t.user.email }
        : null,
      team: t.team ? { id: t.team.id, name: t.team.name } : null,
      handler: t.handlerUserId ? { id: t.handlerUserId, displayName: handlerName } : null,
    };
  }

  private async publicTicketDetail(
    t: Ticket & { messages: TicketMessage[]; attachments: TicketAttachment[] },
    includeMeta = false
  ) {
    // 附件按 messageId 分组（messageId=null 挂工单首贴）。
    const byMessage = new Map<string | null, TicketAttachment[]>();
    for (const a of t.attachments) {
      const key = a.messageId ?? null;
      const arr = byMessage.get(key) ?? [];
      arr.push(a);
      byMessage.set(key, arr);
    }
    const meta = includeMeta ? await this.detailMeta(t) : {};
    return {
      id: t.id,
      category: t.category,
      title: t.title,
      status: t.status,
      priority: t.priority,
      teamId: t.teamId,
      lastReplyAt: t.lastReplyAt ? t.lastReplyAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      ...meta,
      messages: t.messages.map((m) => ({
        id: m.id,
        authorRole: m.authorRole,
        authorUserId: m.authorUserId,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        attachments: (byMessage.get(m.id) ?? []).map((a) => this.publicAttachment(a)),
      })),
      // 挂工单首贴（messageId=null）的附件单列（兼容历史/边缘数据）。
      attachments: (byMessage.get(null) ?? []).map((a) => this.publicAttachment(a)),
    };
  }

  private async detailMeta(t: Ticket) {
    const [submitter, team, handler] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: t.userId },
        select: { id: true, displayName: true, email: true },
      }),
      t.teamId
        ? this.prisma.team.findUnique({ where: { id: t.teamId }, select: { id: true, name: true } })
        : Promise.resolve(null),
      t.handlerUserId
        ? this.prisma.user.findUnique({
            where: { id: t.handlerUserId },
            select: { id: true, displayName: true },
          })
        : Promise.resolve(null),
    ]);
    return {
      submitter: submitter
        ? { id: submitter.id, displayName: submitter.displayName, email: submitter.email }
        : null,
      team: team ? { id: team.id, name: team.name } : null,
      handler: handler ? { id: handler.id, displayName: handler.displayName } : null,
    };
  }

  private publicAttachment(a: TicketAttachment) {
    return {
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      kind: a.kind,
      createdAt: a.createdAt.toISOString(),
    };
  }
}
