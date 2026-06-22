import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type ApiError } from '@/lib/api';
import { filterByCategory, type CategoryKey } from '@/lib/marketplace-categories';
import type { MarketPlugin } from './MarketplacePluginsSection';

const PAGE_SIZE = 6;

export function useMarketplaceCatalog(active: boolean) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('installs');
  // Task 1：市场分类（客户端自动分类过滤，'all' = 不过滤）。
  const [category, setCategory] = useState<CategoryKey | 'all'>('all');
  const [plugins, setPlugins] = useState<MarketPlugin[] | null>(null);
  const [detail, setDetail] = useState<MarketPlugin | null>(null);
  const [page, setPage] = useState(1);

  // 服务端按 q+sort 拉全量，客户端再按分类过滤（q 已由服务端搜索过滤，此处仅按 category，避免双重过滤误删）。
  const filtered = useMemo(
    () => (plugins ? filterByCategory(plugins, category, '') : null),
    [plugins, category],
  );
  const total = filtered?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = (filtered ?? []).slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const search = useCallback(async () => {
    await searchMarketplace({ q, setPage, setPlugins, sort });
  }, [q, sort]);

  const openDetail = useCallback(async (id: string) => {
    await openMarketplaceDetail(id, setDetail);
  }, []);

  // 首次激活拉取全量（category/q 为初始值）。
  useEffect(() => {
    if (active && plugins === null) void search();
  }, [active, plugins, search]);

  // 分类/搜索变化后页码越界收敛。
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  return {
    detail,
    openDetail,
    page: safePage,
    setPage,
    pageItems,
    plugins: filtered,
    q,
    search,
    setDetail,
    setQ,
    setSort,
    sort,
    total,
    totalPages,
    // Task 1 分类。
    category,
    setCategory,
  };
}

async function searchMarketplace({
  q,
  setPage,
  setPlugins,
  sort,
}: {
  q: string;
  setPage: (page: number) => void;
  setPlugins: (plugins: MarketPlugin[]) => void;
  sort: string;
}) {
  try {
    const data = await api<{ plugins: MarketPlugin[] }>(`/api/marketplace/search?q=${encodeURIComponent(q)}&sort=${sort}`);
    setPlugins(data.plugins);
    setPage(1);
  } catch (e) {
    toast.error((e as ApiError).message);
    setPlugins([]);
  }
}

async function openMarketplaceDetail(id: string, setDetail: (plugin: MarketPlugin) => void) {
  try {
    setDetail(await api<MarketPlugin>(`/api/marketplace/plugins/${id}`));
  } catch (e) {
    toast.error((e as ApiError).message);
  }
}
