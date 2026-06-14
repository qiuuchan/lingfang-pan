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
    @Res({ passthrough: true }) res: Response,
  ) {
    // 复用 latest 查询 + 挑单 asset，映射为 Tauri 固定契约 {version, pub_date, url, signature, notes}。
    // 无已发布版本 / 无匹配平台产物 → 204 No Content（Tauri updater 把非 200 当「无更新」）。
    // passthrough: true：保留 NestJS 标准响应处理（兼容全局 ClassSerializerInterceptor），
    //   仅用 res.status() 控制 HTTP 状态码。注意不可返回 res.send() 的结果（Response 对象本身），
    //   否则全局 ClassSerializerInterceptor 会尝试序列化 Response → 二次写响应 → Node ERR_INTERNAL_ASSERTION 崩溃。
    const manifest = await this.releases.tauriManifest(
      query.channel ?? 'STABLE',
      query.platform,
      query.arch,
    );
    if (!manifest) {
      // 204 No Content：仅设状态码，return null 让 Nest 标准 pipeline 收尾。
      //   Express 对 204 自动不发 body（HTTP 规范），无需手动 .end()/.send()。
      //   全局 ClassSerializerInterceptor 对 null 返回值序列化无害（不触发 Response 二次写）。
      res.status(204);
      return null;
    }
    res.status(200);
    return manifest;
  }

  @Public()
  @Get(':version')
  @ApiOperation({ summary: '指定版本详情（公开）' })
  get(@Param('version') version: string, @Query('channel') channel?: 'STABLE' | 'BETA') {
    return this.releases.get(version, channel);
  }
}
