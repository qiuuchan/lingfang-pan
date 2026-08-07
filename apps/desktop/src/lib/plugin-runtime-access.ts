import { api } from '@/lib/api';

export type RuntimeAccessRelease = {
  releaseId: string;
  sha256: string;
};

export type InstalledPluginOrigin = 'builtin' | 'local' | 'team' | 'marketplace';

export function requiresRegistryRuntimeAccess(origin: InstalledPluginOrigin): boolean {
  return origin === 'team' || origin === 'marketplace';
}

export async function checkRuntimeAccess(
  packageId: string,
  release: RuntimeAccessRelease
): Promise<void> {
  await api(`/api/plugin-packages/${packageId}/runtime-access`, {
    method: 'POST',
    body: { releaseId: release.releaseId, sha256: release.sha256 },
  });
}
