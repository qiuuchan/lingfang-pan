import {
  HistoryIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type CreatorConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export function CreatorWorkspaceSidebar({
  activeConversationId,
  busy,
  collapsed,
  confirmDeleteId,
  conversations,
  onCancelDeleteConversation,
  onConfirmDeleteConversation,
  onDeleteConversation,
  onNewConversation,
  onSelectConversation,
  onToggleCollapsed,
}: {
  activeConversationId: string | null;
  busy: boolean;
  collapsed: boolean;
  confirmDeleteId: string | null;
  conversations: CreatorConversationSummary[];
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border/70 bg-card/55 transition-[width] duration-200"
      style={{ width: collapsed ? 60 : 240 }}
    >
      <div className="border-b border-border/70 p-2">
        <div
          className={cn(
            'mb-2 flex h-9 items-center gap-2',
            collapsed ? 'justify-center' : 'justify-between pl-2'
          )}
        >
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">插件 Agent</span>
              <span className="block text-[10px] text-muted-foreground">创建工作区</span>
            </span>
          )}
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? '展开创建器侧边栏' : '收起创建器侧边栏'}
            title={collapsed ? '展开创建器侧边栏' : '收起创建器侧边栏'}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {collapsed ? (
              <PanelLeftOpenIcon className="size-4" />
            ) : (
              <PanelLeftCloseIcon className="size-4" />
            )}
          </button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-9 gap-2 rounded-md border-border/80 bg-background/60 text-sm shadow-none hover:bg-accent',
            collapsed ? 'w-full justify-center px-0' : 'w-full justify-start px-3'
          )}
          disabled={busy}
          onClick={onNewConversation}
          title={collapsed ? '新建会话' : undefined}
        >
          <PlusIcon className="size-4 shrink-0" />
          {!collapsed && '新建会话'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!collapsed && (
          <div className="mb-1.5 flex h-7 items-center justify-between px-2 text-[11px] font-medium text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <HistoryIcon className="size-3.5" />
              会话
            </span>
            {conversations.length > 0 && (
              <Badge
                variant="secondary"
                className="h-5 min-w-5 justify-center rounded-md px-1.5 text-[10px]"
              >
                {conversations.length}
              </Badge>
            )}
          </div>
        )}

        <div className="space-y-0.5">
          {conversations.length > 0
            ? conversations.slice(0, collapsed ? 10 : 20).map((conversation) => {
                const active = conversation.id === activeConversationId;
                const confirming = !collapsed && confirmDeleteId === conversation.id;

                if (collapsed) {
                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      disabled={busy}
                      onClick={() => onSelectConversation(conversation.id)}
                      title={conversation.title}
                      className={cn(
                        'mx-auto flex size-9 items-center justify-center rounded-md text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-45',
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      {conversation.title.trim().charAt(0) || '?'}
                    </button>
                  );
                }

                return (
                  <div
                    key={conversation.id}
                    className={cn(
                      'group flex min-h-11 items-center gap-1 rounded-md px-2 transition-colors',
                      active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                    )}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      className="min-w-0 flex-1 py-1.5 text-left disabled:cursor-not-allowed"
                      onClick={() => onSelectConversation(conversation.id)}
                      title={conversation.title}
                    >
                      <span className="block truncate text-xs font-medium text-foreground">
                        {conversation.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {new Date(conversation.updatedAt).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })}
                      </span>
                    </button>
                    {confirming ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded-sm bg-destructive px-1.5 py-1 text-[10px] font-medium text-destructive-foreground disabled:opacity-45"
                          onClick={() => onConfirmDeleteConversation(conversation.id)}
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          className="rounded-sm px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted"
                          onClick={onCancelDeleteConversation}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        title="删除会话"
                        aria-label="删除会话"
                        onClick={() => onDeleteConversation(conversation.id)}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-0 group-hover:opacity-100"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    )}
                  </div>
                );
              })
            : !collapsed && (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  还没有历史会话
                </div>
              )}
        </div>
      </div>
    </aside>
  );
}
