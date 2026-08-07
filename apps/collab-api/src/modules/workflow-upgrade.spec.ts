import { describe, expect, it, vi } from 'vitest';
import { PluginRegistryService } from './plugin-registry.service';

const digest = (value: string) => value.repeat(64);
const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const action = (surface: string, contract = '1.0.0') => ({
  action_id: 'render',
  action_contract_version: contract,
  action_surface_sha256: digest(surface),
  input_schema: schema,
  output_schema: schema,
  execution_semantics: 'read_only',
});

describe('workflow upgrade suggestions', () => {
  it('returns only the highest visible compatible release inside the frozen declared range', async () => {
    const prisma = {
      workflowRelease: {
        findUnique: vi.fn().mockResolvedValue({
          pluginReleaseId: 'workflow-1',
          pluginRelease: { sha256: digest('w') },
          nodes: [
            {
              nodeId: 'image',
              declaredVersionRange: '^1.0.0',
              packageId: 'package-image',
              releaseId: 'image-1',
              sha256: digest('a'),
              actionId: 'render',
              actionContractVersion: '1.0.0',
              actionSurfaceSha256: digest('b'),
            },
          ],
        }),
      },
      pluginRelease: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'image-1',
          version: '1.0.0',
          actionSurfaceManifest: [action('b')],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'image-2',
            version: '1.4.0',
            sha256: digest('c'),
            marketReviewStatus: 'APPROVED',
            aiPolicyVersion: 1,
            aiPolicyStatus: 'PASSED',
            actionSurfaceManifest: [action('d')],
          },
          {
            id: 'image-3',
            version: '1.8.0',
            sha256: digest('e'),
            marketReviewStatus: 'APPROVED',
            aiPolicyVersion: 1,
            aiPolicyStatus: 'PASSED',
            actionSurfaceManifest: [action('f')],
          },
          {
            id: 'image-4',
            version: '1.9.0',
            sha256: digest('g'),
            marketReviewStatus: 'APPROVED',
            aiPolicyVersion: 1,
            aiPolicyStatus: 'PASSED',
            actionSurfaceManifest: [action('h', '2.0.0')],
          },
          {
            id: 'image-5',
            version: '2.0.0',
            sha256: digest('i'),
            marketReviewStatus: 'APPROVED',
            aiPolicyVersion: 1,
            aiPolicyStatus: 'PASSED',
            actionSurfaceManifest: [action('j')],
          },
        ]),
      },
      pluginPackage: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ ownerTeamId: 'seller-team', listing: { status: 'ACTIVE' } }),
      },
      pluginEntitlement: { count: vi.fn().mockResolvedValue(1) },
    };
    const service = new PluginRegistryService(
      prisma as never,
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 'buyer-team' }) } as never,
      {} as never,
      {} as never
    );
    vi.spyOn(service, 'releaseDetail').mockResolvedValue({ release: {} as never });

    const response = await service.workflowUpgradeSuggestions('user-1', 'workflow-1');

    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0]).toEqual(
      expect.objectContaining({
        node_id: 'image',
        current_version: '1.0.0',
        suggested_version: '1.8.0',
        declared_version_range: '^1.0.0',
      })
    );
    expect(response.suggestions[0].suggested_target).toEqual(
      expect.objectContaining({ release_id: 'image-3', action_contract_version: '1.0.0' })
    );
    expect(prisma.pluginRelease).not.toHaveProperty('update');
  });
});
