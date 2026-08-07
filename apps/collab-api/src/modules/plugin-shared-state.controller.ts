import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Put,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SharedNamespaceOwnerKind } from '@lingfang/contract';
import type { Request } from 'express';
import { Readable } from 'node:stream';
import { AppError, requireUser } from '../common';
import {
  PluginSharedStateService,
  type SharedNamespaceLocator,
} from './plugin-shared-state.service';

@ApiTags('PluginSharedState')
@ApiBearerAuth()
@Controller('api/plugin-shared/namespaces/:ownerKind/:ownerId/:name')
export class PluginSharedStateController {
  constructor(
    @Inject(PluginSharedStateService) private readonly shared: PluginSharedStateService
  ) {}

  @Get('values/:key')
  async get(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>
  ) {
    const principal = await this.principal(req, invocationId);
    return this.shared.get(principal, locatorFrom(params), params.key);
  }

  @Put('values/:key')
  async set(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>,
    @Body() body: unknown
  ) {
    const principal = await this.principal(req, invocationId);
    return this.shared.set(principal, locatorFrom(params), params.key, body);
  }

  @Get('values')
  async list(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>,
    @Query('page_cursor') pageCursor?: string,
    @Query('relist_token') relistToken?: string,
    @Query('limit') limit?: string
  ) {
    const principal = await this.principal(req, invocationId);
    return this.shared.list(principal, locatorFrom(params), { pageCursor, relistToken, limit });
  }

  @Delete('values/:key')
  async delete(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>,
    @Body() body: unknown
  ) {
    const principal = await this.principal(req, invocationId);
    const expectedRevision =
      body && typeof body === 'object'
        ? (body as { expected_revision?: unknown }).expected_revision
        : undefined;
    return this.shared.delete(principal, locatorFrom(params), params.key, expectedRevision);
  }

  @Put('schema-migrations/:key')
  async migrate(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>,
    @Body() body: unknown
  ) {
    const principal = await this.principal(req, invocationId);
    return this.shared.migrate(principal, locatorFrom(params), params.key, body);
  }

  @Delete()
  async deleteNamespace(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>
  ) {
    const principal = await this.principal(req, invocationId);
    return this.shared.deleteNamespace(principal, locatorFrom(params));
  }

  @Put('reactivate')
  async reactivateNamespace(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>,
    @Body() body: unknown
  ) {
    const principal = await this.principal(req, invocationId);
    return this.shared.reactivateNamespace(principal, locatorFrom(params), body);
  }

  @Get('export')
  async exportNamespace(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>
  ) {
    const principal = await this.principal(req, invocationId);
    const exported = await this.shared.exportNamespace(principal, locatorFrom(params));
    return new StreamableFile(Readable.from(exported.lines), {
      type: 'application/x-ndjson; charset=utf-8',
      disposition: `attachment; filename="plugin-shared-${exported.namespaceId}-g${exported.generation}.jsonl"`,
    });
  }

  @Get('changes')
  async changes(
    @Req() req: Request,
    @Headers('x-plugin-invocation-id') invocationId: string | undefined,
    @Param() params: Record<string, string>,
    @Query('after') after?: string,
    @Query('limit') limit?: string
  ) {
    const principal = await this.principal(req, invocationId);
    return this.shared.changes(principal, locatorFrom(params), after, limit);
  }

  private principal(req: Request, invocationId: string | undefined) {
    const user = requireUser(req);
    return this.shared.resolvePrincipal(user.id, user.teamId, invocationId ?? '');
  }
}

function locatorFrom(params: Record<string, string>): SharedNamespaceLocator {
  const ownerKind = SharedNamespaceOwnerKind.safeParse(
    String(params.ownerKind || '').toUpperCase()
  );
  if (!ownerKind.success)
    throw new AppError(400, 'shared_namespace_invalid', 'ownerKind 必须是 PACKAGE 或 WORKFLOW');
  return {
    ownerKind: ownerKind.data,
    ownerId: params.ownerId ?? '',
    name: params.name ?? '',
  };
}
