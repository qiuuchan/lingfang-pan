import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { TeamPoolService } from './pools.service';

@ApiTags('Pools')
@ApiBearerAuth()
@Controller('pools')
export class PoolsController {
  constructor(@Inject(TeamPoolService) private readonly pools: TeamPoolService) {}

  @RequirePermission('team.dashboard.view')
  @Get('available')
  @ApiOperation({ summary: '获取当前团队可用的资源池列表' })
  available(@Req() req: Request) {
    return this.pools.getAvailablePools(requireUser(req).id);
  }
}
