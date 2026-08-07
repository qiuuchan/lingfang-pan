import { useEffect, useMemo, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type PaginationProps = {
  totalItems: number;
  pageSize: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
};

type PaginationIconButtonProps = Omit<ComponentProps<typeof Button>, 'aria-label' | 'children'> & {
  label: string;
  icon: ReactNode;
  wrapperClassName?: string;
};

const DEFAULT_SIZES = [10, 20, 50];

function PaginationIconButton({
  label,
  icon,
  className,
  wrapperClassName,
  ...props
}: PaginationIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', wrapperClassName)}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn('size-8', className)}
            aria-label={label}
            {...props}
          >
            {icon}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Pagination({
  totalItems,
  pageSize,
  currentPage,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_SIZES,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / Math.max(1, pageSize)));
  const activePage = Math.min(Math.max(1, currentPage), totalPages);

  const pages: (number | 'ellipsis')[] = [];
  if (totalPages <= 7) {
    for (let page = 1; page <= totalPages; page += 1) pages.push(page);
  } else {
    pages.push(1);
    if (activePage > 3) pages.push('ellipsis');
    for (
      let page = Math.max(2, activePage - 1);
      page <= Math.min(totalPages - 1, activePage + 1);
      page += 1
    ) {
      pages.push(page);
    }
    if (activePage < totalPages - 2) pages.push('ellipsis');
    pages.push(totalPages);
  }

  return (
    <div className="flex items-center justify-between gap-2 pt-4">
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="hidden sm:inline">每页</span>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => {
            onPageSizeChange(Number(value));
            onPageChange(1);
          }}
        >
          <SelectTrigger className="h-8 w-[4.5rem]" aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} 条
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="hidden whitespace-nowrap sm:inline">共 {totalItems} 条</span>
      </div>

      <nav className="flex shrink-0 items-center gap-1" aria-label="分页">
        <PaginationIconButton
          label="第一页"
          icon={<ChevronsLeftIcon className="size-3.5" />}
          wrapperClassName="hidden sm:inline-flex"
          disabled={activePage <= 1}
          onClick={() => onPageChange(1)}
        />
        <PaginationIconButton
          label="上一页"
          icon={<ChevronLeftIcon className="size-3.5" />}
          disabled={activePage <= 1}
          onClick={() => onPageChange(activePage - 1)}
        />

        <span className="min-w-14 text-center text-sm tabular-nums text-muted-foreground sm:hidden">
          {activePage}/{totalPages}
        </span>

        <div className="hidden items-center gap-1 sm:flex">
          {pages.map((page, index) =>
            page === 'ellipsis' ? (
              <span
                key={`ellipsis-${index}`}
                className="w-8 text-center text-sm text-muted-foreground"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <Button
                key={page}
                type="button"
                variant={page === activePage ? 'default' : 'outline'}
                size="icon"
                className={cn('size-8 text-xs', page === activePage && 'pointer-events-none')}
                aria-label={`第 ${page} 页`}
                aria-current={page === activePage ? 'page' : undefined}
                tabIndex={page === activePage ? -1 : undefined}
                onClick={() => onPageChange(page)}
              >
                {page}
              </Button>
            )
          )}
        </div>

        <PaginationIconButton
          label="下一页"
          icon={<ChevronRightIcon className="size-3.5" />}
          disabled={activePage >= totalPages}
          onClick={() => onPageChange(activePage + 1)}
        />
        <PaginationIconButton
          label="最后一页"
          icon={<ChevronsRightIcon className="size-3.5" />}
          wrapperClassName="hidden sm:inline-flex"
          disabled={activePage >= totalPages}
          onClick={() => onPageChange(totalPages)}
        />
      </nav>
    </div>
  );
}

/** @deprecated Prefer server-side pagination for remotely loaded collections. */
export function usePagination<T>(items: T[], defaultPageSize = 10) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const effectivePage = Math.min(page, totalPages);

  const paginated = useMemo(() => {
    const start = (effectivePage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, effectivePage, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return {
    paginated,
    page: effectivePage,
    setPage,
    pageSize,
    setPageSize,
    totalItems: items.length,
  };
}
