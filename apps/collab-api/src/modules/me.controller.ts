import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { TeamService } from './team.service';

@ApiTags('Onboarding')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Get('onboarding')
  @ApiOperation({ summary: '获取本地客户端下一步状态' })
  onboarding(@Req() req: Request) {
    return this.team.onboarding(requireUser(req).id);
  }
}