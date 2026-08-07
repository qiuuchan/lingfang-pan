import { describe, expect, it } from 'vitest';
import {
  evaluatePluginGovernance,
  type PluginGovernanceFacts,
} from './plugin-governance-evaluator';

const digest = 'a'.repeat(64);
const base: PluginGovernanceFacts = {
  resource: {
    team_id: 't1',
    package_id: 'p1',
    release_id: 'r1',
    sha256: digest,
    source_kind: 'API',
    runtime_type: 'client',
    package_policy_surface_sha256: digest,
    declared_capabilities: [],
  },
  requiredOperations: ['run_local'],
  policyRevision: 0,
  policy: null,
  platformAllowed: true,
  entitlementAllowed: true,
};

const packageAllow = (
  operations: Array<PluginGovernanceFacts['requiredOperations'][number]> = ['invoke_action']
) => ({
  schema_version: 1 as const,
  enforcement_mode: 'ENFORCE' as const,
  allowed_source_kinds: [],
  denied_capability_kinds: [],
  rules: [
    {
      rule_id: 'package-allow',
      effect: 'ALLOW' as const,
      operations,
      target: { kind: 'PACKAGE' as const, package_id: 'p1', approved_surface_sha256: digest },
    },
  ],
});

const actionPolicy = (rules: Array<{ rule_id: string; effect: 'ALLOW' | 'DENY' }>) => ({
  schema_version: 1 as const,
  enforcement_mode: 'ENFORCE' as const,
  allowed_source_kinds: [],
  denied_capability_kinds: [],
  rules: rules.map((rule) => ({
    ...rule,
    operations: ['invoke_action' as const],
    target: {
      kind: 'ACTION' as const,
      package_id: 'p1',
      action_id: 'generate',
      action_contract_version: '1',
      action_surface_sha256: digest,
    },
  })),
});

