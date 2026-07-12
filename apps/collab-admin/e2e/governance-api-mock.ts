import type { Page, Request, Route } from '@playwright/test';
import type {
  AdminPage,
  AdminPluginListingProjection,
  AdminPluginOwnerTeamSummary,
  AdminPluginPackageDetail,
  AdminPluginPackageListItem,
  AdminPluginPackageOverview,
  AdminPluginReleaseCore,
  AdminPluginReleaseCoreDetail,
  AdminPluginReleaseFile,
  AdminPluginReleaseListItem,
  AdminPluginReleaseManifest,
  AdminPluginReleaseReview,
  AdminPluginReleaseSummary,
} from '@lingfang/contract';

const NOW = '2026-07-12T08:00:00.000Z';
const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const TEAM_ID = '00000000-0000-4000-8000-000000000002';

export const FIXTURE_IDS = {
  currentPackage: '10000000-0000-4000-8000-000000000001',
  platformDelistedPackage: '10000000-0000-4000-8000-000000000002',
  ownerDelistedPackage: '10000000-0000-4000-8000-000000000003',
  currentRelease: '20000000-0000-4000-8000-000000000001',
  historicalRelease: '20000000-0000-4000-8000-000000000002',
  platformDelistedRelease: '20000000-0000-4000-8000-000000000003',
  ownerDelistedRelease: '20000000-0000-4000-8000-000000000004',
} as const;

export const FIXTURE_NAMES = {
  currentPackage: '外部工具工作流',
  platformDelistedPackage: '平台下架插件',
  ownerDelistedPackage: '作者下架插件',
} as const;

export type RecordedApiRequest = {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
};

type ReleaseFixture = {
  core: AdminPluginReleaseCore;
  manifest: AdminPluginReleaseManifest;
  files: AdminPluginReleaseFile[];
  reviews: AdminPluginReleaseReview[];
};

type PackageFixture = {
  package: AdminPluginPackageOverview;
  ownerTeam: AdminPluginOwnerTeamSummary;
  listing: AdminPluginListingProjection | null;
  releases: ReleaseFixture[];
};

type MockOptions = {
  delistConflictOnce?: boolean;
};

function activeListing(currentReleaseId: string): AdminPluginListingProjection {
  return {
    status: 'ACTIVE',
    currentReleaseId,
    priceCents: 0,
    delistedBy: null,
    delistReason: '',
    delistedAt: null,
    delistedByUserId: null,
  };
}

function delistedListing(
  currentReleaseId: string,
  delistedBy: 'OWNER' | 'PLATFORM',
): AdminPluginListingProjection {
  return {
    status: 'DELISTED',
    currentReleaseId,
    priceCents: 0,
    delistedBy,
    delistReason: delistedBy === 'PLATFORM' ? '平台安全复核' : '作者主动维护',
    delistedAt: NOW,
    delistedByUserId: delistedBy === 'PLATFORM' ? ADMIN_ID : null,
  };
}

function makeRelease({
  id,
  packageId,
  manifestId,
  name,
  version,
  sourceLabel,
}: {
  id: string;
  packageId: string;
  manifestId: string;
  name: string;
  version: string;
  sourceLabel: string;
}): ReleaseFixture {
  return {
    core: {
      id,
      packageId,
      version,
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
      targetPlatform: 'windows-x64',
      status: 'PUBLISHED',
      marketReviewStatus: 'APPROVED',
      reviewReason: '来源与制品校验通过',
      reviewedById: ADMIN_ID,
      reviewedAt: NOW,
      sourceKind: 'EXTERNAL_TOOL',
      sourceLabel,
      ingestChannel: 'DESKTOP',
      createdAt: NOW,
    },
    manifest: {
      releaseId: id,
      manifest: {
        id: manifestId,
        name,
        version,
        description: 'Playwright governance fixture',
        runtime_type: 'client',
        entry: 'dist/index.html',
        visibility: 'tenant',
        capabilities: [],
      },
    },
    files: [
      { path: 'dist/index.html', sizeBytes: 1024 },
      { path: 'dist/index.js', sizeBytes: 3072 },
    ],
    reviews: [
      {
        id: `30000000-0000-4000-8000-${id.slice(-12)}`,
        status: 'APPROVED',
        reason: '来源校验完成',
        reviewer: null,
        createdAt: NOW,
      },
    ],
  };
}

