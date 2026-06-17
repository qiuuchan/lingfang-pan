import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requireUser } from '../common';
import { PluginService } from './plugin.service';
import { PluginPackageDto, SetPluginPriceDto, SetPluginStatusDto, SubmitMarketplaceDto } from './dto/plugins.dto';

@ApiTags('Plugins')
@ApiBearerAuth()
@Controller('plugins')
export class PluginsController {
  constructor(@Inject(PluginService) private readonly plugins: PluginService) {}

  @Post('upload')
  // 插件上传限流 10 次/分钟/IP（Top9）：单包 2MB，高频上传放大 DB 写入与磁盘压力。
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '上传插件到当前团队云端共享空间' })
  upload(@Req() req: Request, @Body() body: PluginPackageDto) {
    return this.plugins.uploadPlugin(requireUser(req).id, body);
  }

  @Get('mine')
  @ApiOperation({ summary: '当前用户创建的插件' })
  mine(@Req() req: Request) {
    return this.plugins.myPlugins(requireUser(req).id);
  }

  @Get('available')
  @ApiOperation({ summary: '当前团队可用插件列表' })
  available(@Req() req: Request) {
    return this.plugins.availablePlugins(requireUser(req).id);
  }

  @Post(':id/submit-marketplace')
  @ApiOperation({ summary: '提交插件到公共市场审核' })
  submitMarketplace(@Req() req: Request, @Param('id') id: string, @Body() body: SubmitMarketplaceDto) {
    return this.plugins.submitPluginToMarketplace(requireUser(req).id, id, body);
  }

  @Post(':id/edit-draft')
  @ApiOperation({ summary: '编辑已上传插件草稿' })
  editDraft(@Req() req: Request, @Param('id') id: string, @Body() body: PluginPackageDto) {
    return this.plugins.editPluginDraft(requireUser(req).id, id, body);
  }

  @Post(':id/set-price')
  @ApiOperation({ summary: '设置插件定价（不改源码、不触发审核流程）' })
  setPrice(@Req() req: Request, @Param('id') id: string, @Body() body: SetPluginPriceDto) {
    return this.plugins.setPluginPrice(requireUser(req).id, id, body);
  }

  @Post(':id/set-status')
  @ApiOperation({ summary: '切换插件启用/禁用（仅作者/团队管理员，不改其他治理字段）' })
  setStatus(@Req() req: Request, @Param('id') id: string, @Body() body: SetPluginStatusDto) {
    return this.plugins.setPluginStatus(requireUser(req).id, id, body);
  }

  @Post(':id/install')
  @ApiOperation({ summary: '安装公共市场插件到当前团队' })
  install(@Req() req: Request, @Param('id') id: string) {
    return this.plugins.installMarketplacePlugin(requireUser(req).id, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除插件（仅作者/团队管理员，未上架可删；已上架需先 admin 下架）' })
  deletePlugin(@Req() req: Request, @Param('id') id: string) {
    return this.plugins.deleteByAuthor(requireUser(req).id, id);
  }
}