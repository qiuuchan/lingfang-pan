import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutomationScheduleFirePayload,
  AutomationScheduleTrigger,
  CloudActionDeployment,
  CloudUsageEvent,
  CreateAutomationScheduleRequest,
} from './plugin-cloud-automation.ts';

const digest = (character) => character.repeat(64);
const target = {
  package_id: 'package-a', release_id: 'release-a', sha256: digest('a'), action_id: 'render',
  action_contract_version: '1.0.0', action_surface_sha256: digest('b'),
};

test('schedule triggers accept only structured once/daily/weekly shapes', () => {
  assert.equal(AutomationScheduleTrigger.parse({ kind: 'DAILY', time_zone: 'Asia/Shanghai', local_time: '09:30' }).kind, 'DAILY');
  assert.equal(AutomationScheduleTrigger.parse({ kind: 'WEEKLY', time_zone: 'America/New_York', day_of_week: 7, local_time: '22:10' }).kind, 'WEEKLY');
  assert.throws(() => AutomationScheduleTrigger.parse({ kind: 'DAILY', cron: '0 9 * * *', time_zone: 'UTC', local_time: '09:00' }));
  assert.throws(() => CreateAutomationScheduleRequest.parse({ workflow_release_id: 'wf', workflow_release_sha256: digest('c'), trigger: { kind: 'ONCE', run_at: '2099-01-01T00:00:00.000Z' }, input: {}, webhook_url: 'https://example.com' }));
});

test('repeat fire payload cannot smuggle an occurrence or schedule input', () => {
  assert.deepEqual(AutomationScheduleFirePayload.parse({ kind: 'REPEAT', schedule_id: 's1', generation: 2, scheduler_key: 'schedule-s1-g2' }), { kind: 'REPEAT', schedule_id: 's1', generation: 2, scheduler_key: 'schedule-s1-g2' });
  assert.throws(() => AutomationScheduleFirePayload.parse({ kind: 'REPEAT', schedule_id: 's1', generation: 2, scheduler_key: 'schedule-s1-g2', scheduled_for: '2099-01-01T00:00:00.000Z' }));
});

test('deployment projection excludes endpoint URL and secret material', () => {
  const deployment = { id: 'd1', target: { ...target, environment: 'PRODUCTION' }, deployment_key: 'primary', supersedes_deployment_id: null, endpoint_host: 'api.example.com', status: 'DRAFT', secret_version: 1, timeout_ms: 30_000, max_concurrency: 4, rate_limit_per_minute: 60, response_limit_bytes: 1_048_576, last_health_at: null, last_health_ok: null, last_health_error_code: '', created_at: '2026-07-16T00:00:00.000Z', updated_at: '2026-07-16T00:00:00.000Z' };
  assert.equal(CloudActionDeployment.parse(deployment).status, 'DRAFT');
  assert.throws(() => CloudActionDeployment.parse({ ...deployment, secret: 'plaintext' }));
  assert.throws(() => CloudActionDeployment.parse({ ...deployment, endpoint_url: 'https://api.example.com/action' }));
});

test('usage source is explicit and exact target includes action surface digest', () => {
  const usage = { id: 'u1', team_id: 't1', source_kind: 'ACTION_INVOCATION', source_id: 'i1', event_kind: 'EXECUTION', target, deployment_id: 'd1', execution_scope: 'PREVIEW', duration_ms: 20, request_bytes: 100, response_bytes: 200, artifact_input_bytes: 0, artifact_output_bytes: 10, outcome: 'SUCCEEDED', pricing_dimensions: { calls: 1 }, occurred_at: '2026-07-16T00:00:00.000Z' };
  assert.equal(CloudUsageEvent.parse(usage).target.action_surface_sha256, digest('b'));
  assert.throws(() => CloudUsageEvent.parse({ ...usage, target: { ...target, action_surface_sha256: undefined } }));
});
