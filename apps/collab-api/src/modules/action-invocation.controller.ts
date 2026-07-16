import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ActionErrorCode, ActionTarget } from '@lingfang/contract';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { badRequest, requireUser } from '../common';
import { ActionInvocationService } from './action-invocation.service';
import { PluginActionRegistryService } from './plugin-action-registry.service';

@ApiTags('PluginActionInvocations')
@ApiBearerAuth()
@Controller('api/plugin-actions/invocations')
export class ActionInvocationController {
  constructor(
    @Inject(ActionInvocationService) private readonly invocations: ActionInvocationService,
    @Inject(PluginActionRegistryService) private readonly actions: PluginActionRegistryService,
  ) {}

  @Post()
  async create(@Req() req: Request, @Body() body: any) {
    const user = requireUser(req);
    // The iframe supplies only a dependency alias. For root calls the desktop
    // host binds its active exact release; for nested calls the authenticated
    // parent invocation is the sole source of caller identity.
    const caller = body?.desktop_caller;
    const dependencyId = typeof caller?.dependency_id === 'string' ? caller.dependency_id.trim() : '';
    if (!dependencyId) throw badRequest('Desktop Action dependency identity 无效');
    const target = ActionTarget.safeParse(body?.target);
    if (!target.success) throw badRequest('Desktop Action target 无效');
    const parentInvocationId = typeof body?.parent_invocation_id === 'string' ? body.parent_invocation_id.trim() : '';
    const exactCaller = parentInvocationId
      ? await this.invocations.nestedCaller(user.id, parentInvocationId)
      : caller;
    if (!exactCaller || typeof exactCaller.package_id !== 'string' || typeof exactCaller.release_id !== 'string' || !/^[a-f0-9]{64}$/.test(String(exactCaller.sha256 || ''))) throw badRequest('Desktop Action caller identity 无效');
    await this.actions.assertDeclaredDependency(exactCaller, dependencyId, target.data);
    const callerId = parentInvocationId || `desktop-plugin:${createHash('sha256').update(JSON.stringify({ package_id: exactCaller.package_id, release_id: exactCaller.release_id, sha256: exactCaller.sha256 })).digest('hex')}`;
    const { desktop_caller: _ignored, caller: _untrustedCaller, preview: _untrustedPreview, parent_invocation_id: _untrustedParent, ...input } = body ?? {};
    return this.invocations.create(user.id, {
      ...input,
      target: target.data,
      caller: parentInvocationId ? { kind: 'ACTION', id: callerId } : { kind: 'DESKTOP', id: callerId },
      ...(parentInvocationId ? { parent_invocation_id: parentInvocationId } : {}),
    });
  }

  @Get(':id')
  get(@Req() req: Request, @Param('id') id: string) {
    return this.invocations.get(requireUser(req).id, id);
  }

  @Post(':id/claim')
  claim(@Req() req: Request, @Param('id') id: string) {
    return this.invocations.claimDesktop(requireUser(req).id, id);
  }

  @Post(':id/complete')
  complete(@Req() req: Request, @Param('id') id: string, @Body() body: { output?: unknown }) {
    if (!body?.output || typeof body.output !== 'object' || Array.isArray(body.output)) throw badRequest('Action output 必须是 JSON 对象');
    return this.invocations.completeDesktop(requireUser(req).id, id, body.output as Record<string, unknown>);
  }

  @Post(':id/fail')
  fail(@Req() req: Request, @Param('id') id: string, @Body() body: { code?: unknown; message?: unknown }) {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!ActionErrorCode.safeParse(code).success || !message) throw badRequest('Action failure code/message 无效');
    return this.invocations.failDesktop(requireUser(req).id, id, code, message);
  }

  @Post(':id/cancel')
  cancel(@Req() req: Request, @Param('id') id: string) {
    return this.invocations.cancel(requireUser(req).id, id);
  }
}
