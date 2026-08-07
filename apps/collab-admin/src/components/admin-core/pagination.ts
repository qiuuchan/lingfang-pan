import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { Page } from '@/components/admin-core/types';

export function usePageCorrection<T>(
  data: Page<T> | null,
  page: number,
  pageSize: number,
  setPage: Dispatch<SetStateAction<number>>
) {
  useEffect(() => {
    if (!data || data.page !== page || data.pageSize !== pageSize) return;
    const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [data, page, pageSize, setPage]);
}
