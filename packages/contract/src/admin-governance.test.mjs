import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdminDelistReasonRequest,
  AdminPaginationMetadata,
  AdminRejectReasonRequest,
  AdminUserSummary,
  TeamAdminApplicationDetailResponse,
  TeamAdminApplicationPage,
} from './admin-governance.ts';
import {
  AdminPluginListingProjection,
  AdminPluginPackagePage,
  AdminPluginReleaseCoreDetail,
  AdminPluginReleaseManifest,
  AdminPluginReleasePage,
} from './plugin-registry.ts';

const PACKAGE_ID = '11111111-1111-4111-8111-111111111111';
const RELEASE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const APPLICATION_ID = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = '2026-07-12T00:00:00.000Z';

const user = {
  id: USER_ID,
  email: 'reviewer@example.com',
  displayName: 'Reviewer',
};

const releaseSummary = {
  id: RELEASE_ID,
  version: '1.2.3',
  status: 'PUBLISHED',
  marketReviewStatus: 'PENDING',
  sourceKind: 'EXTERNAL_TOOL',
  sourceLabel: 'Cursor',
  ingestChannel: 'DESKTOP',
  createdAt: CREATED_AT,
};

const packageItem = {
  id: PACKAGE_ID,
  manifestId: 'demo.plugin',
  name: 'Demo',
  description: 'Demo plugin',
  governanceStatus: 'ACTIVE',
  ownerTeam: { id: TEAM_ID, name: 'Demo Team', slug: 'demo-team' },
  listing: null,
  latestRelease: releaseSummary,
  marketplaceCurrentVersion: null,
  releaseCount: 2,
  pendingReviewCount: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

test('admin page metadata enforces bounded server-side pagination', () => {
  assert.equal(AdminPaginationMetadata.safeParse({ total: 0, page: 1, pageSize: 20 }).success, true);
  assert.equal(AdminPaginationMetadata.safeParse({ total: -1, page: 1, pageSize: 20 }).success, false);
  assert.equal(AdminPaginationMetadata.safeParse({ total: 1, page: 0, pageSize: 20 }).success, false);
  assert.equal(AdminPaginationMetadata.safeParse({ total: 1, page: 1, pageSize: 0 }).success, false);
  assert.equal(AdminPaginationMetadata.safeParse({ total: 1, page: 1, pageSize: 101 }).success, false);
});

test('admin user summary exposes only identity display fields', () => {
  assert.equal(AdminUserSummary.safeParse(user).success, true);
  assert.equal(AdminUserSummary.safeParse({ ...user, status: 'ACTIVE' }).success, false);
  assert.equal(AdminUserSummary.safeParse({ ...user, platformRole: 'PLATFORM_ADMIN' }).success, false);
});

test('admin plugin package page rejects heavyweight list fields', () => {
  assert.equal(AdminPluginPackagePage.safeParse({
    items: [packageItem], total: 1, page: 1, pageSize: 20,
  }).success, true);
  assert.equal(AdminPluginPackagePage.safeParse({
    items: [{ ...packageItem, manifest: {}, fileManifest: [], reviews: [] }],
    total: 1,
    page: 1,
    pageSize: 20,
  }).success, false);
  assert.equal(AdminPluginPackagePage.safeParse({
    items: [{ ...packageItem, latestRelease: { ...releaseSummary, manifest: {} } }],
    total: 1,
    page: 1,
    pageSize: 20,
  }).success, false);
  assert.equal(AdminPluginPackagePage.safeParse({
    items: [{ ...packageItem, marketplaceCurrentVersion: 'v1.2.3' }],
    total: 1,
    page: 1,
    pageSize: 20,
  }).success, false);
  assert.equal(AdminPluginPackagePage.safeParse({
    items: [{ ...packageItem, latestRelease: { ...releaseSummary, sourceKind: 'CURSOR' } }],
    total: 1,
    page: 1,
    pageSize: 20,
  }).success, false);
  const { marketplaceCurrentVersion: _omitted, ...withoutCurrentVersion } = packageItem;
  assert.equal(AdminPluginPackagePage.safeParse({
    items: [withoutCurrentVersion], total: 1, page: 1, pageSize: 20,
  }).success, false);
});

test('admin release list and core detail reject deferred payload fields', () => {
  const listItem = {
    ...releaseSummary,
    targetPlatform: 'windows-x64',
    sizeBytes: 1024,
    isMarketplaceCurrent: false,
  };
  assert.equal(AdminPluginReleasePage.safeParse({
    items: [listItem], total: 1, page: 1, pageSize: 20,
  }).success, true);
  for (const field of ['manifest', 'fileManifest', 'artifactKey', 'reviews']) {
    assert.equal(AdminPluginReleasePage.safeParse({
      items: [{ ...listItem, [field]: field === 'artifactKey' ? 'private/key' : [] }],
      total: 1,
      page: 1,
      pageSize: 20,
    }).success, false, field);
  }

  const release = {
    id: RELEASE_ID,
    packageId: PACKAGE_ID,
    version: '1.2.3',
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    targetPlatform: 'windows-x64',
    status: 'PUBLISHED',
    marketReviewStatus: 'PENDING',
    reviewReason: '',
    reviewedById: null,
    reviewedAt: null,
    sourceKind: 'API',
    sourceLabel: '',
    ingestChannel: 'API',
    createdAt: CREATED_AT,
  };
  assert.equal(AdminPluginReleaseCoreDetail.safeParse({
    release, listing: null, isMarketplaceCurrent: false,
  }).success, true);
  assert.equal(AdminPluginReleaseCoreDetail.safeParse({
    release: { ...release, manifest: {} }, listing: null, isMarketplaceCurrent: false,
  }).success, false);
  assert.equal(AdminPluginReleaseManifest.safeParse({
    releaseId: RELEASE_ID,
    manifest: {
      id: 'demo.plugin', name: 'Demo', version: '1.2.3', entry: 'main.py', runtime_type: 'python',
    },
  }).success, true);
});

test('delisted listings retain their release pointer without becoming marketplace-current', () => {
  assert.equal(AdminPluginListingProjection.safeParse({
    status: 'ACTIVE', priceCents: 0, currentReleaseId: RELEASE_ID,
    delistedBy: null, delistReason: '', delistedAt: null, delistedByUserId: null,
  }).success, true);
  assert.equal(AdminPluginListingProjection.safeParse({
    status: 'DELISTED', priceCents: 0, currentReleaseId: null,
    delistedBy: 'PLATFORM', delistReason: 'policy', delistedAt: CREATED_AT, delistedByUserId: USER_ID,
  }).success, true);
  assert.equal(AdminPluginListingProjection.safeParse({
    status: 'DELISTED', priceCents: 0, currentReleaseId: RELEASE_ID,
    delistedBy: 'PLATFORM', delistReason: 'policy', delistedAt: CREATED_AT, delistedByUserId: USER_ID,
  }).success, true);
});

test('team admin application list excludes reasons while detail carries them', () => {
  const summary = {
    id: APPLICATION_ID,
    teamName: 'Demo Team',
    status: 'PENDING',
    createdAt: CREATED_AT,
    user,
  };
  assert.equal(TeamAdminApplicationPage.safeParse({
    items: [summary], total: 1, page: 1, pageSize: 20,
  }).success, true);
  assert.equal(TeamAdminApplicationPage.safeParse({
    items: [{ ...summary, reason: 'full application reason', reviewReason: '' }],
    total: 1,
    page: 1,
    pageSize: 20,
  }).success, false);
  assert.equal(TeamAdminApplicationDetailResponse.safeParse({
    application: {
      ...summary,
      reason: 'full application reason',
      reviewReason: '',
      reviewedAt: null,
      reviewedBy: null,
    },
  }).success, true);
});

test('reject and delist reasons trim input and enforce 1..500 characters', () => {
  for (const schema of [AdminRejectReasonRequest, AdminDelistReasonRequest]) {
    assert.equal(schema.parse({ reason: '  policy violation  ' }).reason, 'policy violation');
    assert.equal(schema.safeParse({ reason: 'x'.repeat(500) }).success, true);
    assert.equal(schema.safeParse({ reason: '' }).success, false);
    assert.equal(schema.safeParse({ reason: '   ' }).success, false);
    assert.equal(schema.safeParse({ reason: 'x'.repeat(501) }).success, false);
  }
});
