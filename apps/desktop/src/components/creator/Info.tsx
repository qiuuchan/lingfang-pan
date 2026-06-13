import { cn } from '@/lib/utils';

/**
 * 详情面板的键值信息卡片。
 * - 默认 break-all（长路径/自然换行，完整可见），不再强制单行截断。
 * - 需要单行截断的短值（状态/退出码等）传 truncate=true。
 * - 长值始终带 title 属性，原生鼠标悬浮显示全量。
 */
export function Info({ label, value, truncate }: { label: string; value: string; truncate?: boolean }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('font-medium', truncate ? 'truncate' : 'break-all')} title={value}>{value}</div>
    </div>
  );
}
