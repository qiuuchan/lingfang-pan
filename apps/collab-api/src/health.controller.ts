import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './common';

// 运行时读取 package.json 的 version（源文件位于 src/、产物位于 dist/，二者各上一级即项目根的 package.json）。
// 不用 import 的原因：tsconfig 未启用 resolveJsonModule，且 rootDir=src 会拒绝引入 src 外的 .json。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

@ApiTags('Health')
@Controller()
export class HealthController {
  @Public()
  @Get('health')
  @ApiOperation({ summary: '服务健康检查' })
  health() {
    // 返回 version 供 collab-admin 做版本比对，避免管理端因缺字段永远误判为「有新版本」。
    return { status: 'ok', service: 'collab-api', version };
  }
}