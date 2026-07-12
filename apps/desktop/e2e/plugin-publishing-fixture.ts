export const PACKAGE_ID = '11111111-1111-4111-8111-111111111111';
export const TEAM_ID = '22222222-2222-4222-8222-222222222222';
export const USER_ID = '33333333-3333-4333-8333-333333333333';
export const RELEASE_ID = '44444444-4444-4444-8444-444444444444';
export const CREATED_AT = '2026-07-12T08:00:00.000Z';

export const pluginPermissions = [
  'team.plugin.list',
  'team.plugin.upload',
  'team.plugin.edit_metadata',
  'team.plugin.edit_draft',
  'team.plugin.edit_price',
  'team.plugin.submit_marketplace',
];

export const packageSummary = {
  id: PACKAGE_ID,
  ownerTeamId: TEAM_ID,
  authorUserId: USER_ID,
  manifestId: 'external.demo',
  name: '外部工具示例插件',
  description: '从外部开发工具导入',
  governanceStatus: 'ACTIVE',
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

export const releaseSummary = {
  id: RELEASE_ID,
  packageId: PACKAGE_ID,
  version: '1.2.3',
  manifest: {
    id: 'external.demo',
    name: '外部工具示例插件',
    version: '1.2.3',
    description: '从外部开发工具导入',
    runtime_type: 'client',
    entry: 'ui/index.html',
    visibility: 'tenant',
    capabilities: [],
  },
  sha256: 'a'.repeat(64),
  sizeBytes: 4096,
  status: 'PUBLISHED',
  marketReviewStatus: 'DRAFT',
  targetPlatform: 'windows-x64',
  sourceKind: 'EXTERNAL_TOOL',
  sourceLabel: 'VS Code 工程',
  ingestChannel: 'DESKTOP',
  createdAt: CREATED_AT,
};

export const listing = {
  status: 'DRAFT',
  currentReleaseId: null,
  priceCents: 0,
  delistedBy: null,
  delistReason: '',
  delistedAt: null,
  delistedByUserId: null,
};

export const managementItem = {
  package: packageSummary,
  latestRelease: releaseSummary,
  releaseCount: 1,
  pendingReviewCount: 0,
  listing,
};