function makePackage({
  id,
  manifestId,
  name,
  listing,
  releases,
}: {
  id: string;
  manifestId: string;
  name: string;
  listing: AdminPluginListingProjection;
  releases: ReleaseFixture[];
}): PackageFixture {
  return {
    package: {
      id,
      ownerTeamId: TEAM_ID,
      authorUserId: ADMIN_ID,
      manifestId,
      name,
      description: `${name} fixture`,
      governanceStatus: 'ACTIVE',
      createdAt: NOW,
      updatedAt: NOW,
    },
    ownerTeam: {
      id: TEAM_ID,
      name: 'Fixture Team',
      slug: 'fixture-team',
    },
    listing,
    releases,
  };
}

function createPackages(): PackageFixture[] {
  const currentRelease = makeRelease({
    id: FIXTURE_IDS.currentRelease,
    packageId: FIXTURE_IDS.currentPackage,
    manifestId: 'fixture.external-workflow',
    name: FIXTURE_NAMES.currentPackage,
    version: '1.0.0',
    sourceLabel: 'Cursor 导入',
  });
  const historicalRelease = makeRelease({
    id: FIXTURE_IDS.historicalRelease,
    packageId: FIXTURE_IDS.currentPackage,
    manifestId: 'fixture.external-workflow',
    name: FIXTURE_NAMES.currentPackage,
    version: '0.9.0',
    sourceLabel: '外部 IDE 初版',
  });
  const platformRelease = makeRelease({
    id: FIXTURE_IDS.platformDelistedRelease,
    packageId: FIXTURE_IDS.platformDelistedPackage,
    manifestId: 'fixture.platform-delisted',
    name: FIXTURE_NAMES.platformDelistedPackage,
    version: '2.1.0',
    sourceLabel: 'VS Code 导入',
  });
  const ownerRelease = makeRelease({
    id: FIXTURE_IDS.ownerDelistedRelease,
    packageId: FIXTURE_IDS.ownerDelistedPackage,
    manifestId: 'fixture.owner-delisted',
    name: FIXTURE_NAMES.ownerDelistedPackage,
    version: '3.0.0',
    sourceLabel: 'JetBrains 导入',
  });

  return [
    makePackage({
      id: FIXTURE_IDS.currentPackage,
      manifestId: 'fixture.external-workflow',
      name: FIXTURE_NAMES.currentPackage,
      listing: activeListing(FIXTURE_IDS.currentRelease),
      releases: [currentRelease, historicalRelease],
    }),
    makePackage({
      id: FIXTURE_IDS.platformDelistedPackage,
      manifestId: 'fixture.platform-delisted',
      name: FIXTURE_NAMES.platformDelistedPackage,
      listing: delistedListing(FIXTURE_IDS.platformDelistedRelease, 'PLATFORM'),
      releases: [platformRelease],
    }),
    makePackage({
      id: FIXTURE_IDS.ownerDelistedPackage,
      manifestId: 'fixture.owner-delisted',
      name: FIXTURE_NAMES.ownerDelistedPackage,
      listing: delistedListing(FIXTURE_IDS.ownerDelistedRelease, 'OWNER'),
      releases: [ownerRelease],
    }),
  ];
}

