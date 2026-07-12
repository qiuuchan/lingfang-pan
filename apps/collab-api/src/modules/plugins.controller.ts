import { Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { clientUpgradeRequired } from '../common';
import { RequirePermission } from './auth.decorators';

@ApiTags('Plugins')
@ApiBearerAuth()
@Controller('plugins')
export class PluginsController {
  @RequirePermission('team.plugin.upload')
  @Post('upload')
  // 插件上传限流 10 次/分钟/IP（Top9）：单包 2MB，高频上传放大 DB 写入与磁盘压力。
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '上传插件到当前团队云端共享空间' })
  upload() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.list')
  @Get('mine')
  @ApiOperation({ summary: '当前用户创建的插件' })
  mine() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.list')
  @Get('available')
  @ApiOperation({ summary: '当前团队可用插件列表' })
  available() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.submit_marketplace')
  @Post(':id/submit-marketplace')
  @ApiOperation({ summary: '提交插件到公共市场审核' })
  submitMarketplace() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.edit_draft')
  @Post(':id/edit-draft')
  @ApiOperation({ summary: '编辑已上传插件草稿' })
  editDraft() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.edit_metadata')
  @Post(':id/edit-meta')
  @ApiOperation({ summary: '编辑插件元数据（名称/描述/图标，不重置审核态、不改源码）' })
  editMeta() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.edit_price')
  @Post(':id/set-price')
  @ApiOperation({ summary: '设置插件定价（不改源码、不触发审核流程）' })
  setPrice() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.enable')
  @Post(':id/set-status')
  @ApiOperation({ summary: '切换插件启用/禁用（仅作者/团队管理员，不改其他治理字段）' })
  setStatus() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.install')
  @Post(':id/install')
  @ApiOperation({ summary: '安装公共市场插件到当前团队' })
  install() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('team.plugin.delete')
  @Delete(':id')
  @ApiOperation({ summary: '删除插件（仅作者/团队管理员，未上架可删；已上架需先 admin 下架）' })
  deletePlugin() {
    throw clientUpgradeRequired();
  }
}
