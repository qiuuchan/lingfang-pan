import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { CloudActionDeploymentService } from './cloud-action-deployment.service';
import { CloudActionRoutingService } from './cloud-action-routing.service';
import {
  CreateCloudActionDeploymentDto,
  UpdateCloudActionRoutingDto,
} from './dto/cloud-action-deployment.dto';

@ApiTags('Cloud Action Deployments')
@ApiBearerAuth()
@RequirePermission('team.plugin.edit_draft')
@Controller('api')
export class CloudActionDeploymentController {
  constructor(
    @Inject(CloudActionDeploymentService)
    private readonly deployments: CloudActionDeploymentService,
    @Inject(CloudActionRoutingService) private readonly routing: CloudActionRoutingService
  ) {}

  @Post('cloud-action-deployments')
  create(@Req() req: Request, @Body() body: CreateCloudActionDeploymentDto) {
    return this.deployments.create(requireUser(req).id, body);
  }

  @Get('cloud-actions/:releaseId/:actionId/deployments')
  list(
    @Req() req: Request,
    @Param('releaseId') releaseId: string,
    @Param('actionId') actionId: string
  ) {
    return this.deployments.list(requireUser(req).id, releaseId, actionId);
  }

  @Post('cloud-action-deployments/:id/verify')
  @HttpCode(200)
  verify(@Req() req: Request, @Param('id') id: string) {
    return this.deployments.verify(requireUser(req).id, id);
  }

  @Post('cloud-action-deployments/:id/disable')
  @HttpCode(200)
  disable(@Req() req: Request, @Param('id') id: string) {
    return this.deployments.disable(requireUser(req).id, id);
  }

  @Post('cloud-action-deployments/:id/retire')
  @HttpCode(200)
  retire(@Req() req: Request, @Param('id') id: string) {
    return this.deployments.retire(requireUser(req).id, id);
  }

  @Post('cloud-action-deployments/:id/rotate-secret')
  @HttpCode(200)
  rotateSecret(@Req() req: Request, @Param('id') id: string) {
    return this.deployments.rotateSecret(requireUser(req).id, id);
  }

  @Put('cloud-actions/:releaseId/:actionId/routing')
  updateRouting(
    @Req() req: Request,
    @Param('releaseId') releaseId: string,
    @Param('actionId') actionId: string,
    @Body() body: UpdateCloudActionRoutingDto
  ) {
    return this.routing.update(requireUser(req).id, releaseId, actionId, body);
  }

  @Get('cloud-actions/:releaseId/:actionId/routing')
  getRouting(
    @Req() req: Request,
    @Param('releaseId') releaseId: string,
    @Param('actionId') actionId: string,
    @Query('action_contract_version') version: string,
    @Query('action_surface_sha256') surface: string,
    @Query('environment') environment: 'PREVIEW' | 'PRODUCTION' = 'PRODUCTION'
  ) {
    return this.routing.get(
      requireUser(req).id,
      releaseId,
      actionId,
      version,
      surface,
      environment
    );
  }
}
