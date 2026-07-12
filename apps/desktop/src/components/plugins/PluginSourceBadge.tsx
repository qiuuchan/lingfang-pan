import type { PluginIngestChannel, PluginReleaseSourceKind } from '@lingfang/contract';
import { Badge } from '@/components/ui/badge';
import { DEFAULT_SOURCE_LABELS } from '@/lib/plugin-provenance';

const CHANNEL_NAMES: Record<PluginIngestChannel, string> = {
  DESKTOP: '桌面端',
  API: 'API',
  MIGRATION: '迁移',
};

export function pluginSourceText(sourceKind: PluginReleaseSourceKind, sourceLabel?: string | null) {
  const label = sourceLabel?.trim();
  return label || DEFAULT_SOURCE_LABELS[sourceKind] || DEFAULT_SOURCE_LABELS.UNKNOWN;
}

export function PluginSourceBadge({ sourceKind, sourceLabel, ingestChannel }: { sourceKind: PluginReleaseSourceKind; sourceLabel?: string | null; ingestChannel?: PluginIngestChannel }) {
  const source = pluginSourceText(sourceKind, sourceLabel);
  const channel = ingestChannel ? CHANNEL_NAMES[ingestChannel] : null;
  const text = `发布来源：${source}${channel ? ` · ${channel}` : ''}`;
  return <Badge variant="outline" className="min-w-0 max-w-full sm:max-w-64" title={text}><span className="truncate">{text}</span></Badge>;
}
