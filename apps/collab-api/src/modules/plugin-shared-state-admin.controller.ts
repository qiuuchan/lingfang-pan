import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Readable } from 'node:stream';
import { requireUser } from '../common';
import { PluginSharedStateService } from './plugin-shared-state.service';

/**
 * Team-admin control plane for shared namespaces.
 *
 * This surface intentionally uses the login/session principal and never asks
 * the browser for an invocation id or bridge token.  It returns namespace
 * metadata only; value bodies are available only through the invocation-scoped
 * runtime API, while export is an explicit owner/admin action.
 */
@ApiTags('PluginSharedStateAdmin')
@ApiBearerAuth()
@Controller('api/teams/current/plugin-shared/namespaces')
export class PluginSharedStateAdminController {
  constructor(
    @Inject(PluginSharedStateService) private readonly shared: PluginSharedStateService
  ) {}

  @Get()
  @ApiOperation({ summary: '团队管理员查看共享命名空间元数据' })
  list(@Req() req: Request) {
    return this.shared.adminListNamespaces(requireUser(req).id);
  }

  @Get(':id/export')
  @ApiOperation({ summary: '团队管理员导出共享命名空间 JSONL' })
  async export(@Req() req: Request, @Param('id') id: string) {
    const exported = await this.shared.adminExportNamespace(requireUser(req).id, id);
    return new StreamableFile(Readable.from(exported.lines), {
      type: 'application/x-ndjson; charset=utf-8',
      disposition: `attachment; filename="plugin-shared-${exported.namespaceId}-g${exported.generation}.jsonl"`,
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: '团队管理员停用共享命名空间' })
  delete(@Req() req: Request, @Param('id') id: string) {
    return this.shared.adminDeleteNamespace(requireUser(req).id, id);
  }

  @Put(':id/reactivate')
  @ApiOperation({ summary: '团队管理员重新激活共享命名空间' })
  reactivate(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.shared.adminReactivateNamespace(requireUser(req).id, id, body);
  }

  @Put(':id/values/:key/migrate')
  @ApiOperation({ summary: '团队管理员执行无 ArtifactRef 的共享值 schema 迁移' })
  migrate(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() body: unknown
  ) {
    return this.shared.adminMigrateNamespaceValue(requireUser(req).id, id, key, body);
  }
}
