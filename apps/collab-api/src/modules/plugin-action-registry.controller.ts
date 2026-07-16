import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PluginActionRegistryService } from './plugin-action-registry.service';
@ApiTags('PluginActions') @ApiBearerAuth() @Controller('api')
export class PluginActionRegistryController {
  constructor(@Inject(PluginActionRegistryService) private readonly actions: PluginActionRegistryService) {}
  @Get('plugin-releases/:releaseId/actions') list(@Param('releaseId') releaseId: string) { return this.actions.list(releaseId); }
  @Post('plugin-actions/resolve') resolve(@Body() body: { package_id: string; release_id: string; sha256: string; action_id: string; action_contract_version: string; action_surface_sha256: string }) { return this.actions.resolve(body); }
}
