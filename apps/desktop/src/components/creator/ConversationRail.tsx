import { useState } from 'react';
import { PlusIcon, MessageSquareIcon, Trash2Icon, PencilIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { deriveTitle, providerLabel, type ConversationMeta } from '@/lib/plugin-draft';
import { parseTimestamp, relativeTime } from '@/lib/time';

// design §3.2.5（历史记录悬浮窗版，问题2）：会话列表内容（列表 / 新建 / 切换 / 删除 / 重命名）。
// 由 PluginCreatorHome 顶部「历史」按钮触发的 Popover 承载，ScrollArea 限高 max-h-[70vh]。
// activeId 高亮，排序按 draftUpdatedAt ?? startedAt 降序。
// 列表项：title（截断 24 字）+ tool Badge + 相对时间；内联重命名输入 + 删除。

interface ConversationRailProps {
  metas: ConversationMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

// 相对时间委托给 lib/time（兼容旧版 epoch.毫秒Z 时间戳，Task 4a 修复）。无值/无法解析返回空串。
function displayRelativeTime(iso?: string | null): string {
  if (!iso) return '';
  return parseTimestamp(iso) ? relativeTime(iso, '') : '';
}

// 排序键：draftUpdatedAt ?? startedAt → epoch 毫秒。兼容旧格式，无法解析回退 0（排到末尾）。
function sortKey(iso: string | undefined): number {
  const d = parseTimestamp(iso);
  return d ? d.getTime() : 0;
}

export function ConversationRail({ metas, activeId, onSelect, onNew, onRename, onDelete }: ConversationRailProps) {
  // 正在重命名的会话 id + 输入值（受控）。完成时 onRename 持久化并清空。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // 分页：每页 5 条，底部分页器切换（用户要求"五个一页 + 底部选择页面按钮"）。
  const PAGE_SIZE = 5;
  const [page, setPage] = useState(0);

  // 排序：draftUpdatedAt ?? startedAt 降序（最近更新在前，空态新对话次之）。
  const sorted = [...metas].sort((a, b) => sortKey(b.draftUpdatedAt || b.startedAt) - sortKey(a.draftUpdatedAt || a.startedAt));
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  // 当前页超出范围时收敛（会话删除/新增导致页数变化）。
  const safePage = Math.min(page, totalPages - 1);
  const paged = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  function startRename(meta: ConversationMeta) {
    setRenamingId(meta.sessionId);
    setRenameValue(meta.title || deriveTitle(meta));
  }

  function commitRename() {
    if (renamingId) {
      const title = renameValue.trim();
      if (title) onRename(renamingId, title);
    }
    setRenamingId(null);
    setRenameValue('');
  }

  return (
    <div className="flex w-full flex-col">
      {/* 顶部：标题 + 新建按钮 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2.5">
        <span className="text-sm font-medium">历史对话</span>
        <Button variant="ghost" size="sm" onClick={onNew} className="gap-1">
          <PlusIcon className="size-3.5" />新对话
        </Button>
      </div>
      {/* 会话列表：分页（每页 5 条），单页无需滚动。 */}
      <div className="p-2">
          {sorted.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">还没有对话，点击上方「新对话」开始。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {paged.map((meta) => {
                const active = meta.sessionId === activeId;
                const title = deriveTitle(meta);
                return (
                  <li key={meta.sessionId}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => renamingId === meta.sessionId ? undefined : onSelect(meta.sessionId)}
                      onKeyDown={(e) => {
                        if (renamingId !== meta.sessionId && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          onSelect(meta.sessionId);
                        }
                      }}
                      className={cn(
                        'group flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                        active
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                          : 'border-border bg-card hover:border-primary/40 hover:bg-accent/40',
                      )}
                    >
                      {/* 重命名态：整行变输入框；正常态：图标+标题 | tool+时间 | 操作（单行紧凑） */}
                      {renamingId === meta.sessionId ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                            if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                          }}
                          className="w-full rounded border bg-background px-1.5 py-0.5 text-sm text-foreground outline-none"
                        />
                      ) : (
                        <>
                          <MessageSquareIcon className={cn('size-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                          <span className={cn('min-w-0 flex-1 truncate font-medium', active ? 'text-primary' : 'text-foreground')}>
                            {title}
                          </span>
                          <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal text-muted-foreground">
                            {providerLabel(meta.tool)}
                          </Badge>
                          <span className="w-16 shrink-0 text-right text-[10px] text-muted-foreground">
                            {displayRelativeTime(meta.draftUpdatedAt || meta.startedAt)}
                          </span>
                          {/* 悬浮操作：重命名 / 删除（active 态常驻可见） */}
                          <div className={cn('flex shrink-0 items-center gap-0.5', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={(e) => { e.stopPropagation(); startRename(meta); }}
                              title="重命名"
                            >
                              <PencilIcon className="size-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="hover:text-destructive"
                              onClick={(e) => { e.stopPropagation(); onDelete(meta.sessionId); }}
                              title="删除"
                            >
                              <Trash2Icon className="size-3" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
      {/* 底部分页器：上一页 / 页码 / 下一页（仅多页时显示）。 */}
      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-1 border-t px-3 py-2">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            title="上一页"
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
          {Array.from({ length: totalPages }, (_, i) => (
            <Button
              key={i}
              variant={i === safePage ? 'default' : 'ghost'}
              size="icon-xs"
              className="h-6 w-6 text-xs"
              onClick={() => setPage(i)}
            >
              {i + 1}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            title="下一页"
          >
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
