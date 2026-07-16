import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { AutomationScheduleService } from './automation-schedule.service';
import { CreateAutomationScheduleDto, ScheduleGenerationDto, UpdateAutomationScheduleDto } from './dto/automation-schedule.dto';

@ApiTags('Automation Schedules')
@ApiBearerAuth()
@RequirePermission('team.plugin.edit_draft')
@Controller('api/automation-schedules')
export class AutomationScheduleController {
  constructor(@Inject(AutomationScheduleService) private readonly schedules: AutomationScheduleService) {}
  @Get() list(@Req() req: Request) { return this.schedules.list(requireUser(req).id); }
  @Post() create(@Req() req: Request, @Body() body: CreateAutomationScheduleDto) { return this.schedules.create(requireUser(req).id, body); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() body: UpdateAutomationScheduleDto) { return this.schedules.update(requireUser(req).id, id, body); }
  @Patch(':id/pause') pause(@Req() req: Request, @Param('id') id: string, @Body() body: ScheduleGenerationDto) { return this.schedules.pause(requireUser(req).id, id, body.expected_generation); }
  @Patch(':id/resume') resume(@Req() req: Request, @Param('id') id: string, @Body() body: ScheduleGenerationDto) { return this.schedules.resume(requireUser(req).id, id, body.expected_generation); }
  @Delete(':id') remove(@Req() req: Request, @Param('id') id: string, @Body() body: ScheduleGenerationDto) { return this.schedules.remove(requireUser(req).id, id, body.expected_generation); }
}
