import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { ActionInvocationController } from './action-invocation.controller';

const request = { user: { id: 'user-1' } } as unknown as Request;

describe('ActionInvocationController desktop host boundary', () => {
  it('forces DESKTOP caller kind and ignores iframe-supplied caller metadata', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'invocation-1' });
    const assertDeclaredDependency = vi.fn().mockResolvedValue(undefined);
    const controller = new ActionInvocationController(
      { create } as never,
      { assertDeclaredDependency } as never
    );

    await controller.create(request, {
      desktop_caller: {
        package_id: 'caller-package',
        release_id: 'caller-release',
        sha256: 'a'.repeat(64),
        dependency_id: 'video_generator',
      },
      caller: { kind: 'CLOUD', id: 'spoofed-iframe' },
      preview: true,
      target: {
        package_id: 'target-package',
        release_id: 'target-release',
        sha256: 'b'.repeat(64),
        action_id: 'generate',
        action_contract_version: '1.0.0',
        action_surface_sha256: 'c'.repeat(64),
      },
      input: { prompt: 'demo' },
    });

    expect(assertDeclaredDependency).toHaveBeenCalledWith(
      {
        package_id: 'caller-package',
        release_id: 'caller-release',
        sha256: 'a'.repeat(64),
        dependency_id: 'video_generator',
      },
      'video_generator',
      {
        package_id: 'target-package',
        release_id: 'target-release',
        sha256: 'b'.repeat(64),
        action_id: 'generate',
        action_contract_version: '1.0.0',
        action_surface_sha256: 'c'.repeat(64),
      }
    );
    expect(create).toHaveBeenCalledWith('user-1', {
      target: {
        package_id: 'target-package',
        release_id: 'target-release',
        sha256: 'b'.repeat(64),
        action_id: 'generate',
        action_contract_version: '1.0.0',
        action_surface_sha256: 'c'.repeat(64),
      },
      input: { prompt: 'demo' },
      caller: { kind: 'DESKTOP', id: expect.stringMatching(/^desktop-plugin:[a-f0-9]{64}$/) },
    });
  });

  it('derives nested caller identity from the running parent invocation', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'nested-1' });
    const nestedCaller = vi.fn().mockResolvedValue({
      package_id: 'parent-package',
      release_id: 'parent-release',
      sha256: 'd'.repeat(64),
    });
    const assertDeclaredDependency = vi.fn().mockResolvedValue(undefined);
    const controller = new ActionInvocationController(
      { create, nestedCaller } as never,
      { assertDeclaredDependency } as never
    );

    await controller.create(request, {
      desktop_caller: {
        package_id: 'spoofed-package',
        release_id: 'spoofed-release',
        sha256: 'e'.repeat(64),
        dependency_id: 'video_generator',
      },
      parent_invocation_id: 'parent-invocation-1',
      caller: { kind: 'CLOUD', id: 'spoofed-iframe' },
      preview: false,
      target: {
        package_id: 'target-package',
        release_id: 'target-release',
        sha256: 'b'.repeat(64),
        action_id: 'generate',
        action_contract_version: '1.0.0',
        action_surface_sha256: 'c'.repeat(64),
      },
      input: { prompt: 'demo' },
    });

    expect(nestedCaller).toHaveBeenCalledWith('user-1', 'parent-invocation-1');
    expect(assertDeclaredDependency).toHaveBeenCalledWith(
      {
        package_id: 'parent-package',
        release_id: 'parent-release',
        sha256: 'd'.repeat(64),
      },
      'video_generator',
      expect.objectContaining({ package_id: 'target-package' })
    );
    expect(create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        caller: { kind: 'ACTION', id: 'parent-invocation-1' },
        parent_invocation_id: 'parent-invocation-1',
      })
    );
    expect(create.mock.calls[0][1]).not.toHaveProperty('preview');
  });

  it('exposes claim/complete/fail as real terminal transitions instead of fake client success', async () => {
    const service = {
      claimDesktop: vi.fn().mockResolvedValue({ status: 'RUNNING' }),
      completeDesktop: vi.fn().mockResolvedValue({ status: 'SUCCEEDED' }),
      failDesktop: vi.fn().mockResolvedValue({ status: 'FAILED' }),
    };
    const controller = new ActionInvocationController(service as never, {} as never);

    await controller.claim(request, 'invocation-1');
    await controller.complete(request, 'invocation-1', { output: { video_id: 'video-1' } });
    await controller.fail(request, 'invocation-2', {
      code: 'action_runtime_unavailable',
      message: 'client unsupported',
    });

    expect(service.claimDesktop).toHaveBeenCalledWith('user-1', 'invocation-1');
    expect(service.completeDesktop).toHaveBeenCalledWith('user-1', 'invocation-1', {
      video_id: 'video-1',
    });
    expect(service.failDesktop).toHaveBeenCalledWith(
      'user-1',
      'invocation-2',
      'action_runtime_unavailable',
      'client unsupported'
    );
  });
});
