import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

// 受控分页条：页码从 1 起。total<=1 页时不渲染，避免无意义占位。
export function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 pt-1 text-sm">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <ChevronLeftIcon className="size-4" />上一页
      </Button>
      <span className="tabular-nums text-muted-foreground">第 {page} / {totalPages} 页</span>
      <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        下一页<ChevronRightIcon className="size-4" />
      </Button>
    </div>
  );
}
