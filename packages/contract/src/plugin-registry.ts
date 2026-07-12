import { z } from 'zod';
import { PluginManifest, RuntimeType } from './plugin.ts';

const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const StrictSemVer = z.string().refine((value) => STRICT_SEMVER_PATTERN.test(value), {
  message: 'version must be a strict SemVer value',
});
export type StrictSemVer = z.infer<typeof StrictSemVer>;

export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be lowercase hexadecimal');
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const PluginPackageGovernanceStatus = z.enum(['ACTIVE', 'ARCHIVED']);
export const PluginReleaseStatus = z.enum(['PUBLISHED', 'YANKED']);
export const PluginReleaseReviewStatus = z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED']);
export const MarketplaceListingStatus = z.enum(['DRAFT', 'ACTIVE', 'DELISTED']);

export const PluginPackageSummary = z.object({
  id: z.string().uuid(),
  ownerTeamId: z.string().uuid(),
  authorUserId: z.string().uuid().nullable(),
  manifestId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  governanceStatus: PluginPackageGovernanceStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PluginPackageSummary = z.infer<typeof PluginPackageSummary>;

export const PluginReleaseSummary = z.object({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  version: StrictSemVer,
  manifest: PluginManifest,
  sha256: Sha256Hex,
  sizeBytes: z.number().int().nonnegative().max(300 * 1024 * 1024),
  status: PluginReleaseStatus,
  marketReviewStatus: PluginReleaseReviewStatus,
  targetPlatform: z.literal('windows-x64'),
  createdAt: z.string().datetime(),
});
export type PluginReleaseSummary = z.infer<typeof PluginReleaseSummary>;

export const PluginCatalogItem = z.object({
  package: PluginPackageSummary,
  latestRelease: PluginReleaseSummary,
  priceCents: z.number().int().nonnegative().optional(),
  listingStatus: MarketplaceListingStatus.optional(),
  entitled: z.boolean().optional(),
});
export type PluginCatalogItem = z.infer<typeof PluginCatalogItem>;

export const PluginEntitlement = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  packageId: z.string().uuid(),
  kind: z.literal('PURCHASED'),
  purchaseId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type PluginEntitlement = z.infer<typeof PluginEntitlement>;

export const LocalPluginOrigin = z.enum(['builtin', 'local', 'team', 'marketplace']);
export const DependencyPreparationStatus = z.enum(['pending', 'preparing', 'ready', 'failed']);

export const LocalPluginReleaseRef = z.object({
  releaseId: z.string().min(1),
  version: StrictSemVer,
  sha256: Sha256Hex,
  path: z.string().min(1),
  dependencyStatus: DependencyPreparationStatus,
});

export const LocalPluginInstallation = z.object({
  installationId: z.string().uuid(),
  packageId: z.string().min(1),
  origin: LocalPluginOrigin,
  protected: z.boolean().default(false),
  activeRelease: LocalPluginReleaseRef,
  pendingRelease: LocalPluginReleaseRef.nullable(),
  previousRelease: LocalPluginReleaseRef.nullable(),
  dataPath: z.string().min(1),
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LocalPluginInstallation = z.infer<typeof LocalPluginInstallation>;

export const DraftDiagnosticStatus = z.enum(['idle', 'checking', 'ready', 'warning', 'error']);
export const DraftWorkspace = z.object({
  workspaceId: z.string().uuid(),
  title: z.string().min(1),
  path: z.string().min(1),
  manifestId: z.string().min(1),
  currentVersion: StrictSemVer,
  runtime: RuntimeType,
  conversationId: z.string().nullable(),
  diagnosticStatus: DraftDiagnosticStatus,
  contentSha256: Sha256Hex.nullable(),
  lastPublishedReleaseId: z.string().uuid().nullable(),
  lastPublishedVersion: StrictSemVer.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DraftWorkspace = z.infer<typeof DraftWorkspace>;
