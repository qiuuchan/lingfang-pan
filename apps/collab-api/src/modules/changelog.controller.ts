// 更新日志公开控制器：GET /api/changelog（@Public，不鉴权）。
// 供官网落地页更新日志页展示，无需登录。数据源为 Gitee 私有仓库 release（配置由 admin 在设置页维护）。
//
// 设计契约（详见子任务 design.md）：
//  - 与 release.controller 的 /api/releases 刻意职责分离：/api/releases 服务 Tauri updater（需 signature）
//    与本地版本目录；/api/changelog 服务 Gitee markdown 时间线。两者数据源、字段、排序键均不同，不合并。
//  - 全流程永不抛（service 层 catch 所有异常归入 degraded），controller 直接 return，HTTP 恒 200。
//  - @Public 放方法级（与 PlatformInfoController 一致），非 class 级，避免装饰器元数据歧义。
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common';
import { GiteeChangelogService } from './gitee-changelog.service';

@ApiTags('Changelog')
@Controller('changelog')
export class ChangelogController {
  constructor(@Inject(GiteeChangelogService) private readonly changelog: GiteeChangelogService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '更新日志（公开，Gitee release 时间线）' })
  list() {
    // 返回 ChangelogResponse：{source, releases, degraded, message?}。
    // service.getChangelog 内部全 catch，永不抛，controller 无需 try/catch。
    return this.changelog.getChangelog();
  }
}
