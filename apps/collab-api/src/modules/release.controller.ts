// 应用版本发布公开控制器：3 个 /api/releases/* 路由，全 @Public（官网 + 桌面端检查更新用，无需登录）。
// 仅暴露 status='PUBLISHED' 的版本；写操作（create/publish/asset）在 AdminController（ensurePlatformAdmin）。
// @Public 放方法级（与 HealthController 一致），非 class 级，避免装饰器元数据歧义。
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common';
import { ReleaseService } from './release.service';
import { ReleaseLatestQueryDto, ReleaseListQueryDto } from './dto/release.dto';

@ApiTags('Releases')
@Controller('releases')
export class ReleaseController {
  constructor(@Inject(ReleaseService) private readonly releases: ReleaseService) {}

  @Public()
  @Get('latest')
  @ApiOperation({ summary: '最新版本（公开，官网/桌面端检查更新）' })
  latest(@Query() query: ReleaseLatestQueryDto) {
    return this.releases.latest(query);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: '已发布版本列表（公开，changelog 时间线）' })
  list(@Query() query: ReleaseListQueryDto, @Query('limit') limit?: string) {
    // limit 单参数接收（避开 @IsInt 在 query DTO 的隐式转换边界），service 内 clamp 到 [1,50]。
    const parsed = limit !== undefined && limit !== '' ? Number(limit) : undefined;
    return this.releases.list(query, Number.isFinite(parsed) ? parsed : undefined);
  }

  @Public()
  @Get(':version')
  @ApiOperation({ summary: '指定版本详情（公开）' })
  get(@Param('version') version: string, @Query('channel') channel?: 'STABLE' | 'BETA') {
    return this.releases.get(version, channel);
  }
}
