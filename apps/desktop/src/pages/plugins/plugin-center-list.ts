import type {
  LocalPluginInstallation,
  PluginCatalogItem,
  PluginReleaseSourceKind,
} from '@lingfang/contract';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, paginateItems } from '../../lib/pagination';

export { paginateItems };

/** 插件中心默认每页条数（与全站列表一致：默认 5）。 */
export const PLUGIN_CENTER_PAGE_SIZE = DEFAULT_PAGE_SIZE;

/** 插件中心每页条数可选项。 */
export const PLUGIN_CENTER_PAGE_SIZE_OPTIONS = PAGE_SIZE_OPTIONS;

export type InstallationOriginFilter = 'all' | LocalPluginInstallation['origin'];
export type CatalogSourceFilter = 'all' | PluginReleaseSourceKind;

export function filterInstallations(
  installations: LocalPluginInstallation[],
  origin: InstallationOriginFilter
): LocalPluginInstallation[] {
  if (origin === 'all') return installations;
  return installations.filter((installation) => installation.origin === origin);
}

export function catalogSourceKinds(items: PluginCatalogItem[]): PluginReleaseSourceKind[] {
  return [...new Set(items.map((item) => item.latestRelease.sourceKind))].sort();
}

export function filterCatalogItems(
  items: PluginCatalogItem[],
  source: CatalogSourceFilter
): PluginCatalogItem[] {
  if (source === 'all') return items;
  return items.filter((item) => item.latestRelease.sourceKind === source);
}
