import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { PluginGrantService } from './plugin-grant.service';
import { SetPluginGrantDto } from './dto/role.dto';

/**
 * 团队插件授权管理控制器（桌面端 TeamAdmin 面板使用）。
 * 挂在 /api/teams/current/plugins/:id/grants，由 @RequirePermission('team.plugin.grant.manage') 守卫校验。
 *
 * 授权语义（见 PluginGrantService.resolvePluginAccess）：deny 优先、user 级优先于 role 级、
 * 团队管理员默认放行、无 grant 默认放行。被 deny 的插件不出现在 availablePlugins 列表。
 */
@ApiTags('PluginGrants')
@ApiBearerAuth()
@Controller('teams/current/plugin-packages')
export class PluginGrantsController {
  constructor(@Inject(PluginGrantService) private readonly grants: PluginGrantService) {}

  @RequirePermission('team.plugin.grant.manage')
  @Get(':id/grants')
  @ApiOperation({ summary: '列出某插件在当前团队的全部授权' })
  list(@Req() req: Request, @Param('id') packageId: string) {
    return this.grants.listGrants(requireUser(req).id, packageId);
  }

  @RequirePermission('team.plugin.grant.manage')
  @Post(':id/grants')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '设置/更新插件授权（user 或 role，allow 或 deny）' })
  set(@Req() req: Request, @Param('id') packageId: string, @Body() dto: SetPluginGrantDto) {
    return this.grants.setGrant(requireUser(req).id, packageId, dto);
  }

  @RequirePermission('team.plugin.grant.manage')
  @Delete(':id/grants')
  @ApiOperation({ summary: '移除插件授权（恢复默认可用）' })
  remove(
    @Req() req: Request,
    @Param('id') packageId: string,
    @Query('subjectKind') subjectKind: 'USER' | 'ROLE',
    @Query('subjectId') subjectId: string
  ) {
    return this.grants.removeGrant(requireUser(req).id, packageId, subjectKind, subjectId);
  }
}
