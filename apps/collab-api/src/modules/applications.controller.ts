import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { TeamService } from './team.service';
import { SubmitApplicationDto } from './dto/applications.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller('team-admin-applications')
export class ApplicationsController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Post()
  @ApiOperation({ summary: '提交团队管理员申请' })
  submit(@Req() req: Request, @Body() body: SubmitApplicationDto) {
    return this.team.submitApplication(requireUser(req).id, body);
  }

  @Get('me')
  @ApiOperation({ summary: '查询自己的团队管理员申请状态' })
  mine(@Req() req: Request) {
    return this.team.myApplication(requireUser(req).id);
  }
}