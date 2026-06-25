// 帮助与反馈工单控制器。
//
// 两个控制器：
//  - TicketController（前台 /api/tickets/*）：全部当前登录用户级（requireUser(req).id），按 userId 隔离。
//  - AdminTicketController（后台 /api/admin/tickets/*）：@RequirePermission 把关（view/manage）。
//
// 提交/回复走 multipart（FileFieldsInterceptor，field name=files，最多 5 个，单文件 10MB）；
// 表单字段 title/body/category 由 DTO 校验（@Body 在 multipart 下取 form 字段）。
// 附件下载走鉴权流式响应（passthrough:false，手动设 Content-Disposition / Content-Type）。
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { TicketService, type TicketViewer } from './ticket.service';
import {
  AdminTicketListQueryDto,
  AdminTicketUpdateDto,
  TicketCreateDto,
  TicketListQueryDto,
  TicketMessageCreateDto,
} from './dto/ticket.dto';
import type { UploadedFileLike } from './ticket-package';

/** multipart 上传配置：field name=files，最多 5 个，单文件 10MB（与 ticket-package 上限一致，拦截器层先兜底）。 */
const TICKET_UPLOAD = FileFieldsInterceptor(
  [{ name: 'files', maxCount: 5 }],
  { limits: { fileSize: 10 * 1024 * 1024, files: 5 } },
);

type MulterFiles = { files?: UploadedFileLike[] };

function pickFiles(files: MulterFiles | undefined): UploadedFileLike[] {
  return files?.files ?? [];
}

/** 流式回写附件到 HTTP 响应（前后台共用）。 */
async function sendAttachment(
  service: TicketService,
  res: Response,
  ticketId: string,
  attachmentId: string,
  viewer: TicketViewer,
) {
  const { stream, filename, mimeType, sizeBytes } = await service.streamAttachment(ticketId, attachmentId, viewer);
  const encoded = encodeURIComponent(filename);
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
  if (sizeBytes) res.setHeader('Content-Length', String(sizeBytes));
  stream.pipe(res);
}

// === 前台 ===
@ApiTags('Tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketController {
  constructor(@Inject(TicketService) private readonly tickets: TicketService) {}

  @Post()
  @ApiOperation({ summary: '提交工单（multipart：title/body/category + files[]）' })
  @UseInterceptors(TICKET_UPLOAD)
  create(@Req() req: Request, @Body() body: TicketCreateDto, @UploadedFiles() files: MulterFiles) {
    return this.tickets.create(requireUser(req).id, body, pickFiles(files));
  }

  @Get()
  @ApiOperation({ summary: '本人工单列表（按最近回复倒序）' })
  list(@Req() req: Request, @Query() query: TicketListQueryDto) {
    return this.tickets.listForUser(requireUser(req).id, { status: query.status, limit: query.limit });
  }

  @Get(':id')
  @ApiOperation({ summary: '本人工单详情（对话时间线 + 附件）' })
  get(@Req() req: Request, @Param('id') id: string) {
    return this.tickets.getForUser(requireUser(req).id, id);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: '用户追加回复（multipart：body + files[]）' })
  @UseInterceptors(TICKET_UPLOAD)
  reply(@Req() req: Request, @Param('id') id: string, @Body() body: TicketMessageCreateDto, @UploadedFiles() files: MulterFiles) {
    return this.tickets.addUserMessage(requireUser(req).id, id, body, pickFiles(files));
  }

  @Get(':id/attachments/:attachmentId')
  @ApiOperation({ summary: '下载本人工单附件（鉴权流式）' })
  async download(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    await sendAttachment(this.tickets, res, id, attachmentId, { userId: requireUser(req).id, isAdmin: false });
  }
}

// === 后台 ===
@ApiTags('Admin Tickets')
@ApiBearerAuth()
@Controller('admin/tickets')
export class AdminTicketController {
  constructor(@Inject(TicketService) private readonly tickets: TicketService) {}

  @RequirePermission('platform.ticket.view')
  @Get()
  @ApiOperation({ summary: '工单列表（筛选 status/category/teamId/q + 分页）' })
  list(@Query() query: AdminTicketListQueryDto) {
    return this.tickets.listAdmin(query);
  }

  @RequirePermission('platform.ticket.view')
  @Get(':id')
  @ApiOperation({ summary: '工单详情（含提交人/团队/处理人元信息）' })
  get(@Param('id') id: string) {
    return this.tickets.getAdmin(id);
  }

  @RequirePermission('platform.ticket.manage')
  @Post(':id/messages')
  @ApiOperation({ summary: '管理员回复工单（multipart：body + files[]）' })
  @UseInterceptors(TICKET_UPLOAD)
  reply(@Req() req: Request, @Param('id') id: string, @Body() body: TicketMessageCreateDto, @UploadedFiles() files: MulterFiles) {
    return this.tickets.addAdminMessage(requireUser(req).id, id, body, pickFiles(files));
  }

  @RequirePermission('platform.ticket.manage')
  @Patch(':id')
  @ApiOperation({ summary: '变更工单状态/优先级' })
  update(@Req() req: Request, @Param('id') id: string, @Body() body: AdminTicketUpdateDto) {
    return this.tickets.updateStatus(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.ticket.view')
  @Get(':id/attachments/:attachmentId')
  @ApiOperation({ summary: '下载工单附件（鉴权流式）' })
  async download(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    await sendAttachment(this.tickets, res, id, attachmentId, { userId: requireUser(req).id, isAdmin: true });
  }
}
