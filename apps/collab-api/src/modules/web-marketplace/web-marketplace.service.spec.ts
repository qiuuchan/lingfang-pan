import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../common';
import { PLUGIN_AI_POLICY_VERSION } from '../plugin-ai-policy';
import { WebMarketplaceService } from './web-marketplace.service';

const IDS = {
  packageA: '11111111-1111-4111-8111-111111111111',
  listingA: '22222222-2222-4222-8222-222222222222',
  releaseA: '33333333-3333-4333-8333-333333333333',
  packageB: '44444444-4444-4444-8444-444444444444',
  listingB: '55555555-5555-4555-8555-555555555555',
  releaseB: '66666666-6666-4666-8666-666666666666',
};

function listing(overrides: Record<string, unknown> = {}) {
  const currentRelease = {
    id: IDS.releaseA,
    version: '1.2.3',
    manifest: {
      id: 'demo.image',
      name: '图片生成器',
      version: '1.2.3',
      description: '生成图片',
      runtime_type: 'client',
      entry: 'index.html',
      capabilities: [{ kind: 'image.generate' }],
    },
    actionSurfaceManifest: [],
    readmeMarkdown: '# 使用说明',
    sha256: 'a'.repeat(64),
    targetPlatform: 'windows-x64',
    status: 'PUBLISHED',
    marketReviewStatus: 'APPROVED',
    aiPolicyVersion: PLUGIN_AI_POLICY_VERSION,
    aiPolicyStatus: 'PASSED',
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
  };
  return {
    id: IDS.listingA,
    packageId: IDS.packageA,
    currentReleaseId: IDS.releaseA,
    priceCents: 990,
    priceRevision: 1,
    status: 'ACTIVE',
    installCount: 12,
    ratingCount: 2,
    ratingSum: 9,
    updatedAt: new Date('2026-07-16T00:00:00.000Z'),
    package: {
      id: IDS.packageA,
      name: '图片生成器',
      description: '生成图片和视频素材',
      governanceStatus: 'ACTIVE',
      updatedAt: new Date('2026-07-16T00:00:00.000Z'),
      author: { displayName: '公开作者' },
    },
    currentRelease,
    ...overrides,
  };
}

function setup(rows: ReturnType<typeof listing>[]) {
  const prisma = {
    marketplaceCommerceState: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ writerMode: 'LEGACY', settlementV2ActivatedAt: null }),
    },
    marketplaceDiscount: { findMany: vi.fn().mockResolvedValue([]) },
    marketplaceListing: {
      findMany: vi.fn().mockResolvedValue(rows),
      findUnique: vi
        .fn()
        .mockImplementation(
          ({ where }: { where: { packageId: string } }) =>
            rows.find((row) => row.packageId === where.packageId) ?? null
        ),
    },
  };
  return { prisma, service: new WebMarketplaceService(prisma as never) };
}

