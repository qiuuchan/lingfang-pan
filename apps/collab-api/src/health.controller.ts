import { Controller, Get, HttpCode, Inject, Injectable, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from './common';
import { PrismaService } from './prisma.service';
import { AutomationReadinessService } from './automation/automation-readiness.service';

// 运行时读取 package.json 的 version（源文件位于 src/、产物位于 dist/，二者各上一级即项目根的 package.json）。
// 不用 import 的原因：tsconfig 未启用 resolveJsonModule，且 rootDir=src 会拒绝引入 src 外的 .json。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

/**
 * 深度就绪检查：执行原生 SELECT 1 验证数据库连通性。
 *
 * 与 /health（liveness，进程存活即返 200）区分：
 * - /health：容器进程是否在跑（K8s livenessProbe），不查依赖，失败说明进程崩溃需重启。
 * - /health/ready：依赖（DB）是否就绪（K8s readinessProbe），失败说明「进程在跑但暂不可服务」
 *   应从负载均衡摘除（而非重启），等 DB 恢复后自动恢复流量。
 *
 * SELECT 1 是最轻量的探活查询（不命中任何表、不占用连接池业务查询窗口），
 * 用 Prisma 的 tagged template $queryRaw 安全传参（此处无参数，纯探活）。
 */
@Injectable()
export class ReadinessService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(AutomationReadinessService) private readonly automation: AutomationReadinessService) {}

  async check() {
    try {
      // $queryRaw tagged template：Prisma 安全的原生查询入口（防注入）。
      // SELECT 1 仅校验连接可用，无副作用。
      await this.prisma.$queryRaw`SELECT 1`;
      const automation = await this.automation.check();
      return { status: automation.status === 'degraded' ? 'degraded' as const : 'ok' as const, db: 'up' as const, automation };
    } catch {
      // DB 不可达：返 degraded + 503，让反代/探活摘除流量，而非重启进程（进程本身健康）。
      return { status: 'degraded' as const, db: 'down' as const, automation: null };
    }
  }
}

@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService, @Inject(AutomationReadinessService) private readonly automation: AutomationReadinessService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: '服务存活检查（liveness，不查依赖）' })
  health() {
    // 返回 version 供 collab-admin 做版本比对，避免管理端因缺字段永远误判为「有新版本」。
    return { status: 'ok', service: 'collab-api', version };
  }

  /**
   * 就绪检查：含数据库连通性探活。
   * @Public 放行（不鉴权），便于容器编排（K8s readinessProbe）/反代健康检查无凭证轮询。
   * 成功 200 {status:ok, db:up}；DB 不可达 503 {status:degraded, db:down}。
   *
   * 用 @Res({ passthrough: true })：既能手动设 503 状态码，又能让 Nest 正常序列化返回体
   * （全 passthrough=false 会跳过拦截器/序列化，与全局 ClassSerializerInterceptor 不一致）。
   * 不抛 HttpException：避免走 AppExceptionFilter 被改写成 {code,message,requestId} 契约，
   * 探活响应需维持 {status,db} 结构便于编排系统解析。
   */
  @Public()
  @Get('health/ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '服务就绪检查（readiness，含数据库探活）' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.readiness.check();
    if (result.status === 'degraded') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE); // 503
    }
    return result;
  }

  @Get('api/automation/metrics')
  @ApiOperation({ summary: '自动化队列与 Endpoint 基础指标' })
  metrics() { return this.automation.metrics(); }
}
