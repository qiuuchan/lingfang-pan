import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { CollabService } from './collab.service';

@ApiTags('Plugins')
@ApiBearerAuth()
@Controller('plugins')
export class PluginsController {
  constructor(@Inject(CollabService) private readonly collab: CollabService) {}

  @Post('upload')
  @ApiOperation({ summary: '上传插件到当前团队云端共享空间' })
  upload(@Req() req: Request, @Body() body: { manifest?: object; files?: Array<{ path: string; content: string }>; priceCents?: number }) {
    return this.collab.uploadPlugin(requireUser(req).id, body);
  }

  @Get('mine')
  @ApiOperation({ summary: '当前用户创建的插件' })
  mine(@Req() req: Request) {
    return this.collab.myPlugins(requireUser(req).id);
  }

  @Get('available')
  @ApiOperation({ summary: '当前团队可用插件列表' })
  available(@Req() req: Request) {
    return this.collab.availablePlugins(requireUser(req).id);
  }

  @Post(':id/submit-marketplace')
  @ApiOperation({ summary: '提交插件到公共市场审核' })
  submitMarketplace(@Req() req: Request, @Param('id') id: string, @Body() body: { priceCents?: number }) {
    return this.collab.submitPluginToMarketplace(requireUser(req).id, id, body || {});
  }

  @Post(':id/edit-draft')
  @ApiOperation({ summary: '编辑已上传插件草稿' })
  editDraft(@Req() req: Request, @Param('id') id: string, @Body() body: { manifest?: object; files?: Array<{ path: string; content: string }>; priceCents?: number }) {
    return this.collab.editPluginDraft(requireUser(req).id, id, body);
  }

  @Post(':id/install')
  @ApiOperation({ summary: '安装公共市场插件到当前团队' })
  install(@Req() req: Request, @Param('id') id: string) {
    return this.collab.installMarketplacePlugin(requireUser(req).id, id);
  }
}
