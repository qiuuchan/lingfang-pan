// 平台公开信息控制器：GET /api/platform-info（@Public，不鉴权）。
// 供官网落地页 / 桌面端启动页展示平台名与 logo，无需登录。
// 仅暴露 SettingsService.getPublicInfo() 的白名单字段（platformName/logoUrl），
// 非公开设置（运营备注、未发布开关）绝不在本端点暴露。
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common';
import { SettingsService } from './settings.service';

@ApiTags('Platform')
@Controller()
export class PlatformInfoController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Public()
  @Get('platform-info')
  @ApiOperation({ summary: '平台公开信息（平台名/logo，免登录）' })
  info() {
    return this.settings.getPublicInfo();
  }
}
