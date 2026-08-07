import { Inject, Injectable } from '@nestjs/common';
import { badRequest } from '../common';
import { PluginActionRegistryService } from './plugin-action-registry.service';
import { PluginGovernanceService } from './plugin-governance.service';

export type GovernanceActionContext = {
  userId: string;
  target: {
    package_id: string;
    release_id: string;
    sha256: string;
    action_id: string;
    action_contract_version: string;
    action_surface_sha256: string;
  };
  caller: 'DESKTOP' | 'WEB' | 'WORKFLOW' | 'CLOUD' | 'ACTION';
  invocationKind: 'STANDARD' | 'PREVIEW';
  webPreview?: boolean;
};

@Injectable()
export class GovernanceActionAdapter {
  constructor(
    @Inject(PluginActionRegistryService) private readonly actions: PluginActionRegistryService,
    @Inject(PluginGovernanceService) private readonly governance: PluginGovernanceService
  ) {}
  async authorize(context: GovernanceActionContext) {
    if (!context.userId || !context.target?.release_id) throw badRequest('Action 调用上下文无效');
    const resolved = await this.actions.resolve(context.target);
    const execution = resolved.action.execution as { runtime_type?: string } | undefined;
    const runtimeType = String(execution?.runtime_type || 'client');
    const operations = ['invoke_action'] as Array<
      'invoke_action' | 'run_workflow' | 'execute_cloud' | 'web_preview'
    >;
    if (context.caller === 'WORKFLOW' || runtimeType === 'workflow')
      operations.push('run_workflow');
    if (context.caller === 'CLOUD' || runtimeType === 'cloud') operations.push('execute_cloud');
    if (context.webPreview || context.invocationKind === 'PREVIEW') operations.push('web_preview');
    operations.sort();
    const authorization = await this.governance.authorizeRelease(
      context.userId,
      {
        releaseId: context.target.release_id,
        packageId: context.target.package_id,
        sha256: context.target.sha256,
      },
      operations,
      {
        action: {
          action_id: context.target.action_id,
          action_contract_version: context.target.action_contract_version,
          action_surface_sha256: context.target.action_surface_sha256,
        },
      }
    );
    return {
      decision: authorization.decision,
      source: authorization.source,
      release: authorization.release,
      action: resolved.action,
      target: resolved.target,
      required_operations: operations,
    };
  }
}
