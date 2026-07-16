type PluginPolicyOperation = 'install' | 'update' | 'run_local' | 'invoke_action' | 'run_workflow' | 'execute_cloud' | 'manage_schedule' | 'trigger_schedule' | 'shared_data_read' | 'shared_data_write' | 'web_preview';
type PluginPolicyResource = {
  team_id: string; package_id: string; release_id: string; sha256: string; source_kind: string;
  runtime_type: string; package_policy_surface_sha256: string; declared_capabilities: string[];
  action?: { action_id: string; action_contract_version: string; action_surface_sha256: string };
  workflow?: { workflow_release_id: string; workflow_plan_sha256: string };
};
type PolicyRule = { rule_id: string; effect: 'ALLOW' | 'DENY'; operations: PluginPolicyOperation[]; target: { kind: 'TEAM' } | { kind: 'PACKAGE'; package_id: string; approved_surface_sha256?: string } | { kind: 'ACTION'; package_id: string; action_id: string; action_contract_version: string; action_surface_sha256: string } | { kind: 'WORKFLOW'; workflow_release_id: string; workflow_plan_sha256: string } };
type TeamPluginPolicyDocumentV1 = { enforcement_mode: 'AUDIT' | 'ENFORCE'; allowed_source_kinds: string[]; denied_capability_kinds: string[]; rules: PolicyRule[] };
type ReasonCode = 'platform_gate_denied' | 'team_source_denied' | 'team_capability_denied' | 'team_rule_denied' | 'high_risk_not_enabled' | 'package_surface_changed' | 'action_surface_changed' | 'workflow_plan_changed' | 'user_grant_denied' | 'role_grant_denied' | 'allowed';
type OperationResult = { operation: PluginPolicyOperation; allowed: boolean; reason_code: ReasonCode; matched: Array<{ layer: 'PLATFORM' | 'TEAM' | 'USER_GRANT' | 'ROLE_GRANT' | 'REQUEST'; effect: 'ALLOW' | 'DENY'; rule_id?: string }> };
export type PluginPolicyDecision = { allowed: boolean; required_operations: PluginPolicyOperation[]; team_id: string; policy_revision: number; enforcement_mode: 'AUDIT' | 'ENFORCE'; reason_code: ReasonCode; reason: string; operation_results: OperationResult[] };
const HIGH_RISK_PLUGIN_POLICY_OPERATIONS = new Set<PluginPolicyOperation>(['invoke_action', 'run_workflow', 'execute_cloud', 'manage_schedule', 'trigger_schedule', 'shared_data_read', 'shared_data_write']);

type GrantEffect = 'ALLOW' | 'DENY';
export type PluginGovernanceFacts = {
  resource: PluginPolicyResource;
  requiredOperations: PluginPolicyOperation[];
  policyRevision: number;
  policy: TeamPluginPolicyDocumentV1 | null;
  platformAllowed: boolean;
  entitlementAllowed: boolean;
  userGrant?: GrantEffect;
  roleGrant?: GrantEffect;
};

function targetMatches(rule: TeamPluginPolicyDocumentV1['rules'][number], resource: PluginPolicyResource): boolean {
  const target = rule.target;
  if (target.kind === 'TEAM') return true;
  if (target.kind === 'PACKAGE') {
    return target.package_id === resource.package_id
      && (!target.approved_surface_sha256 || target.approved_surface_sha256 === resource.package_policy_surface_sha256);
  }
  if (target.kind === 'ACTION') {
    return target.package_id === resource.package_id
      && target.action_id === resource.action?.action_id
      && target.action_contract_version === resource.action.action_contract_version
      && target.action_surface_sha256 === resource.action.action_surface_sha256;
  }
  return target.workflow_release_id === resource.workflow?.workflow_release_id
    && target.workflow_plan_sha256 === resource.workflow.workflow_plan_sha256;
}

function specificity(rule: TeamPluginPolicyDocumentV1['rules'][number]): number {
  return { TEAM: 0, PACKAGE: 1, ACTION: 2, WORKFLOW: 2 }[rule.target.kind];
}

function staleSurfaceReason(operation: PluginPolicyOperation, policy: TeamPluginPolicyDocumentV1, resource: PluginPolicyResource): ReasonCode | null {
  if (!HIGH_RISK_PLUGIN_POLICY_OPERATIONS.has(operation)) return null;
  const rules = policy.rules.filter((rule) => rule.effect === 'ALLOW' && rule.operations.includes(operation));
  if (rules.some((rule) => rule.target.kind === 'PACKAGE'
    && rule.target.package_id === resource.package_id
    && rule.target.approved_surface_sha256
    && rule.target.approved_surface_sha256 !== resource.package_policy_surface_sha256)) return 'package_surface_changed';
  if (rules.some((rule) => rule.target.kind === 'ACTION'
    && rule.target.package_id === resource.package_id
    && rule.target.action_id === resource.action?.action_id
    && rule.target.action_contract_version === resource.action.action_contract_version
    && rule.target.action_surface_sha256 !== resource.action.action_surface_sha256)) return 'action_surface_changed';
  if (rules.some((rule) => rule.target.kind === 'WORKFLOW'
    && rule.target.workflow_release_id === resource.workflow?.workflow_release_id
    && rule.target.workflow_plan_sha256 !== resource.workflow.workflow_plan_sha256)) return 'workflow_plan_changed';
  return null;
}