describe('plugin governance evaluator', () => {
  it('keeps virtual revision zero compatible for local operations and closes high risk', () => {
    expect(evaluatePluginGovernance(base).allowed).toBe(true);
    const decision = evaluatePluginGovernance({ ...base, requiredOperations: ['invoke_action'] });
    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('high_risk_not_enabled');
  });

  it('platform denial cannot be overridden by lower layers', () => {
    const decision = evaluatePluginGovernance({
      ...base,
      platformAllowed: false,
      userGrant: 'ALLOW',
      roleGrant: 'ALLOW',
    });
    expect(decision.reason_code).toBe('platform_gate_denied');
  });

  it.each([
    {
      name: 'platform gate',
      facts: {
        platformAllowed: false,
        policy: packageAllow(),
        userGrant: 'ALLOW' as const,
        roleGrant: 'ALLOW' as const,
      },
      reason: 'platform_gate_denied',
    },
    {
      name: 'team rule',
      facts: {
        policy: {
          ...packageAllow(),
          rules: [{ ...packageAllow().rules[0], effect: 'DENY' as const }],
        },
        userGrant: 'ALLOW' as const,
        roleGrant: 'ALLOW' as const,
      },
      reason: 'team_rule_denied',
    },
    {
      name: 'user grant',
      facts: { policy: packageAllow(), userGrant: 'DENY' as const, roleGrant: 'ALLOW' as const },
      reason: 'user_grant_denied',
    },
    {
      name: 'role grant',
      facts: { policy: packageAllow(), roleGrant: 'DENY' as const },
      reason: 'role_grant_denied',
    },
  ])('$name has precedence over lower layers', ({ facts, reason }) => {
    const decision = evaluatePluginGovernance({
      ...base,
      requiredOperations: ['invoke_action'],
      ...facts,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe(reason);
    expect(decision.operation_results).toHaveLength(1);
  });

  it('request layer is the compatible default for local operation but not high risk', () => {
    const local = evaluatePluginGovernance({ ...base, requiredOperations: ['run_local'] });
    expect(local.allowed).toBe(true);
    expect(local.operation_results[0].matched).toEqual([{ layer: 'REQUEST', effect: 'ALLOW' }]);

    const highRisk = evaluatePluginGovernance({ ...base, requiredOperations: ['invoke_action'] });
    expect(highRisk.allowed).toBe(false);
    expect(highRisk.operation_results[0].matched).toEqual([{ layer: 'TEAM', effect: 'DENY' }]);
  });

  it('user allow overrides role deny while user deny overrides all grants', () => {
    expect(
      evaluatePluginGovernance({ ...base, userGrant: 'ALLOW', roleGrant: 'DENY' }).allowed
    ).toBe(true);
    expect(
      evaluatePluginGovernance({ ...base, userGrant: 'DENY', roleGrant: 'ALLOW' }).reason_code
    ).toBe('user_grant_denied');
  });

  it('team allow is still bounded by user and role grants, while user allow overrides role deny', () => {
    const teamAllowed = {
      ...base,
      requiredOperations: ['invoke_action'] as const,
      policy: packageAllow(),
    };
    expect(evaluatePluginGovernance({ ...teamAllowed, userGrant: 'DENY' }).reason_code).toBe(
      'user_grant_denied'
    );
    expect(evaluatePluginGovernance({ ...teamAllowed, roleGrant: 'DENY' }).reason_code).toBe(
      'role_grant_denied'
    );
    expect(
      evaluatePluginGovernance({ ...teamAllowed, userGrant: 'ALLOW', roleGrant: 'DENY' }).allowed
    ).toBe(true);
  });

  it('same-specificity team deny wins and compound operations are atomic', () => {
    const policy = {
      schema_version: 1 as const,
      enforcement_mode: 'ENFORCE' as const,
      allowed_source_kinds: [],
      denied_capability_kinds: [],
      rules: [
        {
          rule_id: 'allow',
          effect: 'ALLOW' as const,
          operations: ['invoke_action' as const],
          target: {
            kind: 'ACTION' as const,
            package_id: 'p1',
            action_id: 'generate',
            action_contract_version: '1',
            action_surface_sha256: digest,
          },
        },
        {
          rule_id: 'deny',
          effect: 'DENY' as const,
          operations: ['invoke_action' as const],
          target: {
            kind: 'ACTION' as const,
            package_id: 'p1',
            action_id: 'generate',
            action_contract_version: '1',
            action_surface_sha256: digest,
          },
        },
      ],
    };
    const resource = {
      ...base.resource,
      action: {
        action_id: 'generate',
        action_contract_version: '1',
        action_surface_sha256: digest,
      },
    };
    const decision = evaluatePluginGovernance({
      ...base,
      resource,
      policyRevision: 1,
      policy,
      requiredOperations: ['run_local', 'invoke_action'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.operation_results).toHaveLength(2);
    expect(
      decision.operation_results.find((item) => item.operation === 'invoke_action')?.reason_code
    ).toBe('team_rule_denied');
  });

  it('same-specificity deny wins even when multiple more-specific candidates are otherwise allowed', () => {
    const resource = {
      ...base.resource,
      action: {
        action_id: 'generate',
        action_contract_version: '1',
        action_surface_sha256: digest,
      },
    };
    const decision = evaluatePluginGovernance({
      ...base,
      resource,
      policyRevision: 4,
      policy: actionPolicy([
        { rule_id: 'allow-a', effect: 'ALLOW' },
        { rule_id: 'allow-b', effect: 'ALLOW' },
        { rule_id: 'deny', effect: 'DENY' },
      ]),
      requiredOperations: ['invoke_action'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.operation_results[0].matched).toEqual([
      { layer: 'TEAM', effect: 'DENY', rule_id: 'deny' },
    ]);
  });

  it.each([
    [
      'package_surface_changed',
      {
        rules: [
          {
            rule_id: 'old-package',
            effect: 'ALLOW' as const,
            operations: ['invoke_action' as const],
            target: {
              kind: 'PACKAGE' as const,
              package_id: 'p1',
              approved_surface_sha256: 'c'.repeat(64),
            },
          },
        ],
      },
      { action: undefined, workflow: undefined },
    ],
    [
      'action_surface_changed',
      actionPolicy([{ rule_id: 'old-action', effect: 'ALLOW' }]),
      {
        action: {
          action_id: 'generate',
          action_contract_version: '1',
          action_surface_sha256: 'c'.repeat(64),
        },
        workflow: undefined,
      },
    ],
    [
      'workflow_plan_changed',
      {
        rules: [
          {
            rule_id: 'old-workflow',
            effect: 'ALLOW' as const,
            operations: ['run_workflow' as const],
            target: {
              kind: 'WORKFLOW' as const,
              workflow_release_id: 'wr1',
              workflow_plan_sha256: 'c'.repeat(64),
            },
          },
        ],
      },
      { action: undefined, workflow: { workflow_release_id: 'wr1', workflow_plan_sha256: digest } },
    ],
  ] as const)(
    '%s explains a stale high-risk surface instead of treating it as an unspecified deny',
    (reason, policy, binding) => {
      const decision = evaluatePluginGovernance({
        ...base,
        policyRevision: 2,
        policy: {
          schema_version: 1,
          enforcement_mode: 'ENFORCE',
          allowed_source_kinds: [],
          denied_capability_kinds: [],
          ...policy,
        },
        resource: { ...base.resource, ...binding },
        requiredOperations: [reason === 'workflow_plan_changed' ? 'run_workflow' : 'invoke_action'],
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason_code).toBe(reason);
    }
  );

  it('loads one policy revision for a compound request and retains every operation result', () => {
    const policy = packageAllow(['invoke_action', 'run_workflow']);
    const decision = evaluatePluginGovernance({
      ...base,
      policyRevision: 9,
      policy,
      requiredOperations: ['run_workflow', 'invoke_action', 'invoke_action'],
    });
    expect(decision.required_operations).toEqual(['invoke_action', 'run_workflow']);
    expect(decision.operation_results.map((result) => result.operation)).toEqual([
      'invoke_action',
      'run_workflow',
    ]);
    expect(decision.operation_results.every((result) => result.allowed)).toBe(true);
    expect(decision.policy_revision).toBe(9);
  });

  it.each([
    ['install', 'PACKAGE'],
    ['update', 'PACKAGE'],
    ['run_local', 'PACKAGE'],
    ['web_preview', 'PACKAGE'],
    ['shared_data_read', 'PACKAGE'],
    ['shared_data_write', 'PACKAGE'],
  ] as const)(
    'traces the %s product entry through the exact team rule',
    (operation, targetKind) => {
      const decision = evaluatePluginGovernance({
        ...base,
        policyRevision: 12,
        requiredOperations: [operation],
        policy: packageAllow([operation]),
      });
      expect(decision).toMatchObject({
        allowed: true,
        policy_revision: 12,
        reason_code: 'allowed',
      });
      expect(decision.operation_results).toEqual([
        {
          operation,
          allowed: true,
          reason_code: 'allowed',
          matched: [{ layer: 'TEAM', effect: 'ALLOW', rule_id: 'package-allow' }],
        },
      ]);
      expect(packageAllow([operation]).rules[0].target.kind).toBe(targetKind);
    }
  );

  it.each([
    'install',
    'update',
    'run_local',
    'web_preview',
    'shared_data_read',
    'shared_data_write',
  ] as const)('traces %s denial without a lower-layer bypass', (operation) => {
    const allow = packageAllow([operation]);
    const policy = {
      ...allow,
      rules: [{ ...allow.rules[0], rule_id: `deny-${operation}`, effect: 'DENY' as const }],
    };
    const decision = evaluatePluginGovernance({
      ...base,
      policyRevision: 13,
      requiredOperations: [operation],
      policy,
      userGrant: 'ALLOW',
      roleGrant: 'ALLOW',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('team_rule_denied');
    expect(decision.operation_results[0].matched).toEqual([
      { layer: 'TEAM', effect: 'DENY', rule_id: `deny-${operation}` },
    ]);
  });
});
