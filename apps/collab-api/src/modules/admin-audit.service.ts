import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { notFound } from '../common';
import { AuthService } from './auth.service';
import { AUDIT_CATEGORIES } from './audit-actions';
import {
  ADMIN_AUDIT_DETAIL_SELECT,
  ADMIN_AUDIT_SUMMARY_SELECT,
  adminAuditDetail,
  adminAuditSummary,
  adminAuditWhere,
  normalizeAdminPage,
  type AdminAuditListQuery,
} from './admin-data-loading';

@Injectable()
export class AdminAuditService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}
  async auditLogs(userId: string, filters: AdminAuditListQuery = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    const { page, pageSize, skip } = normalizeAdminPage(filters);
    const where = adminAuditWhere(filters);
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_AUDIT_SUMMARY_SELECT,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: rows.map(adminAuditSummary), total, page, pageSize };
  }

  async auditLog(userId: string, id: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const log = await this.prisma.auditLog.findUnique({
      where: { id },
      select: ADMIN_AUDIT_DETAIL_SELECT,
    });
    if (!log) throw notFound('审计日志不存在');
    return { log: adminAuditDetail(log) };
  }

  /**
   * 返回审计分类元数据（key + 中文 + 说明），供前端筛选下拉渲染。
   * 分类 key 与 action 前缀对齐，前端据此构建分类筛选 UI。
   */
  async auditCategories(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    return { categories: AUDIT_CATEGORIES };
  }
}
