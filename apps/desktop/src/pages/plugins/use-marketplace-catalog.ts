import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, type ApiError } from '@/lib/api';
import type { MarketPlugin } from './MarketplacePluginsSection';

const PAGE_SIZE = 6;

export function useMarketplaceCatalog(active: boolean) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('installs');
  const [plugins, setPlugins] = useState<MarketPlugin[] | null>(null);
  const [detail, setDetail] = useState<MarketPlugin | null>(null);
  const [page, setPage] = useState(1);
  const total = plugins?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageItems = (plugins ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const search = useCallback(async () => {
    await searchMarketplace({ q, setPage, setPlugins, sort });
  }, [q, sort]);

  const openDetail = useCallback(async (id: string) => {
    await openMarketplaceDetail(id, setDetail);
  }, []);

  useEffect(() => {
    if (active && plugins === null) void search();
  }, [active, plugins, search]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  return {
    detail,
    openDetail,
    page,
    pageItems,
    plugins,
    q,
    search,
    setDetail,
    setPage,
    setQ,
    setSort,
    sort,
    total,
    totalPages,
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
