import { Body, Controller, Delete, Get, Inject, Param, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { PermissionGroupService } from './permission-group.service';
import { UpsertPermissionGroupDto } from './dto/role.dto';

/**
 * 平台权限分组管理控制器（web 端 collab-admin 使用）。
 * 挂在 /api/admin/permission-groups，由 PermissionGroupService 内部 ensurePermission('platform.role.manage') 校验。
 */
@ApiTags('PermissionGroups')
@ApiBearerAuth()
@Controller('admin/permission-groups')
export class AdminPermissionGroupsController {
  constructor(@Inject(PermissionGroupService) private readonly group: PermissionGroupService) {}

  @Get()
  @ApiOperation({ summary: '列出平台级权限分组（含自定义显示名覆盖）' })
  list(@Req() req: Request) {
    return this.group.listGroups(requireUser(req).id, 'PLATFORM');
  }

  @Put()
  @ApiOperation({ summary: '修改平台级权限分组显示名（groupKey 须为已注册模块）' })
  upsert(@Req() req: Request, @Body() dto: UpsertPermissionGroupDto) {
    return this.group.upsertGroup(requireUser(req).id, 'PLATFORM', dto);
  }

  @Delete(':groupKey')
  @ApiOperation({ summary: '重置平台级权限分组显示名为内置默认' })
  remove(@Req() req: Request, @Param('groupKey') groupKey: string) {
    return this.group.deleteGroup(requireUser(req).id, 'PLATFORM', groupKey);
  }
}

/**
 * 团队权限分组管理控制器（桌面端 TeamAdmin 面板使用）。
 * 挂在 /api/teams/current/permission-groups，由 PermissionGroupService 内部 ensurePermission('team.role.manage') 校验。
 */
@ApiTags('PermissionGroups')
@ApiBearerAuth()
@Controller('teams/current/permission-groups')
export class PermissionGroupsController {
  constructor(@Inject(PermissionGroupService) private readonly group: PermissionGroupService) {}

  @Get()
  @ApiOperation({ summary: '列出当前团队的权限分组' })
  list(@Req() req: Request) {
    return this.group.listGroups(requireUser(req).id, 'TEAM');
  }

  @Put()
  @ApiOperation({ summary: '修改当前团队的权限分组显示名' })
  upsert(@Req() req: Request, @Body() dto: UpsertPermissionGroupDto) {
    return this.group.upsertGroup(requireUser(req).id, 'TEAM', dto);
  }

  @Delete(':groupKey')
  @ApiOperation({ summary: '重置当前团队的权限分组显示名为内置默认' })
  remove(@Req() req: Request, @Param('groupKey') groupKey: string) {
    return this.group.deleteGroup(requireUser(req).id, 'TEAM', groupKey);
  }
}
