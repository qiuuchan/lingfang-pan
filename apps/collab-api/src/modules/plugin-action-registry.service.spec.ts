import { describe, expect, it, vi } from 'vitest';
import { PluginActionRegistryService } from './plugin-action-registry.service';

const caller = { package_id: 'caller-package', release_id: 'caller-release', sha256: 'a'.repeat(64) };
const target = { package_id: 'video-package', release_id: 'video-release', sha256: 'b'.repeat(64), action_id: 'generate_video', action_contract_version: '1.2.0' };

describe('PluginActionRegistryService declared dependency gate', () => {
  it('accepts only the exact package/action and bounded release/contract ranges frozen in caller manifest', async () => {
    const findUnique = vi.fn()
      .mockResolvedValueOnce({
        packageId: caller.package_id,
        sha256: caller.sha256,
        status: 'PUBLISHED',
        manifest: { action_dependencies: [{ dependency_id: 'video_generator', package_id: target.package_id, release_version_range: '^2.0.0', action_id: target.action_id, action_contract_version_range: '^1.0.0' }] },
      })
      .mockResolvedValueOnce({ packageId: target.package_id, version: '2.3.0', sha256: target.sha256, status: 'PUBLISHED' });
    const service = new PluginActionRegistryService({ pluginRelease: { findUnique } } as never);

    await expect(service.assertDeclaredDependency(caller, 'video_generator', target)).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('denies undeclared aliases before target execution', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      packageId: caller.package_id,
      sha256: caller.sha256,
      status: 'PUBLISHED',
      manifest: { action_dependencies: [] },
    });
    const service = new PluginActionRegistryService({ pluginRelease: { findUnique } } as never);

    await expect(service.assertDeclaredDependency(caller, 'video_generator', target)).rejects.toMatchObject({ code: 'action_dependency_denied' });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
