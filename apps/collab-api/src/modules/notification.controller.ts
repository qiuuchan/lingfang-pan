// 用户通知控制器（组B：通知系统）。
// 3 个 /api/notifications/* 路由，全部当前登录用户级（requireUser(req).id），不强制团队。
// 仅 GET 支持可选 query（unreadOnly/limit），无 @Body（标记已读无入参）。
import { Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { NotificationService } from './notification.service';
import { NotificationListQueryDto } from './dto/notification.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: '当前用户通知列表 + 未读数' })
  list(@Req() req: Request, @Query() query: NotificationListQueryDto) {
    return this.notifications.listForUser(requireUser(req).id, {
      unreadOnly: query.unreadOnly ?? false,
      limit: query.limit,
    });
  }

  @Post(':id/read')
  @ApiOperation({ summary: '标记单条通知为已读' })
  markRead(@Req() req: Request, @Param('id') id: string) {
    return this.notifications.markRead(id, requireUser(req).id);
  }

  @Post('read-all')
  @ApiOperation({ summary: '当前用户全部通知标记为已读' })
  markAllRead(@Req() req: Request) {
    return this.notifications.markAllRead(requireUser(req).id);
  }
}
