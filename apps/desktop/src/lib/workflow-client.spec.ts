import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock, tauriInvokeMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  tauriInvokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => true) }));
vi.mock('@/lib/api', () => ({
  api: apiMock,
  apiBase: vi.fn(() => 'https://api.example.test'),
  getAuthToken: vi.fn(() => 'token'),
  tauriInvoke: tauriInvokeMock,
}));

import { startWorkflowRun } from './workflow-client';

const digest = 'a'.repeat(64);
const target = {
  package_id: 'package.image',
  release_id: 'release.image',
  sha256: digest,
  action_id: 'image.generate',
  action_contract_version: '1.0.0',
  action_surface_sha256: 'b'.repeat(64),
};

function request(executionTarget: 'DESKTOP' | 'CLOUD') {
  return {
    workflow_release_id: 'workflow-release',
    sha256: digest,
    execution_target: executionTarget,
    execution_scope: 'PRODUCTION' as const,
    input: {},
    idempotency_key: `request-${executionTarget.toLowerCase()}`,
    deadline_at: '2099-01-01T00:00:00.000Z',
  };
}

function response(executionTarget: 'DESKTOP' | 'CLOUD') {
  return {
    run: {
      id: `run-${executionTarget.toLowerCase()}`,
      workflow_release_id: 'workflow-release',
      root_run_id: null,
      parent_step_attempt_id: null,
      execution_target: executionTarget,
      execution_scope: 'PRODUCTION',
      trigger_kind: 'MANUAL',
      status: 'RUNNING',
      plan_sha256: 'c'.repeat(64),
      attempt_counts: { pending: 0, ready: 1, running: 0, succeeded: 0, failed: 0, skipped: 0, canceled: 0 },
      deadline_at: '2099-01-01T00:00:00.000Z',
      result_retain_until: '2099-01-08T00:00:00.000Z',
      created_at: '2026-07-16T00:00:00.000Z',
      started_at: '2026-07-16T00:00:00.000Z',
      completed_at: null,
      error: null,
      input: {},
      output: null,
      plan: {
        plan_version: '1',
        workflow_release_id: 'workflow-release',
        workflow_release_sha256: digest,
        definition_sha256: 'd'.repeat(64),
        execution_target: executionTarget,
        execution_scope: 'PRODUCTION',
        max_parallelism: 1,
        nodes: [{ node_id: 'image', declared_version_range: '^1.0.0', target, depends_on: [], input_bindings: [], retry_limit: 0, execution_semantics: 'read_only', cloud_capable: true }],
        output_bindings: [],
        desktop_executor: executionTarget === 'DESKTOP' ? { session_id: 'session-1', inventory_sha256: 'e'.repeat(64) } : null,
      },
      attempts: [],
    },
  };
}

describe('workflow start transport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates CLOUD runs through the shared workflow HTTP ledger', async () => {
    apiMock.mockResolvedValue(response('CLOUD'));
    await expect(startWorkflowRun(request('CLOUD'))).resolves.toMatchObject({ id: 'run-cloud', execution_target: 'CLOUD' });
    expect(apiMock).toHaveBeenCalledWith('/api/workflows/runs', { method: 'POST', body: expect.objectContaining({ execution_target: 'CLOUD' }) });
    expect(tauriInvokeMock).not.toHaveBeenCalled();
  });

  it('keeps DESKTOP run creation inside the native session bridge', async () => {
    tauriInvokeMock.mockResolvedValue(response('DESKTOP'));
    await expect(startWorkflowRun(request('DESKTOP'))).resolves.toMatchObject({ id: 'run-desktop', execution_target: 'DESKTOP' });
    expect(tauriInvokeMock).toHaveBeenCalledWith('workflow_executor_start_run', { request: expect.objectContaining({ execution_target: 'DESKTOP' }) });
    expect(apiMock).not.toHaveBeenCalled();
  });
});
