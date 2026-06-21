import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { RoleService } from './role.service';
import { AssignMemberRoleDto, CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

/**
 * 平台角色管理控制器（web 端 collab-admin 使用）。
 * 挂在 /api/admin/roles，由 @RequirePermission('platform.role.manage') 守卫校验。
 */
@ApiTags('Roles')
@ApiBearerAuth()
@Controller('admin/roles')
export class AdminRolesController {
  constructor(@Inject(RoleService) private readonly role: RoleService) {}

  @Get('permissions')
  @ApiOperation({ summary: '列出平台级权限码清单（角色编辑页勾选面板数据源）' })
  listPermissions() {
    return this.role.listPermissions('PLATFORM');
  }

  @RequirePermission('platform.role.manage')
  @Get()
  @ApiOperation({ summary: '列出全部平台级角色（含成员数）' })
  list(@Req() req: Request) {
    return this.role.listPlatformRoles(requireUser(req).id);
  }

  @RequirePermission('platform.role.manage')
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '创建平台角色' })
  create(@Req() req: Request, @Body() dto: CreateRoleDto) {
    return this.role.createPlatformRole(requireUser(req).id, dto);
  }

  @RequirePermission('platform.role.manage')
  @Patch(':id')
  @ApiOperation({ summary: '更新平台角色（系统角色不可改权限）' })
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.role.updatePlatformRole(requireUser(req).id, id, dto);
  }

  @RequirePermission('platform.role.manage')
  @Delete(':id')
  @ApiOperation({ summary: '删除平台角色（系统角色不可删，有引用时拒绝）' })
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.role.deletePlatformRole(requireUser(req).id, id);
  }

  @RequirePermission('platform.user.role.assign')
  @Post('assign')
  @ApiOperation({ summary: '为用户分配/撤销平台角色（roleId 传 null 撤销）' })
  assign(@Req() req: Request, @Body('userId') userId: string, @Body('roleId') roleId: string | null) {
    return this.role.assignPlatformRole(requireUser(req).id, userId, roleId);
  }
}

/**
 * 团队角色管理控制器（桌面端 TeamAdmin 面板使用）。
 * 挂在 /api/teams/current/roles，由 @RequirePermission('team.role.manage' / 'team.member.role.assign') 守卫校验。
 */
@ApiTags('Roles')
@ApiBearerAuth()
@Controller('teams/current/roles')
export class RolesController {
  constructor(@Inject(RoleService) private readonly role: RoleService) {}

  @Get('permissions')
  @ApiOperation({ summary: '列出团队级权限码清单' })
  listPermissions() {
    return this.role.listPermissions('TEAM');
  }

  @RequirePermission('team.role.manage')
  @Get()
  @ApiOperation({ summary: '列出当前团队的全部角色（含成员数）' })
  list(@Req() req: Request) {
    return this.role.listTeamRoles(requireUser(req).id);
  }

  @RequirePermission('team.role.manage')
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '创建团队角色' })
  create(@Req() req: Request, @Body() dto: CreateRoleDto) {
    return this.role.createTeamRole(requireUser(req).id, dto);
  }

  @RequirePermission('team.role.manage')
  @Patch(':id')
  @ApiOperation({ summary: '更新团队角色（系统角色不可改权限，不可跨团队）' })
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.role.updateTeamRole(requireUser(req).id, id, dto);
  }

  @RequirePermission('team.role.manage')
  @Delete(':id')
  @ApiOperation({ summary: '删除团队角色（系统角色不可删，有引用时拒绝）' })
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.role.deleteTeamRole(requireUser(req).id, id);
  }

  @RequirePermission('team.member.role.assign')
  @Post('assign')
  @ApiOperation({ summary: '为团队成员分配团队角色' })
  assign(@Req() req: Request, @Body() dto: AssignMemberRoleDto) {
    return this.role.assignMemberRole(requireUser(req).id, dto.userId, dto.roleId);
  }
}
