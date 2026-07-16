import { describe, expect, it, vi } from 'vitest';
import { GovernanceActionAdapter } from './governance-action-adapter';
const target = { package_id: 'p1', release_id: 'r1', sha256: 'a'.repeat(64), action_id: 'generate', action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64) };
describe('GovernanceActionAdapter', () => {
  it('resolves and authorizes a compound action exactly once', async () => {
    const resolve = vi.fn().mockResolvedValue({ target, action: { execution: { runtime_type: 'cloud' } } });
    const authorizeRelease = vi.fn().mockResolvedValue({ decision: { allowed: true }, source: 'team', release: { id: 'r1' } });
    const adapter = new GovernanceActionAdapter({ resolve } as never, { authorizeRelease } as never);
    const result = await adapter.authorize({ userId: 'u1', target, caller: 'WORKFLOW', invocationKind: 'PREVIEW', webPreview: true });
    expect(resolve).toHaveBeenCalledOnce(); expect(authorizeRelease).toHaveBeenCalledOnce();
    expect(authorizeRelease).toHaveBeenCalledWith('u1', { releaseId: 'r1', packageId: 'p1', sha256: target.sha256 }, ['execute_cloud', 'invoke_action', 'run_workflow', 'web_preview'], { action: { action_id: 'generate', action_contract_version: '1.0.0', action_surface_sha256: target.action_surface_sha256 } });
    expect(result.decision.allowed).toBe(true);
  });

  it('requires workflow permission from the target runtime for nested ACTION callers', async () => {
    const resolve = vi.fn().mockResolvedValue({ target, action: { execution: { runtime_type: 'workflow' } } });
    const authorizeRelease = vi.fn().mockResolvedValue({ decision: { allowed: true }, source: 'team', release: { id: 'r1' } });
    const adapter = new GovernanceActionAdapter({ resolve } as never, { authorizeRelease } as never);
    await adapter.authorize({ userId: 'u1', target, caller: 'ACTION', invocationKind: 'STANDARD' });
    expect(authorizeRelease).toHaveBeenCalledWith('u1', expect.anything(), ['invoke_action', 'run_workflow'], expect.anything());
  });
});
