import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { badRequest, requireUser } from '../common';
import { AuthService } from './auth.service';
import { PluginGovernancePolicyService } from './plugin-governance-policy.service';
import { PluginGovernanceService } from './plugin-governance.service';

type PublishBody = { expected_revision: number; document: { schema_version: 1; enforcement_mode: 'AUDIT' | 'ENFORCE'; allowed_source_kinds: string[]; denied_capability_kinds: string[]; rules: unknown[] }; change_reason?: string };
type RollbackBody = { expected_revision: number; source_revision: number; change_reason?: string };
type EvaluationTarget = { release_id: string; package_id?: string; sha256?: string; required_operations: Array<'install' | 'update' | 'run_local' | 'invoke_action' | 'run_workflow' | 'execute_cloud' | 'manage_schedule' | 'trigger_schedule' | 'shared_data_read' | 'shared_data_write' | 'web_preview'> };

function assertRevision(value: unknown, field: string, positive = false): asserts value is number { if (!Number.isInteger(value) || (positive ? Number(value) < 1 : Number(value) < 0)) throw badRequest(`${field} 无效`); }
function assertDocument(value: unknown): asserts value is PublishBody['document'] {
  const document = value as Partial<PublishBody['document']> | null;
  if (!document || document.schema_version !== 1 || !['AUDIT', 'ENFORCE'].includes(String(document.enforcement_mode)) || !Array.isArray(document.allowed_source_kinds) || !Array.isArray(document.denied_capability_kinds) || !Array.isArray(document.rules) || document.rules.length > 500) throw badRequest('插件策略文档无效');
  const operations = new Set(['install', 'update', 'run_local', 'invoke_action', 'run_workflow', 'execute_cloud', 'manage_schedule', 'trigger_schedule', 'shared_data_read', 'shared_data_write', 'web_preview']);
  const highRisk = new Set(['invoke_action', 'run_workflow', 'execute_cloud', 'manage_schedule', 'trigger_schedule', 'shared_data_read', 'shared_data_write']);
  const ids = new Set<string>();
  document.rules.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('策略规则必须是对象', { index });
    const rule = raw as Record<string, unknown>; const id = String(rule.rule_id || ''); const effect = rule.effect; const target = rule.target as Record<string, unknown> | undefined;
    if (!id || id.length > 128 || ids.has(id) || !['ALLOW', 'DENY'].includes(String(effect)) || !Array.isArray(rule.operations) || rule.operations.length < 1 || rule.operations.some((operation) => !operations.has(String(operation))) || !target || !['TEAM', 'PACKAGE', 'ACTION', 'WORKFLOW'].includes(String(target.kind))) throw badRequest('插件策略规则无效', { index });
    ids.add(id);
    const allowsHighRisk = effect === 'ALLOW' && rule.operations.some((operation) => highRisk.has(String(operation)));
    if (allowsHighRisk && target.kind === 'TEAM') throw badRequest('高风险操作不能按整个团队直接允许', { index });
    if (allowsHighRisk && target.kind === 'PACKAGE' && !/^[a-f0-9]{64}$/.test(String(target.approved_surface_sha256 || ''))) throw badRequest('package 高风险允许必须绑定有效 surface digest', { index });
    if (target.kind === 'ACTION' && (!target.package_id || !target.action_id || !target.action_contract_version || !/^[a-f0-9]{64}$/.test(String(target.action_surface_sha256 || '')))) throw badRequest('Action 策略目标无效', { index });
    if (target.kind === 'WORKFLOW' && (!target.workflow_release_id || !/^[a-f0-9]{64}$/.test(String(target.workflow_plan_sha256 || '')))) throw badRequest('工作流策略目标无效', { index });
  });
}
function assertTarget(value: unknown): asserts value is EvaluationTarget { const target = value as Partial<EvaluationTarget> | null; const allowed = new Set(['install', 'update', 'run_local', 'invoke_action', 'run_workflow', 'execute_cloud', 'manage_schedule', 'trigger_schedule', 'shared_data_read', 'shared_data_write', 'web_preview']); if (!target || typeof target.release_id !== 'string' || !target.release_id || !Array.isArray(target.required_operations) || target.required_operations.length < 1 || target.required_operations.length > 11 || target.required_operations.some((operation) => !allowed.has(String(operation)))) throw badRequest('策略评估目标无效'); }

@ApiTags('PluginGovernance')
@ApiBearerAuth()
@Controller('api/teams/current/plugin-policy')
export class PluginGovernanceController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PluginGovernancePolicyService) private readonly policies: PluginGovernancePolicyService, @Inject(PluginGovernanceService) private readonly governance: PluginGovernanceService) {}
  private async context(req: Request) { const user = requireUser(req); await this.auth.ensurePermission(user.id, 'team.plugin.grant.manage'); return { user, membership: await this.auth.ensureCurrentTeam(user.id) }; }
  @Get() async active(@Req() req: Request) { const { membership } = await this.context(req); return this.policies.active(membership.teamId); }
  @Get('history') async history(@Req() req: Request) { const { membership } = await this.context(req); return { revisions: await this.policies.history(membership.teamId) }; }
  @Post('publish') async publish(@Req() req: Request, @Body() body: PublishBody) { assertRevision(body?.expected_revision, 'expected_revision'); assertDocument(body?.document); const { user, membership } = await this.context(req); return this.policies.publish(membership.teamId, user.id, body.expected_revision, body.document, body.change_reason); }
  @Post('rollback') async rollback(@Req() req: Request, @Body() body: RollbackBody) { assertRevision(body?.expected_revision, 'expected_revision'); assertRevision(body?.source_revision, 'source_revision', true); const { user, membership } = await this.context(req); return this.policies.rollback(membership.teamId, user.id, body.expected_revision, body.source_revision, body.change_reason); }

  @Post('explain') async explain(@Req() req: Request, @Body() body: EvaluationTarget) { assertTarget(body); await this.context(req); return this.policiesEvaluation(req, body); }

  @Post('preview') async preview(@Req() req: Request, @Body() body: { document: PublishBody['document']; targets: EvaluationTarget[] }) { assertDocument(body?.document); if (!Array.isArray(body?.targets) || body.targets.length > 500) throw badRequest('策略预检目标无效'); body.targets.forEach(assertTarget); await this.context(req); return { results: await Promise.all(body.targets.map((target) => this.policiesEvaluation(req, target, body.document))) }; }

  private async policiesEvaluation(req: Request, target: EvaluationTarget, policyOverride?: PublishBody['document']) { const user = requireUser(req); const result = await this.governance.authorizeRelease(user.id, { releaseId: target.release_id, packageId: target.package_id, sha256: target.sha256 }, target.required_operations, { enforce: false, policyOverride: policyOverride as never }); return result.decision; }
}
