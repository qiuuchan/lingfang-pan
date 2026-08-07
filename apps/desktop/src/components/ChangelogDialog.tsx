// ChangelogDialog.tsx — 更新日志悬浮窗（shadcn Dialog + react-markdown 渲染）。
//
// 需求：桌面应用内查看版本更新日志，悬浮窗形态（不跳独立页），markdown 美化显示。
//
// 渲染栈：react-markdown + remark-gfm（GFM 任务列表 - [ ]/- [x]、表格、删除线）+
// rehype-highlight + highlight.js（代码块语法高亮）。桌面端已装全套，比手写正则更强。
//
// 布局：左侧版本快速跳转目录（点击锚定）+ 右侧版本时间线（react-markdown 渲染 notes）。
// 顶部降级横幅（degraded=true 时显示，不阻断展示）。加载骨架 / 空态友好降级。

import { useEffect, useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { DownloadIcon, SparklesIcon, ChevronRightIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadingButton } from '@/components/loading-button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { listChangelog, formatDate, type ChangelogEntry } from '@/lib/changelog';
import { dragRegionProps } from '@/lib/window-drag';
import { cn } from '@/lib/utils';

// highlight.js 暗色主题（代码块语法高亮配色）。导入即注入全局 CSS。
import 'highlight.js/styles/github-dark.css';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export function ChangelogDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [releases, setReleases] = useState<ChangelogEntry[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [degradedMessage, setDegradedMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [activeId, setActiveId] = useState<string | null>(null);
  // 每个 release 的滚动容器 ref（点击目录项时 scrollIntoView 定位）。
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 打开时拉取（仅首次打开或刷新时；已加载不重复拉，减少后端 Gitee API 压力）。
  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const resp = await listChangelog();
      setReleases(resp.releases);
      setDegraded(resp.degraded);
      setDegradedMessage(resp.degraded ? (resp.message ?? null) : null);
      if (resp.releases.length > 0) setActiveId(resp.releases[0].id);
      setStatus('ready');
    } catch (e) {
      setStatus('error');
      toast.error('加载更新日志失败', { description: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    if (open && status === 'idle') void load();
  }, [open, status, load]);

  // 点击目录项定位到对应版本（scrollIntoView 平滑滚动）。
  const jumpTo = useCallback((id: string) => {
    setActiveId(id);
    const el = itemRefs.current.get(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-[94vw] max-w-5xl flex-col gap-0 p-0 sm:max-w-5xl">
        {/* 标题栏（可拖拽窗口）。
            刷新按钮放左侧标题旁——右上角的关闭按钮（DialogContent 自带 absolute right-2）
            与刷新分列两侧，避免挤在一起。 */}
        <div
          {...dragRegionProps}
          className="flex shrink-0 items-center justify-between border-b pl-5 pr-12 py-3.5"
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2.5">
              <SparklesIcon className="size-4 text-primary" />
              <DialogTitle className="text-base" data-tauri-drag-region>
                更新日志
              </DialogTitle>
            </div>
            <DialogDescription className="sr-only">查看 灵坊 各版本的变更说明</DialogDescription>
            <LoadingButton
              variant="ghost"
              size="sm"
              loading={status === 'loading'}
              onClick={load}
              className="h-7 px-2 text-xs"
            >
              刷新
            </LoadingButton>
          </div>
        </div>

        {/* 降级横幅 */}
        {status === 'ready' && degraded && degradedMessage && (
          <Alert className="shrink-0 rounded-none border-x-0 border-t-0 border-b bg-warning/10 px-5 py-2 text-warning">
            <AlertDescription className="text-xs text-current">{degradedMessage}</AlertDescription>
          </Alert>
        )}

        {/* 主体：左侧目录 + 右侧时间线 */}
        <div className="flex min-h-0 flex-1">
          {/* 左侧：版本快速跳转目录（release ≥ 2 时才显示，避免单版本浪费空间） */}
          {status === 'ready' && releases.length >= 2 && (
            <aside className="hidden w-48 shrink-0 border-r bg-muted/30 sm:block">
              <ScrollArea className="h-full">
                <nav className="flex flex-col gap-0.5 p-2">
                  <span className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    版本历史
                  </span>
                  {releases.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => jumpTo(r.id)}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        activeId === r.id
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                    >
                      <span className="font-mono">v{r.version}</span>
                      {r.isLatest && (
                        <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                          最新
                        </Badge>
                      )}
                    </button>
                  ))}
                </nav>
              </ScrollArea>
            </aside>
          )}

          {/* 右侧：版本时间线 */}
          <div className="min-h-0 flex-1">
            {status === 'loading' ? (
              <div className="flex flex-col gap-3 p-5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
              </div>
            ) : status === 'error' ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
                <p>加载失败</p>
                <Button variant="outline" size="sm" onClick={load}>
                  重试
                </Button>
              </div>
            ) : releases.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                <DownloadIcon className="size-8 text-muted-foreground/40" />
                <span>暂无更新日志</span>
                <span className="text-xs">
                  平台管理员配置 Gitee 更新日志源后，此处自动展示版本时间线。
                </span>
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-5 p-5">
                  {releases.map((release) => (
                    <div
                      key={release.id}
                      ref={(el) => {
                        if (el) itemRefs.current.set(release.id, el);
                        else itemRefs.current.delete(release.id);
                      }}
                      className="scroll-mt-5 rounded-lg border bg-card"
                    >
                      {/* 版本头 */}
                      <div className="flex items-center gap-3 border-b px-4 py-3">
                        <Badge
                          variant={release.isLatest ? 'default' : 'secondary'}
                          className="font-mono"
                        >
                          v{release.version}
                        </Badge>
                        {release.title && (
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {release.title}
                          </span>
                        )}
                        {release.publishedAt && (
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {formatDate(release.publishedAt)}
                          </span>
                        )}
                        {release.isLatest && (
                          <Badge variant="outline" className="shrink-0 text-success">
                            最新
                          </Badge>
                        )}
                      </div>
                      {/* notes markdown 渲染 */}
                      <div className="changelog-md px-4 py-3">
                        {release.notes && release.notes.trim() ? (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeHighlight]}
                          >
                            {release.notes}
                          </ReactMarkdown>
                        ) : (
                          <p className="font-mono text-xs text-muted-foreground/60">
                            // 本版本无更新说明
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
