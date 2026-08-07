import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { RoleService } from './role.service';
import { CreateRoleDto, RoleListQueryDto, UpdateRoleDto } from './dto/role.dto';

/**
 * 平台管理员代管团队角色控制器（web 端 collab-admin 团队详情「角色」tab 使用）。
 *
 * 挂在 /api/admin/teams/:id/roles，全部端点守卫 platform.team.role.manage：
 *  - GET    /roles               list 该团队全部角色
 *  - POST   /roles               create
 *  - PATCH  /roles/:roleId       update
 *  - DELETE /roles/:roleId       delete
 *  - GET    /roles/permissions   listPermissions('TEAM')（角色编辑页勾选面板数据源）
 *
 * 与桌面端 RolesController（/api/teams/current/roles，用 resolveCurrentTeam）区别：
 * 本控制器直接用 :id 参数指定团队（平台管理员不必加入该团队），复用 RoleService 的「代管版」方法。
 * 系统角色（isSystem=true）权限/编码锁定、不可删，逻辑由 service 统一维护，与桌面端一致。
 */
@ApiTags('TeamRoles')
@ApiBearerAuth()
@RequirePermission('platform.team.role.manage')
@Controller('admin/teams')
export class AdminTeamRolesController {
  constructor(@Inject(RoleService) private readonly role: RoleService) {}

  @Get(':id/roles/permissions')
  @ApiOperation({ summary: '列出团队级权限码清单（团队角色编辑页勾选面板数据源）' })
  listPermissions() {
    return this.role.listPermissions('TEAM');
  }

  @Get(':id/roles')
  @ApiOperation({ summary: '分页列出指定团队角色摘要（平台管理员代管）' })
  list(@Req() req: Request, @Param('id') id: string, @Query() query: RoleListQueryDto) {
    return this.role.listTeamRolesForTeam(requireUser(req).id, id, query);
  }

  @Get(':id/roles/:roleId')
  @ApiOperation({ summary: '指定团队角色详情（含 permissions）' })
  detail(@Req() req: Request, @Param('id') id: string, @Param('roleId') roleId: string) {
    return this.role.getTeamRoleForTeam(requireUser(req).id, id, roleId);
  }

  @Post(':id/roles')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '为指定团队创建角色' })
  create(@Req() req: Request, @Param('id') id: string, @Body() dto: CreateRoleDto) {
    return this.role.createTeamRoleForTeam(requireUser(req).id, id, dto);
  }

  @Patch(':id/roles/:roleId')
  @ApiOperation({ summary: '更新指定团队的角色（系统角色不可改权限/编码）' })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRoleDto
  ) {
    return this.role.updateTeamRoleForTeam(requireUser(req).id, id, roleId, dto);
  }

  @Delete(':id/roles/:roleId')
  @ApiOperation({ summary: '删除指定团队的角色（系统角色不可删，有引用时拒绝）' })
  remove(@Req() req: Request, @Param('id') id: string, @Param('roleId') roleId: string) {
    return this.role.deleteTeamRoleForTeam(requireUser(req).id, id, roleId);
  }
}
