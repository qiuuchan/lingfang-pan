import type {
  AdminPage,
  AdminPluginListingProjection,
  AdminPluginOwnerTeamSummary,
  AdminPluginPackageDetail as ContractPluginPackageDetail,
  AdminPluginPackageListItem,
  AdminPluginReleaseCoreDetail,
  AdminPluginReleaseFile,
  AdminPluginReleaseListItem,
  AdminPluginReleaseManifest,
  AdminPluginReleaseReview,
  AdminUserSummary,
  TeamAdminApplicationDetail as ContractApplicationDetail,
  TeamAdminApplicationStatus,
  TeamAdminApplicationSummary as ContractApplicationSummary,
} from '@lingfang/contract';

export type GovernanceTab = 'plugins' | 'applications';

export type PluginReviewStatus = AdminPluginReleaseListItem['marketReviewStatus'];
export type PluginGovernanceStatus = AdminPluginPackageListItem['governanceStatus'];
export type PluginListingStatus = AdminPluginListingProjection['status'];
export type PluginReleaseStatus = AdminPluginReleaseListItem['status'];
export type PluginSourceKind = AdminPluginReleaseCoreDetail['release']['sourceKind'];
export type PluginIngestChannel = AdminPluginReleaseCoreDetail['release']['ingestChannel'];
export type PluginDelistActor = NonNullable<AdminPluginListingProjection['delistedBy']>;
export type ApplicationStatus = TeamAdminApplicationStatus;

export type GovernanceIntent = {
  tab: GovernanceTab;
  reviewStatus?: PluginReviewStatus;
  applicationStatus?: ApplicationStatus;
  nonce: number;
};

export type Page<T> = AdminPage<T>;
export type GovernanceUserSummary = AdminUserSummary;
export type GovernanceTeamSummary = AdminPluginOwnerTeamSummary;
export type PluginListingSummary = AdminPluginListingProjection;
export type PluginReleaseSummary = AdminPluginReleaseListItem;
export type PluginPackageSummary = AdminPluginPackageListItem;
export type PluginPackageDetail = ContractPluginPackageDetail;
export type PluginReleaseCore = AdminPluginReleaseCoreDetail;
export type PluginManifestDetail = AdminPluginReleaseManifest;
export type PluginFileSummary = AdminPluginReleaseFile;
export type PluginReviewSummary = AdminPluginReleaseReview;
export type TeamAdminApplicationSummary = ContractApplicationSummary;
export type TeamAdminApplicationDetail = ContractApplicationDetail;
