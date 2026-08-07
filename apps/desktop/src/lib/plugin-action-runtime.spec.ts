import { describe, expect, it, vi } from 'vitest';
import type { LocalPluginInstallation } from '@lingfang/contract';
import { satisfiesActionVersionRange } from '@lingfang/contract';
import type { LoadedPlugin } from '@/lib/types';
import { invokeInstalledPluginAction } from './plugin-action-runtime';

const digest = (character: string) => character.repeat(64);

function installation(
  overrides: Partial<LocalPluginInstallation> & {
    installationId: string;
    packageId: string;
    releaseId: string;
    version: string;
    sha256: string;
  }
): LocalPluginInstallation {
  return {
    installationId: overrides.installationId,
    packageId: overrides.packageId,
    origin: 'team',
    protected: false,
    activeRelease: {
      releaseId: overrides.releaseId,
      version: overrides.version,
      sha256: overrides.sha256,
      path: `/plugins/${overrides.releaseId}`,
      dependencyStatus: 'ready',
    },
    pendingRelease: null,
    previousRelease: null,
    dataPath: `/data/${overrides.installationId}`,
    installedAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

function callerPlugin(): LoadedPlugin {
  return {
    id: 'caller-installation',
    installationId: '11111111-1111-4111-8111-111111111111',
    packageId: 'caller-package',
    releaseId: 'caller-release',
    releaseSha256: digest('a'),
    installationOrigin: 'team',
    name: 'Caller',
    version: '1.0.0',
    entry: 'ui/index.html',
    runtime_type: 'client',
    source: 'installed',
    manifest: {
      id: 'caller',
      name: 'Caller',
      version: '1.0.0',
      runtime_type: 'client',
      entry: 'ui/index.html',
      capabilities: [],
      actions: [],
      action_dependencies: [
        {
          dependency_id: 'video_generator',
          package_id: 'video-package',
          release_version_range: '^2.0.0',
          action_id: 'generate_video',
          action_contract_version_range: '^1.0.0',
        },
      ],
    },
  };
}

const inputSchema = {
  type: 'object',
  properties: { prompt: { type: 'string', maxLength: 100 } },
  required: ['prompt'],
  additionalProperties: false,
};

function actionSurface(runtimeType: 'nodejs' | 'client' | 'cloud' | 'workflow' = 'nodejs') {
  const execution =
    runtimeType === 'cloud'
      ? { runtime_type: 'cloud' as const, adapter: 'cloud' as const }
      : runtimeType === 'workflow'
        ? {
            runtime_type: 'workflow' as const,
            entry: 'workflow.json',
            definition_sha256: digest('e'),
          }
        : { runtime_type: runtimeType, entry: 'actions/video.mjs', export: 'run' };
  return {
    schema_version: 1,
    action_id: 'generate_video',
    action_contract_version: '1.2.0',
    input_schema: inputSchema,
    output_schema: {
      type: 'object',
      properties: { video_id: { type: 'string' } },
      required: ['video_id'],
      additionalProperties: false,
    },
    execution_semantics: 'idempotent',
    timeout_seconds: 30,
    cloud_capable: false,
    previewable: false,
    execution,
    action_surface_sha256: digest('c'),
  };
}

function invocation(
  status: 'AUTHORIZED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED',
  output: Record<string, unknown> | null = null,
  errorCode = '',
  errorMessage = ''
) {
  return {
    id: 'invocation-1',
    team_id: 'team-1',
    kind: 'STANDARD',
    status,
    target: {
      package_id: 'video-package',
      release_id: 'video-release',
      sha256: digest('b'),
      action_id: 'generate_video',
      action_contract_version: '1.2.0',
      action_surface_sha256: digest('c'),
    },
    root_invocation_id: 'invocation-1',
    parent_invocation_id: null,
    call_chain: [
      {
        invocation_id: 'invocation-1',
        target: {
          package_id: 'video-package',
          release_id: 'video-release',
          sha256: digest('b'),
          action_id: 'generate_video',
          action_contract_version: '1.2.0',
          action_surface_sha256: digest('c'),
        },
      },
    ],
    policy_revision: 1,
    required_operations: ['invoke_action', 'run_local'],
    input: { prompt: 'demo' },
    output,
    deadline_at: '2026-07-16T01:00:00.000Z',
    created_at: '2026-07-16T00:00:00.000Z',
    started_at: status === 'AUTHORIZED' ? null : '2026-07-16T00:00:01.000Z',
    completed_at: status === 'SUCCEEDED' || status === 'FAILED' ? '2026-07-16T00:00:02.000Z' : null,
    error_code: errorCode,
    error_message: errorMessage,
  };
}

function installations() {
  return [
    installation({
      installationId: '11111111-1111-4111-8111-111111111111',
      packageId: 'caller-package',
      releaseId: 'caller-release',
      version: '1.0.0',
      sha256: digest('a'),
    }),
    installation({
      installationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'video-package',
      releaseId: 'video-release',
      version: '2.3.0',
      sha256: digest('b'),
    }),
  ];
}

describe('desktop plugin action host', () => {
  it('binds the caller to the active plugin, derives keys, executes exact local target and returns terminal output', async () => {
    const apiMock = vi.fn(async (path: string, options?: { method?: string; body?: any }) => {
      if (path === '/api/plugin-releases/video-release/actions')
        return {
          release_id: 'video-release',
          package_id: 'video-package',
          sha256: digest('b'),
          actions: [actionSurface()],
        };
      if (path === '/api/plugin-actions/invocations' && options?.method === 'POST')
        return invocation('AUTHORIZED');
      if (path.endsWith('/claim')) return invocation('RUNNING');
      if (path.endsWith('/complete')) return invocation('SUCCEEDED', { video_id: 'video-1' });
      if (path === '/api/plugin-actions/invocations/invocation-1')
        return invocation('SUCCEEDED', { video_id: 'video-1' });
      throw new Error(`unexpected API call: ${path}`);
    });
    const tauriMock = vi.fn().mockResolvedValue({ video_id: 'video-1' });
    const uuid = vi
      .fn()
      .mockReturnValueOnce('request-key-host')
      .mockReturnValueOnce('root-logical-call-host');
    const hash = vi.fn().mockResolvedValue(digest('d'));

    await expect(
      invokeInstalledPluginAction(
        callerPlugin(),
        {
          dependency_id: 'video_generator',
          input: { prompt: 'demo' },
          idempotency_key: 'scene-7',
          pluginId: 'spoofed-plugin',
        } as never,
        {
          api: apiMock as never,
          tauriInvoke: tauriMock as never,
          listInstallations: vi.fn().mockResolvedValue(installations()),
          uuid,
          sha256: hash,
          now: () => Date.parse('2026-07-16T00:00:00.000Z'),
          sleep: vi.fn().mockResolvedValue(undefined),
        }
      )
    ).resolves.toEqual({ video_id: 'video-1' });

    const create = apiMock.mock.calls.find(([path]) => path === '/api/plugin-actions/invocations');
    expect(create?.[1]?.body).toMatchObject({
      request_idempotency_key: 'request-key-host',
      effect_idempotency_key: digest('d'),
      desktop_caller: {
        package_id: 'caller-package',
        release_id: 'caller-release',
        sha256: digest('a'),
        dependency_id: 'video_generator',
      },
      target: {
        package_id: 'video-package',
        release_id: 'video-release',
        sha256: digest('b'),
        action_id: 'generate_video',
        action_contract_version: '1.2.0',
        action_surface_sha256: digest('c'),
      },
    });
    expect(create?.[1]?.body).not.toHaveProperty('caller');
    expect(create?.[1]?.body.request_idempotency_key).not.toBe('scene-7');
    expect(create?.[1]?.body.effect_idempotency_key).not.toBe('scene-7');
    expect(tauriMock).toHaveBeenCalledWith(
      'workflow_executor_execute_action',
      expect.objectContaining({
        target: expect.objectContaining({
          release_id: 'video-release',
          action_id: 'generate_video',
        }),
        input: { prompt: 'demo' },
        invocationId: 'invocation-1',
      })
    );
  });

  it('rejects undeclared aliases before discovery or execution', async () => {
    const apiMock = vi.fn();
    const tauriMock = vi.fn();
    await expect(
      invokeInstalledPluginAction(
        callerPlugin(),
        {
          dependency_id: 'undeclared',
          input: { prompt: 'demo' },
        },
        {
          api: apiMock as never,
          tauriInvoke: tauriMock as never,
          listInstallations: vi.fn().mockResolvedValue(installations()),
        }
      )
    ).rejects.toMatchObject({ code: 'action_dependency_denied' });
    expect(apiMock).not.toHaveBeenCalled();
    expect(tauriMock).not.toHaveBeenCalled();
  });

  it('executes client actions through the opaque-frame adapter', async () => {
    const apiMock = vi.fn(async (path: string, options?: { method?: string; body?: any }) => {
      if (path === '/api/plugin-releases/video-release/actions')
        return {
          release_id: 'video-release',
          package_id: 'video-package',
          sha256: digest('b'),
          actions: [actionSurface('client')],
        };
      if (path === '/api/plugin-actions/invocations' && options?.method === 'POST')
        return invocation('AUTHORIZED');
      if (path.endsWith('/claim')) return invocation('RUNNING');
      if (path.endsWith('/complete'))
        return invocation('SUCCEEDED', { video_id: 'video-client-1' });
      if (path.endsWith('/artifacts') && options?.method === 'POST')
        return { type: 'artifact_ref', artifact_id: 'artifact-1' };
      if (path === '/api/plugin-actions/invocations/invocation-1')
        return invocation('SUCCEEDED', { video_id: 'video-client-1' });
      throw new Error(`unexpected API call: ${path}`);
    });
    const tauriMock = vi.fn().mockResolvedValue({
      source: 'export async function run(input) { return { video_id: input.prompt }; }',
      export_name: 'run',
      manifest: {
        ...(callerPlugin().manifest as object),
        id: 'video',
        name: 'Video',
        version: '2.3.0',
      },
    });
    const executeClientAction = vi.fn().mockResolvedValue({ video_id: 'video-client-1' });

    await expect(
      invokeInstalledPluginAction(
        callerPlugin(),
        {
          dependency_id: 'video_generator',
          input: { prompt: 'demo' },
          idempotency_key: 'scene-7',
        },
        {
          api: apiMock as never,
          tauriInvoke: tauriMock as never,
          listInstallations: vi.fn().mockResolvedValue(installations()),
          uuid: vi.fn().mockReturnValue('host-key'),
          sha256: vi.fn().mockResolvedValue(digest('d')),
          executeClientAction,
          now: () => Date.parse('2026-07-16T00:00:00.000Z'),
          sleep: vi.fn().mockResolvedValue(undefined),
        }
      )
    ).resolves.toEqual({ video_id: 'video-client-1' });

    expect(tauriMock).toHaveBeenCalledWith('workflow_executor_read_client_action_handler', {
      target: expect.objectContaining({ release_id: 'video-release', action_id: 'generate_video' }),
    });
    expect(executeClientAction).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'invocation-1',
        exportName: 'run',
        input: { prompt: 'demo' },
        onCapability: expect.any(Function),
      })
    );
    const clientRequest = executeClientAction.mock.calls[0][0];
    await expect(
      clientRequest.onCapability('artifacts.create', {
        data_base64: 'UE5H',
        media_type: 'image/png',
      })
    ).resolves.toMatchObject({ artifact_id: 'artifact-1' });
    expect(apiMock).toHaveBeenCalledWith('/api/plugin-actions/invocations/invocation-1/artifacts', {
      method: 'POST',
      body: { data_base64: 'UE5H', media_type: 'image/png' },
    });
  });

  it('adds only the host-owned parent invocation id for nested calls', async () => {
    const apiMock = vi.fn(async (path: string, options?: { method?: string; body?: any }) => {
      if (path === '/api/plugin-releases/video-release/actions')
        return {
          release_id: 'video-release',
          package_id: 'video-package',
          sha256: digest('b'),
          actions: [actionSurface()],
        };
      if (path === '/api/plugin-actions/invocations' && options?.method === 'POST')
        return invocation('SUCCEEDED', { video_id: 'existing' });
      throw new Error(`unexpected API call: ${path}`);
    });
    await invokeInstalledPluginAction(
      callerPlugin(),
      {
        dependency_id: 'video_generator',
        input: { prompt: 'demo' },
      },
      {
        api: apiMock as never,
        listInstallations: vi.fn().mockResolvedValue(installations()),
        uuid: vi.fn().mockReturnValue('host-key'),
        now: () => Date.parse('2026-07-16T00:00:00.000Z'),
      },
      { parentInvocationId: 'parent-invocation-1' }
    );
    const create = apiMock.mock.calls.find(([path]) => path === '/api/plugin-actions/invocations');
    expect(create?.[1]?.body).toMatchObject({ parent_invocation_id: 'parent-invocation-1' });
    expect(create?.[1]?.body).not.toHaveProperty('caller');
  });

  for (const runtimeType of ['cloud', 'workflow'] as const) {
    it(`fails ${runtimeType} deterministically when no desktop adapter is registered`, async () => {
      let terminalCode = '';
      let terminalMessage = '';
      const apiMock = vi.fn(async (path: string, options?: { method?: string; body?: any }) => {
        if (path === '/api/plugin-releases/video-release/actions')
          return {
            release_id: 'video-release',
            package_id: 'video-package',
            sha256: digest('b'),
            actions: [actionSurface(runtimeType)],
          };
        if (path === '/api/plugin-actions/invocations' && options?.method === 'POST')
          return invocation('AUTHORIZED');
        if (path.endsWith('/claim')) return invocation('RUNNING');
        if (path.endsWith('/fail')) {
          terminalCode = String(options?.body?.code || '');
          terminalMessage = String(options?.body?.message || '');
          return { ok: true };
        }
        if (path === '/api/plugin-actions/invocations/invocation-1')
          return invocation('FAILED', null, terminalCode, terminalMessage);
        throw new Error(`unexpected API call: ${path}`);
      });
      const tauriMock = vi.fn();

      await expect(
        invokeInstalledPluginAction(
          callerPlugin(),
          {
            dependency_id: 'video_generator',
            input: { prompt: 'demo' },
            idempotency_key: 'scene-7',
          },
          {
            api: apiMock as never,
            tauriInvoke: tauriMock as never,
            listInstallations: vi.fn().mockResolvedValue(installations()),
            uuid: vi.fn().mockReturnValue('host-key'),
            sha256: vi.fn().mockResolvedValue(digest('d')),
            now: () => Date.parse('2026-07-16T00:00:00.000Z'),
            sleep: vi.fn().mockResolvedValue(undefined),
          }
        )
      ).rejects.toMatchObject({ code: 'action_runtime_unavailable' });

      expect(terminalCode).toBe('action_runtime_unavailable');
      expect(tauriMock).not.toHaveBeenCalled();
    });
  }
});

describe('bounded action version ranges', () => {
  it('supports exact, comparator, caret and tilde ranges without admitting stable-range prereleases', () => {
    expect(satisfiesActionVersionRange('2.3.0', '^2.0.0')).toBe(true);
    expect(satisfiesActionVersionRange('3.0.0', '^2.0.0')).toBe(false);
    expect(satisfiesActionVersionRange('0.2.7', '^0.2.3')).toBe(true);
    expect(satisfiesActionVersionRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesActionVersionRange('1.4.9', '~1.4.0')).toBe(true);
    expect(satisfiesActionVersionRange('1.5.0', '~1.4.0')).toBe(false);
    expect(satisfiesActionVersionRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesActionVersionRange('1.5.0-beta.1', '>=1.0.0 <2.0.0')).toBe(false);
  });
});
