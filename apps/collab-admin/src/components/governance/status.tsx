import { Badge } from '@/components/ui/badge';
import type {
  PluginDelistActor,
  PluginGovernanceStatus,
  PluginIngestChannel,
  PluginListingStatus,
  PluginReleaseStatus,
  PluginReviewStatus,
  PluginSourceKind,
} from '@/components/governance/types';

export const SOURCE_KIND_LABELS: Record<PluginSourceKind, string> = {
  LINGFANG_CREATOR: '灵枋创建器',
  EXTERNAL_TOOL: '外部开发工具',
  LOCAL_ARTIFACT: '本地插件包',
  COPIED_INSTALLATION: '从已安装插件复制',
  API: 'API 上传',
  LEGACY_MIGRATION: '旧版迁移',
  UNKNOWN: '历史来源未知',
};

const INGEST_CHANNEL_LABELS: Record<PluginIngestChannel, string> = {
  DESKTOP: '桌面端',
  API: 'API',
  MIGRATION: '迁移程序',
};

export function sourceKindLabel(value: PluginSourceKind) {
  return SOURCE_KIND_LABELS[value];
}

export function ingestChannelLabel(value: PluginIngestChannel) {
  return INGEST_CHANNEL_LABELS[value];
}

export function delistActorLabel(value: PluginDelistActor | null) {
  if (value === 'PLATFORM') return '平台管理员';
  if (value === 'OWNER') return '插件所有者';
  return '历史记录未标注';
}

export function PackageStatusBadge({ value }: { value: PluginGovernanceStatus }) {
  return value === 'ACTIVE' ? (
    <Badge variant="success">包正常</Badge>
  ) : (
    <Badge variant="secondary">包已归档</Badge>
  );
}

export function ReleaseStatusBadge({ value }: { value: PluginReleaseStatus }) {
  return value === 'PUBLISHED' ? (
    <Badge variant="success">已发布</Badge>
  ) : (
    <Badge variant="destructive">已撤回</Badge>
  );
}

export function PluginSourceSummary({
  sourceKind,
  sourceLabel,
  ingestChannel,
  showPrefix = false,
}: {
  sourceKind: PluginSourceKind;
  sourceLabel: string;
  ingestChannel: PluginIngestChannel;
  showPrefix?: boolean;
}) {
  const kindLabel = sourceKindLabel(sourceKind);
  const normalizedSourceLabel = sourceLabel.trim();
  const hasDistinctLabel = normalizedSourceLabel && normalizedSourceLabel !== kindLabel;
  return (
    <div className="min-w-0 space-y-0.5 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        {showPrefix ? <span className="text-muted-foreground">发布来源</span> : null}
        <Badge variant="outline">{kindLabel}</Badge>
        <span className="text-muted-foreground">经 {ingestChannelLabel(ingestChannel)}接入</span>
      </div>
      {hasDistinctLabel ? (
        <div className="break-words text-muted-foreground" title={normalizedSourceLabel}>
          {normalizedSourceLabel}
        </div>
      ) : null}
    </div>
  );
}

export function ReviewBadge({ value }: { value: PluginReviewStatus }) {
  const labels: Record<PluginReviewStatus, string> = {
    DRAFT: '未提交',
    PENDING: '待审核',
    APPROVED: '已通过',
    REJECTED: '已驳回',
  };
  const variant =
    value === 'APPROVED'
      ? 'success'
      : value === 'PENDING'
        ? 'warning'
        : value === 'REJECTED'
          ? 'destructive'
          : 'secondary';
  return <Badge variant={variant}>{labels[value]}</Badge>;
}

export function ListingBadge({ status }: { status: PluginListingStatus | null }) {
  if (!status) return <Badge variant="secondary">未上架</Badge>;
  if (status === 'ACTIVE') return <Badge variant="success">上架中</Badge>;
  if (status === 'DELISTED') return <Badge variant="destructive">已下架</Badge>;
  return <Badge variant="secondary">草稿</Badge>;
}
