// 应用版本发布公开控制器：4 个 /api/releases/* 路由，全 @Public（官网 + 桌面端检查更新用，无需登录）。
// 仅暴露 status='PUBLISHED' 的版本；写操作（create/publish/asset）在 AdminController（ensurePlatformAdmin）。
// @Public 放方法级（与 HealthController 一致），非 class 级，避免装饰器元数据歧义。
// 路由声明顺序敏感：tauri-update 必须在 :version 之前，否则 'tauri-update' 被当作 version 参数。
import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common';
import { ReleaseService } from './release.service';
import { ReleaseLatestQueryDto, ReleaseListQueryDto, ReleaseTauriQueryDto } from './dto/release.dto';

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
  @Get('tauri-update')
  @ApiOperation({ summary: 'Tauri updater 契约端点（单 asset，无更新返 204）' })
  async tauriUpdate(
    @Query() query: ReleaseTauriQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    // 复用 latest 查询 + 挑单 asset，映射为 Tauri 固定契约 {version, pub_date, url, signature, notes}。
    // 无已发布版本 / 无匹配平台产物 → 204 No Content（Tauri updater 把非 200 当「无更新」）。
    //
    // 修复 H6：此前用 @Res({ passthrough: true }) + return null。
    // passthrough 模式下返回值仍会经全局 ClassSerializerInterceptor 序列化，
    // 某些 Nest/Express 组合下会把 null 序列化为字符串 "null" 写进 body，
    // 把 204 变成 200 或触发 ERR_HTTP_HEADERS_SENT，破坏 Tauri 更新判定。
    // 改用裸 @Res()（不经 passthrough，彻底绕过拦截器），显式 res.status(204).end() / res.status(200).json()。
    // 裸 @Res() 下 Nest 不再接管响应，必须自行写 body；此方法已完全自管，安全。
    const manifest = await this.releases.tauriManifest(
      query.channel ?? 'STABLE',
      query.platform,
      query.arch,
    );
    if (!manifest) {
      // 204 No Content：HTTP 规范 204 必须无 body，.end() 显式收尾不发 body。
      res.status(204).end();
      return;
    }
    res.status(200).json(manifest);
  }

  @Public()
  @Get(':version')
  @ApiOperation({ summary: '指定版本详情（公开）' })
  get(@Param('version') version: string, @Query('channel') channel?: 'STABLE' | 'BETA') {
    return this.releases.get(version, channel);
  }
}
