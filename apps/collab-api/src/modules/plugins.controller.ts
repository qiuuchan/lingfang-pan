import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CollabService } from './collab.service';

@ApiTags('Plugins')
@ApiBearerAuth()
@Controller('plugins')
export class PluginsController {
  constructor(@Inject(CollabService) private readonly collab: CollabService) {}

  @Get('available')
  @ApiOperation({ summary: '本地客户端可用插件列表' })
  available() {
    return this.collab.availablePlugins();
  }
}