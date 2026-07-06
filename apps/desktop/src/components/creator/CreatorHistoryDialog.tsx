// CreatorHistoryDialog.tsx —— 对话历史选择弹窗。
//
// 从 FloatingCreator 抽取（betav2 阶段4c）。展示历史会话列表，分页，支持选择/删除。
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** 历史会话条目（与 FloatingCreator 的 CreatorConversation 兼容）。 */
export interface HistoryConversation {
  id: string;
  title: string;
  updatedAt: string;
}

export interface CreatorHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: HistoryConversation[];
  activeConversationId: string | null;
  /** 当前页（0-based）。 */
  page: number;
  /** 总页数。 */
  pageCount: number;
  /** 待确认删除的会话 id（二次确认）。 */
  confirmDeleteId: string | null;
  /** 选择某会话（传 id，调用方自己定位完整会话）。 */
  onSelect: (id: string) => void;
  onNewConversation: () => void;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onPageChange: (page: number) => void;
}

export const HISTORY_PAGE_SIZE = 6;

export function CreatorHistoryDialog(props: CreatorHistoryDialogProps) {
  const { open, onOpenChange, conversations, activeConversationId, page, pageCount, confirmDeleteId } = props;
  const start = page * HISTORY_PAGE_SIZE;
  const paged = conversations.slice(start, start + HISTORY_PAGE_SIZE);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>对话历史</DialogTitle>
          <DialogDescription>选择历史对话后可继续之前的会话。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">最多保留最近 30 条</div>
          <Button variant="outline" size="sm" onClick={props.onNewConversation}>
            <PlusIcon className="size-3.5" />新建对话
          </Button>
        </div>
        <div className="max-h-[48vh] space-y-1 overflow-y-auto">
          {conversations.length ? paged.map((conversation) => (
            <div
              key={conversation.id}
              className={`group relative flex items-center gap-2 rounded-md border px-3 py-2 transition-colors ${conversation.id === activeConversationId ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'}`}
            >
              <button
                type="button"
                onClick={() => props.onSelect(conversation.id)}
                className="min-w-0 flex-1 text-left"
                title={conversation.title}
              >
                <span className="block truncate text-sm font-medium">{conversation.title}</span>
                <span className="block font-mono text-xs text-muted-foreground">{new Date(conversation.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
              </button>
              {confirmDeleteId === conversation.id ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={(e) => { e.stopPropagation(); props.onConfirmDelete(conversation.id); }}
                  >
                    确认删除
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={(e) => { e.stopPropagation(); props.onCancelDelete(); }}
                  >
                    取消
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  title="删除该对话"
                  onClick={(e) => { e.stopPropagation(); props.onRequestDelete(conversation.id); }}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              )}
            </div>
          )) : <div className="py-8 text-center text-sm text-muted-foreground">暂无历史对话</div>}
        </div>
        {conversations.length > HISTORY_PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={page <= 0}
              onClick={() => props.onPageChange(Math.max(0, page - 1))}
            >
              上一页
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">第 {page + 1} / {pageCount} 页</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={page >= pageCount - 1}
              onClick={() => props.onPageChange(Math.min(pageCount - 1, page + 1))}
            >
              下一页
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