function pageOf<T>(items: T[], page: number, pageSize: number): AdminPage<T> {
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

function readBody(request: Request): unknown {
  if (!request.postData()) return undefined;
  try {
    return request.postDataJSON();
  } catch {
    return request.postData();
  }
}

export class GovernanceApiMock {
  readonly requests: RecordedApiRequest[] = [];
  private readonly packages = createPackages();
  private delistConflictsRemaining: number;

  constructor(options: MockOptions = {}) {
    this.delistConflictsRemaining = options.delistConflictOnce ? 1 : 0;
  }

  async install(page: Page) {
    await page.route('**/api/**', (route) => this.handle(route));
  }

  count(method: string, pathname: string) {
    return this.requests.filter((request) => request.method === method && request.pathname === pathname).length;
  }

  last(method: string, pathname: string) {
    for (let index = this.requests.length - 1; index >= 0; index -= 1) {
      const request = this.requests[index];
      if (request.method === method && request.pathname === pathname) return request;
    }
    return undefined;
  }

  pluginRequests() {
    return this.requests.filter((request) => (
      request.pathname.startsWith('/api/admin/plugin-packages')
      || request.pathname.startsWith('/api/admin/plugin-releases')
    ));
  }

  private record(request: Request) {
    const url = new URL(request.url());
    const recorded: RecordedApiRequest = {
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
      body: readBody(request),
    };
    this.requests.push(recorded);
    return { recorded, url };
  }

  private async handle(route: Route) {
    const request = route.request();
    const { recorded, url } = this.record(request);
    const { method, pathname } = recorded;

    if (method === 'GET' && pathname === '/api/platform-info') {
      return this.json(route, { platformName: 'Fixture Admin', logoUrl: '' });
    }
    if (method === 'GET' && pathname === '/api/setup/status') {
      return this.json(route, { needsSetup: false });
    }
    if (method === 'GET' && pathname === '/api/auth/me') {
      return this.json(route, {
        user: {
          id: ADMIN_ID,
          email: 'admin@fixture.test',
          displayName: 'Fixture Admin',
          platformRole: 'PLATFORM_ADMIN',
          status: 'ACTIVE',
        },
        onboarding: 'DONE',
      });
    }
    if (method === 'GET' && pathname === '/api/admin/dashboard') {
      return this.json(route, {
        users: 1,
        teams: 1,
        pendingApplications: 0,
        pendingPluginReviews: 0,
        activePluginPackages: 3,
        activeMarketplaceListings: 1,
        delistedMarketplaceListings: 2,
      });
    }
    if (method === 'GET' && pathname === '/api/admin/stats/generation') {
      return this.json(route, {
        period: '2026-07',
        month: { calls: 0, success: 0, failed: 0, successRate: 0 },
        total: { calls: 0, success: 0, failed: 0, successRate: 0 },
        avgDurationMs: null,
      });
    }
    if (method === 'GET' && pathname === '/api/admin/stats/finance') {
      return this.json(route, {
        period: '2026-07',
        month: { gmvCents: 0 },
        total: { gmvCents: 0 },
        platformRevenueCents: 0,
        paidUserCount: 0,
        totalUserCount: 1,
        conversionRate: 0,
        topPlugins: [],
      });
    }

    if (method === 'GET' && pathname === '/api/admin/plugin-packages') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
      const search = url.searchParams.get('search')?.toLocaleLowerCase();
      const status = url.searchParams.get('status');
      const reviewStatus = url.searchParams.get('reviewStatus');
      const sourceKind = url.searchParams.get('sourceKind');
      const items = this.packages
        .map((fixture) => this.packageListItem(fixture))
        .filter((item) => !search || `${item.name} ${item.manifestId}`.toLocaleLowerCase().includes(search))
        .filter((item) => !status || item.governanceStatus === status)
        .filter((item) => !reviewStatus || item.latestRelease?.marketReviewStatus === reviewStatus)
        .filter((item) => !sourceKind || item.latestRelease?.sourceKind === sourceKind);
      return this.json(route, pageOf(items, page, pageSize));
    }

    const relistMatch = pathname.match(/^\/api\/admin\/plugin-packages\/([^/]+)\/relist$/);
    if (method === 'POST' && relistMatch) {
      const fixture = this.findPackage(relistMatch[1]);
      if (!fixture || fixture.listing?.status !== 'DELISTED' || fixture.listing.delistedBy !== 'PLATFORM') {
        return this.json(route, { message: '只有平台下架的插件可以恢复' }, 409);
      }
      const currentReleaseId = fixture.listing.currentReleaseId;
      if (!currentReleaseId) return this.json(route, { message: '缺少市场当前发行版' }, 409);
      fixture.listing = activeListing(currentReleaseId);
      return this.json(route, { ok: true });
    }

    const releasesMatch = pathname.match(/^\/api\/admin\/plugin-packages\/([^/]+)\/releases$/);
    if (method === 'GET' && releasesMatch) {
      const fixture = this.findPackage(releasesMatch[1]);
      if (!fixture) return this.notFound(route);
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
      return this.json(route, pageOf(
        fixture.releases.map((release) => this.releaseListItem(fixture, release)),
        page,
        pageSize,
      ));
    }

    const packageMatch = pathname.match(/^\/api\/admin\/plugin-packages\/([^/]+)$/);
    if (method === 'GET' && packageMatch) {
      const fixture = this.findPackage(packageMatch[1]);
      return fixture ? this.json(route, this.packageDetail(fixture)) : this.notFound(route);
    }

    const delistMatch = pathname.match(/^\/api\/admin\/plugin-releases\/([^/]+)\/delist$/);
    if (method === 'POST' && delistMatch) {
      if (this.delistConflictsRemaining > 0) {
        this.delistConflictsRemaining -= 1;
        return this.json(route, { message: '发行版状态已变化', code: 'plugin_state_conflict' }, 409);
      }
      const match = this.findRelease(delistMatch[1]);
      if (!match || !this.isMarketplaceCurrent(match.fixture, match.release)) {
        return this.json(route, { message: '只能下架精确的市场当前发行版' }, 409);
      }
      const reason = typeof recorded.body === 'object' && recorded.body
        ? String((recorded.body as { reason?: unknown }).reason ?? '')
        : '';
      match.fixture.listing = {
        status: 'DELISTED',
        currentReleaseId: match.release.core.id,
        priceCents: match.fixture.listing?.priceCents ?? 0,
        delistedBy: 'PLATFORM',
        delistReason: reason,
        delistedAt: NOW,
        delistedByUserId: ADMIN_ID,
      };
      return this.json(route, { ok: true });
    }

    const manifestMatch = pathname.match(/^\/api\/admin\/plugin-releases\/([^/]+)\/manifest$/);
    if (method === 'GET' && manifestMatch) {
      const match = this.findRelease(manifestMatch[1]);
      return match ? this.json(route, match.release.manifest) : this.notFound(route);
    }

    const filesMatch = pathname.match(/^\/api\/admin\/plugin-releases\/([^/]+)\/files$/);
    if (method === 'GET' && filesMatch) {
      const match = this.findRelease(filesMatch[1]);
      if (!match) return this.notFound(route);
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      return this.json(route, pageOf(match.release.files, page, pageSize));
    }

    const reviewsMatch = pathname.match(/^\/api\/admin\/plugin-releases\/([^/]+)\/reviews$/);
    if (method === 'GET' && reviewsMatch) {
      const match = this.findRelease(reviewsMatch[1]);
      if (!match) return this.notFound(route);
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
      return this.json(route, pageOf(match.release.reviews, page, pageSize));
    }

    const releaseMatch = pathname.match(/^\/api\/admin\/plugin-releases\/([^/]+)$/);
    if (method === 'GET' && releaseMatch) {
      const match = this.findRelease(releaseMatch[1]);
      return match ? this.json(route, this.releaseCore(match.fixture, match.release)) : this.notFound(route);
    }

    return this.json(route, { message: `未模拟的 API：${method} ${pathname}` }, 404);
  }

  private findPackage(packageId: string) {
    return this.packages.find((fixture) => fixture.package.id === packageId);
  }

  private findRelease(releaseId: string) {
    for (const fixture of this.packages) {
      const release = fixture.releases.find((candidate) => candidate.core.id === releaseId);
      if (release) return { fixture, release };
    }
    return null;
  }

  private isMarketplaceCurrent(fixture: PackageFixture, release: ReleaseFixture) {
    return fixture.listing?.status === 'ACTIVE' && fixture.listing.currentReleaseId === release.core.id;
  }

  private releaseSummary(release: ReleaseFixture): AdminPluginReleaseSummary {
    const { core } = release;
    return {
      id: core.id,
      version: core.version,
      status: core.status,
      marketReviewStatus: core.marketReviewStatus,
      sourceKind: core.sourceKind,
      sourceLabel: core.sourceLabel,
      ingestChannel: core.ingestChannel,
      createdAt: core.createdAt,
    };
  }

  private releaseListItem(fixture: PackageFixture, release: ReleaseFixture): AdminPluginReleaseListItem {
    return {
      ...this.releaseSummary(release),
      targetPlatform: release.core.targetPlatform,
      sizeBytes: release.core.sizeBytes,
      isMarketplaceCurrent: this.isMarketplaceCurrent(fixture, release),
    };
  }

  private packageListItem(fixture: PackageFixture): AdminPluginPackageListItem {
    const latestRelease = fixture.releases[0] ?? null;
    const currentRelease = fixture.releases.find((release) => (
      release.core.id === fixture.listing?.currentReleaseId
    ));
    return {
      id: fixture.package.id,
      manifestId: fixture.package.manifestId,
      name: fixture.package.name,
      description: fixture.package.description,
      governanceStatus: fixture.package.governanceStatus,
      ownerTeam: fixture.ownerTeam,
      listing: fixture.listing,
      latestRelease: latestRelease ? this.releaseSummary(latestRelease) : null,
      marketplaceCurrentVersion: currentRelease?.core.version ?? null,
      releaseCount: fixture.releases.length,
      pendingReviewCount: fixture.releases.filter((release) => release.core.marketReviewStatus === 'PENDING').length,
      createdAt: fixture.package.createdAt,
      updatedAt: fixture.package.updatedAt,
    };
  }

  private packageDetail(fixture: PackageFixture): AdminPluginPackageDetail {
    return {
      package: fixture.package,
      ownerTeam: fixture.ownerTeam,
      listing: fixture.listing,
      releaseCount: fixture.releases.length,
      pendingReviewCount: fixture.releases.filter((release) => release.core.marketReviewStatus === 'PENDING').length,
    };
  }

  private releaseCore(fixture: PackageFixture, release: ReleaseFixture): AdminPluginReleaseCoreDetail {
    return {
      release: release.core,
      listing: fixture.listing,
      isMarketplaceCurrent: this.isMarketplaceCurrent(fixture, release),
    };
  }

  private json(route: Route, body: unknown, status = 200) {
    return route.fulfill({
      status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(body),
    });
  }

  private notFound(route: Route) {
    return this.json(route, { message: 'Fixture not found' }, 404);
  }
}