function teamRuleResult(operation: PluginPolicyOperation, facts: PluginGovernanceFacts) {
  const policy = facts.policy;
  if (!policy) return null;
  if (policy.allowed_source_kinds.length > 0 && !policy.allowed_source_kinds.includes(facts.resource.source_kind)) {
    return { allowed: false, reasonCode: 'team_source_denied' as const, matched: [{ layer: 'TEAM' as const, effect: 'DENY' as const }] };
  }
  if (facts.resource.declared_capabilities.some((capability) => policy.denied_capability_kinds.includes(capability))) {
    return { allowed: false, reasonCode: 'team_capability_denied' as const, matched: [{ layer: 'TEAM' as const, effect: 'DENY' as const }] };
  }
  const candidates = policy.rules.filter((rule) => rule.operations.includes(operation) && targetMatches(rule, facts.resource));
  if (candidates.length === 0) return null;
  const maximum = Math.max(...candidates.map(specificity));
  const matches = candidates.filter((rule) => specificity(rule) === maximum);
  const winner = matches.some((rule) => rule.effect === 'DENY') ? 'DENY' : 'ALLOW';
  return {
    allowed: winner === 'ALLOW',
    reasonCode: winner === 'ALLOW' ? 'allowed' as const : 'team_rule_denied' as const,
    matched: matches.filter((rule) => rule.effect === winner).map((rule) => ({ layer: 'TEAM' as const, effect: winner, rule_id: rule.rule_id })),
  };
}

function evaluateOperation(operation: PluginPolicyOperation, facts: PluginGovernanceFacts) {
  if (!facts.platformAllowed || !facts.entitlementAllowed) {
    return { operation, allowed: false, reason_code: 'platform_gate_denied' as const, matched: [{ layer: 'PLATFORM' as const, effect: 'DENY' as const }] };
  }
  const team = teamRuleResult(operation, facts);
  if (team?.allowed === false) return { operation, allowed: false, reason_code: team.reasonCode, matched: team.matched };
  if (HIGH_RISK_PLUGIN_POLICY_OPERATIONS.has(operation) && team?.allowed !== true) {
    const staleReason = facts.policy ? staleSurfaceReason(operation, facts.policy, facts.resource) : null;
    return { operation, allowed: false, reason_code: staleReason ?? 'high_risk_not_enabled', matched: [{ layer: 'TEAM' as const, effect: 'DENY' as const }] };
  }
  if (facts.userGrant === 'DENY') return { operation, allowed: false, reason_code: 'user_grant_denied' as const, matched: [{ layer: 'USER_GRANT' as const, effect: 'DENY' as const }] };
  if (facts.userGrant === 'ALLOW') return { operation, allowed: true, reason_code: 'allowed' as const, matched: [{ layer: 'USER_GRANT' as const, effect: 'ALLOW' as const }] };
  if (facts.roleGrant === 'DENY') return { operation, allowed: false, reason_code: 'role_grant_denied' as const, matched: [{ layer: 'ROLE_GRANT' as const, effect: 'DENY' as const }] };
  if (facts.roleGrant === 'ALLOW') return { operation, allowed: true, reason_code: 'allowed' as const, matched: [{ layer: 'ROLE_GRANT' as const, effect: 'ALLOW' as const }] };
  if (team?.allowed === true) return { operation, allowed: true, reason_code: 'allowed' as const, matched: team.matched };
  return { operation, allowed: true, reason_code: 'allowed' as const, matched: [{ layer: 'REQUEST' as const, effect: 'ALLOW' as const }] };
}

export function evaluatePluginGovernance(facts: PluginGovernanceFacts): PluginPolicyDecision {
  const requiredOperations = [...new Set(facts.requiredOperations)].sort();
  if (requiredOperations.length === 0) throw new Error('requiredOperations must not be empty');
  const operationResults = requiredOperations.map((operation) => evaluateOperation(operation, facts));
  const firstDenied = operationResults.find((result) => !result.allowed);
  return {
    allowed: !firstDenied,
    required_operations: requiredOperations,
    team_id: facts.resource.team_id,
    policy_revision: facts.policyRevision,
    enforcement_mode: facts.policy?.enforcement_mode ?? 'ENFORCE',
    reason_code: firstDenied?.reason_code ?? 'allowed',
    reason: firstDenied ? `插件策略拒绝操作：${firstDenied.operation}` : '插件策略允许请求',
    operation_results: operationResults as PluginPolicyDecision['operation_results'],
  };
}
