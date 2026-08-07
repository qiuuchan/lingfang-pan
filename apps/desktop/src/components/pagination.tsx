import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PAGE_SIZE_OPTIONS } from '@/lib/pagination';

/** 受控分页条：页码从 1 起。
 *  - 只传 page/totalPages/onChange 时：总页数 <= 1 不渲染（保持旧行为）。
 *  - 再传 total + pageSize + onPageSizeChange 时：额外渲染「每页 N 条」选择器
 *    （默认选项 5/10/20/50），总条数为 0 时不渲染。 */
export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  onChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  total?: number;
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const showSizeSelect = pageSize != null && onPageSizeChange != null;
  if (!showSizeSelect && totalPages <= 1) return null;
  if (showSizeSelect && (total ?? 0) === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-2 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        {total != null && <span className="tabular-nums">共 {total} 条</span>}
        {showSizeSelect && (
          <Select value={pageSize} onValueChange={(value) => onPageSizeChange(Number(value))}>
            <SelectTrigger className="w-24" aria-label="每页显示条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {option} 条/页
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeftIcon className="size-4" />
          上一页
        </Button>
        <span className="tabular-nums text-muted-foreground">
          第 {page} / {totalPages} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          下一页
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
