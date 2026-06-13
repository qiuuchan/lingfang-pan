import { useState } from 'react';
import { PlusIcon, MessageSquareIcon, Trash2Icon, PencilIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { deriveTitle, providerLabel, type ConversationMeta } from '@/lib/plugin-draft';

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

// 相对时间简表（够用于会话栏展示，无需重量级库）。返回「刚刚/N分钟前/N小时前/N天前/日期」。
function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function ConversationRail({ metas, activeId, onSelect, onNew, onRename, onDelete }: ConversationRailProps) {
  // 正在重命名的会话 id + 输入值（受控）。完成时 onRename 持久化并清空。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // 排序：draftUpdatedAt ?? startedAt 降序（最近更新在前，空态新对话次之）。
  const sorted = [...metas].sort((a, b) => {
    const ta = new Date(a.draftUpdatedAt || a.startedAt).getTime();
    const tb = new Date(b.draftUpdatedAt || b.startedAt).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

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
      {/* 会话列表：ScrollArea 限高，内容多时可滚动（问题1：历史记录悬浮窗内部可滚动）。 */}
      <ScrollArea className="max-h-[60vh]">
        <div className="p-2">
          {sorted.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">还没有对话，点击上方「新对话」开始。</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sorted.map((meta) => {
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
                        'group flex cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 text-sm transition-colors',
                        active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                      )}
                    >
                      {/* 标题行（或重命名输入框） */}
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
                        <div className="flex items-center gap-2">
                          <MessageSquareIcon className="size-3.5 shrink-0 opacity-70" />
                          <span className={cn('truncate', active ? 'text-primary-foreground' : 'text-foreground')}>
                            {title.length > 24 ? `${title.slice(0, 24)}…` : title}
                          </span>
                        </div>
                      )}
                      {/* 元信息行：tool Badge + 相对时间 */}
                      <div className="flex items-center justify-between gap-2 pl-5">
                        <Badge
                          variant={active ? 'outline' : 'secondary'}
                          className={cn('h-4 px-1.5 text-[10px] font-normal', active && 'border-primary-foreground/40 text-primary-foreground')}
                        >
                          {providerLabel(meta.tool)}
                        </Badge>
                        <span className={cn('text-[10px]', active ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                          {relativeTime(meta.draftUpdatedAt || meta.startedAt)}
                        </span>
                      </div>
                      {/* 悬浮操作：重命名 / 删除（active 态常驻可见） */}
                      {renamingId !== meta.sessionId && (
                        <div className={cn('flex items-center gap-1 pl-5', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={cn(active ? 'hover:bg-primary-foreground/15' : '')}
                            onClick={(e) => { e.stopPropagation(); startRename(meta); }}
                            title="重命名"
                          >
                            <PencilIcon className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={cn(active ? 'hover:bg-primary-foreground/15' : 'hover:text-destructive')}
                            onClick={(e) => { e.stopPropagation(); onDelete(meta.sessionId); }}
                            title="删除"
                          >
                            <Trash2Icon className="size-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
