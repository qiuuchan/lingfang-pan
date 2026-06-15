// 组D 审计完善：audit-view 增强为「分类筛选 + 关键词搜索 + 中文说明 + 详情展开」。
//
// 设计：
//  - 分类筛选：下拉选择分类（auth/team/plugin/...），传 category query 触发后端过滤。
//  - 关键词搜索：输入框 debounce 300ms，传 q query 触发后端搜索（action / actor email / targetId）。
//  - 中文说明：列展示 actionLabel(action)（action → 中文映射），原 action 作为副标小字展示。
//  - 详情展开：保留 Dialog 模式，点行展开 metadata 完整 JSON + actor 信息 + target 信息。
//
// 后端过滤 vs 客户端过滤：后端 take:200 限制结果集，分类/关键词在服务端 where 过滤更精准，
// 客户端仅做分页（20 条/页），避免本地全量过滤导致空页。
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EyeIcon, RotateCwIcon, SearchIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Section } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { AuditLog, AuditCategoryKey } from '@/lib/types';
import {
  AUDIT_CATEGORIES,
  actionLabel,
  targetLabel,
  formatTime,
  localizeMetadata,
  auditCategory,
  categoryLabel,
} from '@/lib/types';

type CategoryFilter = AuditCategoryKey | 'ALL';

export function AuditView() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [category, setCategory] = useState<CategoryFilter>('ALL');
  const [query, setQuery] = useState('');
  // debounce 后的搜索词：避免每次按键都触发后端请求（300ms 防抖）。
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(true);
  // 修复 AUDIT-ERR：此前 catch 完全静默，非 401 错误（网络中断/500）时表格看起来是空的，
  // 管理员无法区分「真的无日志」与「加载失败」。加 error 状态：仅非 401 错误时记录，在空状态区分展示。
  // 401 仍由 api() 的 UNAUTHORIZED 事件统一处理（不在此重复记录）。
  const [error, setError] = useState<string | null>(null);

  // 防抖：query 变化后 300ms 同步到 debouncedQuery，触发后端重新拉取。
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // 构建查询参数：category / q 非空时附加到 query string。
  const params = new URLSearchParams();
  if (category !== 'ALL') params.set('category', category);
  if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
  const qs = params.toString();

  // 响应式拉取：category / debouncedQuery 变化时重新请求后端。
  // qs 为依赖：category 与 debouncedQuery 的合成产物，单一依赖避免重复请求。
  // mounted 守卫：卸载后不 setState（与 useLoad 同款防孤儿 toast/状态更新）。
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    api<{ logs: AuditLog[] }>(`/api/admin/audit-logs${qs ? `?${qs}` : ''}`)
      .then((r) => {
        if (mounted) setLogs(r.logs);
      })
      .catch((e: Error & { status?: number }) => {
        // 401 由 api() 的 UNAUTHORIZED 事件统一处理；其他错误记录以便区分「无日志」与「加载失败」。
        if (!mounted) return;
        if (e.status === 401) return;
        if (mounted) setError(e.message || '加载审计日志失败');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [qs]);

  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(logs, 20);

  const reload = () => {
    setLoading(true);
    setError(null);
    api<{ logs: AuditLog[] }>(`/api/admin/audit-logs${qs ? `?${qs}` : ''}`)
      .then((r) => setLogs(r.logs))
      .catch((e: Error & { status?: number }) => {
        if (e.status === 401) return;
        setError(e.message || '加载审计日志失败');
      })
      .finally(() => setLoading(false));
  };

  return (
    <Section title="审计日志" description="平台级操作记录，支持按分类筛选与关键词搜索。">
      <div className="space-y-4">
        {/* 工具栏：分类筛选 + 关键词搜索 + 刷新 */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative max-w-xs flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索 action / 操作者邮箱 / 对象 ID"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={category} onValueChange={(v) => setCategory(v as CategoryFilter)}>
              <SelectTrigger className="sm:w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部分类</SelectItem>
                {AUDIT_CATEGORIES.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
            <RotateCwIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>动作</TableHead>
              <TableHead>分类</TableHead>
              <TableHead>对象</TableHead>
              <TableHead>操作者</TableHead>
              <TableHead>时间</TableHead>
              <TableHead className="w-[100px]">详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginated.length ? (
              paginated.map((log) => {
                const cat = auditCategory(log.action);
                return (
                  <TableRow key={log.id}>
                    <TableCell>
                      <div className="font-medium">{actionLabel(log.action)}</div>
                      {/* 原 action 码作为副标小字展示，便于精确追溯（中文说明 + 原码双展示）。 */}
                      <div className="font-mono text-xs text-muted-foreground">{log.action}</div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">{categoryLabel(cat)}</span>
                    </TableCell>
                    <TableCell>{targetLabel(log.targetType)}</TableCell>
                    <TableCell>{log.actor?.email || '系统'}</TableCell>
                    <TableCell>{formatTime(log.createdAt)}</TableCell>
                    <TableCell>
                      <AuditDetailDialog log={log}>
                        <Button variant="ghost" size="icon" className="size-8">
                          <EyeIcon className="size-4" />
                        </Button>
                      </AuditDetailDialog>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  {loading ? '加载中…' : error ? `加载失败：${error}` : '暂无审计日志'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination
          totalItems={totalItems}
          pageSize={pageSize}
          currentPage={page}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </Section>
  );
}

function AuditDetailDialog({ log, children }: { log: AuditLog; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const cat = auditCategory(log.action);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>审计详情</DialogTitle>
          <DialogDescription>{actionLabel(log.action)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-1 rounded-xl border bg-muted/20 p-3 text-sm">
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">动作码</span>
              <span className="font-mono text-xs text-foreground">{log.action}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">分类</span>
              <span className="text-foreground">{categoryLabel(cat)}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">说明</span>
              <span className="text-foreground">{actionLabel(log.action)}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">对象</span>
              <span className="text-foreground">{targetLabel(log.targetType)}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">ID</span>
              <span className="font-mono text-xs text-foreground">{log.targetId || '—'}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">操作者</span>
              <span className="text-foreground">
                {log.actor ? `${log.actor.email}${log.actor.displayName ? `（${log.actor.displayName}）` : ''}` : '系统'}
              </span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">时间</span>
              <span className="text-foreground">{formatTime(log.createdAt)}</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">元数据</div>
            <pre className="max-h-60 overflow-auto rounded-xl bg-muted p-3 text-xs text-muted-foreground">
              {JSON.stringify(localizeMetadata(log.metadata), null, 2)}
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
