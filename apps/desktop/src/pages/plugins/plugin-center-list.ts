import type { LocalPluginInstallation, PluginCatalogItem, PluginReleaseSourceKind } from '@lingfang/contract';

export const PLUGIN_CENTER_PAGE_SIZE = 10;

export type InstallationOriginFilter = 'all' | LocalPluginInstallation['origin'];
export type CatalogSourceFilter = 'all' | PluginReleaseSourceKind;

export function filterInstallations(
  installations: LocalPluginInstallation[],
  origin: InstallationOriginFilter,
): LocalPluginInstallation[] {
  if (origin === 'all') return installations;
  return installations.filter((installation) => installation.origin === origin);
}

export function catalogSourceKinds(items: PluginCatalogItem[]): PluginReleaseSourceKind[] {
  return [...new Set(items.map((item) => item.latestRelease.sourceKind))].sort();
}

export function filterCatalogItems(
  items: PluginCatalogItem[],
  source: CatalogSourceFilter,
): PluginCatalogItem[] {
  if (source === 'all') return items;
  return items.filter((item) => item.latestRelease.sourceKind === source);
}

export function paginateItems<T>(items: T[], page: number, pageSize = PLUGIN_CENTER_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    currentPage,
    totalPages,
    items: items.slice(start, start + pageSize),
  };
}