describe('WebMarketplaceService', () => {
  it('returns only current approved public releases and never leaks manifest/storage fields', async () => {
    const hidden = listing({
      id: IDS.listingB,
      packageId: IDS.packageB,
      currentReleaseId: IDS.releaseB,
      currentRelease: {
        ...listing().currentRelease,
        id: IDS.releaseB,
        marketReviewStatus: 'PENDING',
      },
    });
    const { service } = setup([listing(), hidden]);
    const page = await service.catalog({});
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      package_id: IDS.packageA,
      release_id: IDS.releaseA,
      category: 'MEDIA',
      quality_tier: 'LISTED',
      preview_mode: 'CLIENT_SANDBOX',
      average_rating_tenths: 45,
    });
    expect(page.items[0]).not.toHaveProperty('manifest');
    expect(page.items[0]).not.toHaveProperty('artifactKey');
    expect(page.items[0]).not.toHaveProperty('price_revision');
  });

  it('applies URL filters, bounded pagination and a package-id stable tie break', async () => {
    const second = listing({
      id: IDS.listingB,
      packageId: IDS.packageB,
      currentReleaseId: IDS.releaseB,
      priceCents: 0,
      installCount: 12,
      package: {
        ...listing().package,
        id: IDS.packageB,
        name: 'AI 助手',
        description: '对话总结',
      },
      currentRelease: {
        ...listing().currentRelease,
        id: IDS.releaseB,
        manifest: { ...listing().currentRelease.manifest, runtime_type: 'cloud' },
        actionSurfaceManifest: [
          {
            previewable: true,
            cloud_capable: true,
            execution_semantics: 'read_only',
          },
        ],
      },
    });
    const { service } = setup([second, listing()]);
    const freeWeb = await service.catalog({ price: 'FREE', compatibility: 'WEB' });
    expect(freeWeb.items).toHaveLength(1);
    expect(freeWeb.items[0]).toMatchObject({
      package_id: IDS.packageB,
      category: 'AI',
      preview_mode: 'CLOUD_TRIAL',
    });

    const paged = await service.catalog({ sort: 'POPULAR', page: 1, page_size: 1 });
    expect(paged.total).toBe(2);
    expect(paged.items[0].package_id).toBe(IDS.packageA);
  });

  it('returns a strict detail projection with opaque price version and compatibility', async () => {
    const { service } = setup([listing()]);
    const detail = await service.detail(IDS.packageA);
    expect(detail.readme_markdown).toBe('# 使用说明');
    expect(detail.release_sha256).toBe('a'.repeat(64));
    expect(detail.compatibility).toEqual({
      runtime_type: 'client',
      desktop_platforms: ['windows-x64'],
      minimum_desktop_version: null,
      web_compatible: true,
    });
    expect(detail.preview_actions).toEqual([]);
    expect(detail.price_version).toMatch(/^pv1\.[A-Za-z0-9_-]{43}$/);
    expect(detail).not.toHaveProperty('reviewReason');
    expect(detail).not.toHaveProperty('actionSurfaceManifest');
  });

  it('projects only safe previewable cloud actions needed by the Web trial form', async () => {
    const inputSchema = {
      type: 'object',
      properties: { prompt: { type: 'string', maxLength: 100 } },
      required: ['prompt'],
      additionalProperties: false,
    };
    const cloud = listing({
      currentRelease: {
        ...listing().currentRelease,
        manifest: { ...listing().currentRelease.manifest, runtime_type: 'cloud' },
        actionSurfaceManifest: [
          {
            action_id: 'image.generate',
            name: '生成图片',
            description: '生成预览图片',
            action_contract_version: '1.0.0',
            action_surface_sha256: 'b'.repeat(64),
            input_schema: inputSchema,
            previewable: true,
            cloud_capable: true,
            execution_semantics: 'read_only',
            output_schema: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
            execution: { runtime_type: 'cloud', adapter: 'cloud' },
            schema_version: 1,
            timeout_seconds: 30,
          },
          {
            action_id: 'publish',
            name: '发布',
            description: '',
            action_contract_version: '1.0.0',
            action_surface_sha256: 'c'.repeat(64),
            input_schema: inputSchema,
            previewable: false,
            cloud_capable: true,
            execution_semantics: 'side_effect',
          },
        ],
      },
    });
    const { service } = setup([cloud]);
    const detail = await service.detail(IDS.packageA);
    expect(detail.preview_actions).toEqual([
      expect.objectContaining({ action_id: 'image.generate', input_schema: inputSchema }),
    ]);
    expect(JSON.stringify(detail)).not.toContain('output_schema');
  });

  it('fails closed when the listing release is withdrawn after a page was opened', async () => {
    const { service } = setup([
      listing({ currentRelease: { ...listing().currentRelease, status: 'YANKED' } }),
    ]);
    await expect(service.detail(IDS.packageA)).rejects.toMatchObject<AppError>({
      status: 404,
      code: 'not_found',
    });
  });
});
