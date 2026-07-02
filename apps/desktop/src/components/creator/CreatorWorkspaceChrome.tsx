import {
  EyeIcon,
  FileCode2Icon,
  HistoryIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
  ChevronDownIcon,
  UserRoundIcon,
} from 'lucide-react';
import type { LoadedPlugin } from '@/lib/types';
import { modelTierShortLabel } from '@/lib/model-tier';
import { useApp } from '@/App';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type CreatorTier = 'fast' | 'premium';
type CreatorConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

const ROLE_LABEL: Record<string, string> = {
  TEAM_ADMIN: '团队管理员',
  MEMBER: '成员',
};

export function CreatorFloatingTitleBar({
  activeSkillCount,
  busy,
  canInspectContext,
  compressedHint,
  onClose,
  onNewConversation,
  onOpenContext,
  onOpenHistory,
  onOpenSkills,
  onSelectReferencedPlugin,
  onSelectTier,
  recentPlugins,
  referencedPlugin,
  tier,
  turnsCount,
}: {
  activeSkillCount: number;
  busy: boolean;
  canInspectContext: boolean;
  compressedHint: number;
  onClose: () => void;
  onNewConversation: () => void;
  onOpenContext: () => void;
  onOpenHistory: () => void;
  onOpenSkills: () => void;
  onSelectReferencedPlugin: (plugin: LoadedPlugin | null) => void;
  onSelectTier: (tier: CreatorTier) => void;
  recentPlugins: LoadedPlugin[];
  referencedPlugin: LoadedPlugin | null;
  tier: CreatorTier;
  turnsCount: number;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
      <div className="flex items-center gap-2">
        <SparklesIcon className="size-4 text-primary" />
        <span className="text-sm font-medium">AI 创建插件</span>
      </div>
      <div className="flex items-center gap-2">
        {compressedHint > 0 && (
          <Badge variant="outline" className="gap-1 text-xs" title="早期对话已自动摘要为上下文，控制 token">
            已压缩 {compressedHint} 轮
          </Badge>
        )}
        {turnsCount > 0 && (
          <Button variant="outline" size="sm" className="gap-1.5" title="新建对话" onClick={onNewConversation}>
            <PlusIcon className="size-3.5" />
            新建对话
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          title={canInspectContext ? '打开上下文窗口' : '先发送一次对话再查看上下文'}
          onClick={onOpenContext}
          disabled={!canInspectContext}
        >
          <EyeIcon className="size-3.5" />
          上下文
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" title="对话历史" onClick={onOpenHistory}>
          <HistoryIcon className="size-3.5" />
          历史
        </Button>
        {recentPlugins.length > 0 && (
          <Popover>
            <PopoverTrigger render={<Button variant={referencedPlugin ? 'default' : 'outline'} size="sm" className="gap-1.5" title="引用已有插件做修改" />}>
              <FileCode2Icon className="size-3.5" />
              {referencedPlugin ? referencedPlugin.name.slice(0, 8) : '引用插件'}
            </PopoverTrigger>
            <PopoverContent className="w-64" align="end">
              <div className="text-xs font-medium text-muted-foreground">引用已有插件（注入源码到上下文）</div>
              <div className="mt-1.5 max-h-60 space-y-0.5 overflow-y-auto">
                {recentPlugins.map((plugin) => (
                  <button
                    key={plugin.id}
                    type="button"
                    onClick={() => onSelectReferencedPlugin(referencedPlugin?.id === plugin.id ? null : plugin)}
                    className={cn(
                      'block w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      referencedPlugin?.id === plugin.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                    )}
                    title={plugin.name}
                  >
                    {plugin.name}
                  </button>
                ))}
              </div>
              {referencedPlugin && (
                <button type="button" onClick={() => onSelectReferencedPlugin(null)} className="mt-1.5 w-full rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
                  取消引用
                </button>
              )}
            </PopoverContent>
          </Popover>
        )}
        <Button variant="outline" size="sm" className="gap-1.5" title="技能" onClick={onOpenSkills}>
          <WrenchIcon className="size-3.5" />
          技能
          {activeSkillCount > 0 && <Badge variant="secondary" className="h-4 px-1 text-[10px]">{activeSkillCount}</Badge>}
        </Button>
        <div className="flex rounded-md border p-0.5">
          {(['fast', 'premium'] as const).map((nextTier) => (
            <button
              key={nextTier}
              type="button"
              onClick={() => onSelectTier(nextTier)}
              disabled={busy}
              className={cn(
                'rounded px-2 py-0.5 text-xs transition-colors',
                tier === nextTier ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {modelTierShortLabel(nextTier)}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function CreatorWorkspaceSidebar({
  activeSkillCount,
  busy,
  collapsed,
  compressedHint,
  activeConversationId,
  confirmDeleteId,
  conversations,
  onCancelDeleteConversation,
  onConfirmDeleteConversation,
  onDeleteConversation,
  onNewConversation,
  onOpenSkills,
  onSelectConversation,
}: {
  activeSkillCount: number;
  busy: boolean;
  collapsed: boolean;
  compressedHint: number;
  activeConversationId: string | null;
  confirmDeleteId: string | null;
  conversations: CreatorConversationSummary[];
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewConversation: () => void;
  onOpenSkills: () => void;
  onSelectConversation: (id: string) => void;
}) {
  const { session, openAvatarMenu } = useApp();
  const tenantLabel = session.tenantName || (session.tenantId ? `团队 ${session.tenantId.slice(0, 8)}…` : '未加入团队');
  const roleLabel = session.role ? (ROLE_LABEL[session.role] || session.role) : '已登录';

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-r bg-card transition-[width] duration-200"
      style={{ width: collapsed ? 56 : 224 }}
    >
      {/* 顶部操作：新建对话 + 技能。折叠态居中仅显图标。 */}
      <div className="space-y-1.5 border-b p-2">
        <Button
          variant="default"
          size="sm"
          className={cn(
            'h-10 gap-2 rounded-xl bg-primary text-sm shadow-sm transition-all duration-150 hover:bg-primary/90',
            collapsed ? 'w-full justify-center px-0' : 'w-full justify-start px-3',
          )}
          disabled={busy}
          onClick={onNewConversation}
          title={collapsed ? '新建对话' : undefined}
        >
          <PlusIcon className="size-4 shrink-0" />
          {!collapsed && (
            <>
              新建对话
              {compressedHint > 0 && <Badge variant="outline" className="ml-auto h-5 border-border px-1.5 text-[10px]">压缩 {compressedHint}</Badge>}
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-10 gap-2 rounded-xl text-sm text-muted-foreground transition-all duration-150 hover:bg-accent hover:text-foreground',
            collapsed ? 'w-full justify-center px-0' : 'w-full justify-start px-3',
          )}
          onClick={onOpenSkills}
          title={collapsed ? '技能' : undefined}
        >
          <WrenchIcon className="size-4 shrink-0" />
          {!collapsed && (
            <>
              技能
              {activeSkillCount > 0 && <Badge variant="secondary" className="ml-auto h-5 bg-accent px-1.5 text-[10px] text-primary">{activeSkillCount}</Badge>}
            </>
          )}
        </Button>
      </div>

      {/* 历史列表（仅展开态渲染；折叠态留空撑高）。 */}
      {!collapsed ? (
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          <div className="flex items-center justify-between px-1 text-[11px] font-medium text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <HistoryIcon className="size-3.5" />
              历史
            </span>
            {conversations.length > 0 && <Badge variant="secondary" className="h-4 bg-accent px-1 text-[10px] text-primary">{conversations.length}</Badge>}
          </div>
          <div className="space-y-1">
            {conversations.length ? conversations.slice(0, 12).map((conversation) => {
              const active = conversation.id === activeConversationId;
              const confirming = confirmDeleteId === conversation.id;
              return (
                <div
                  key={conversation.id}
                  className={cn(
                    'group flex items-center gap-1 rounded-xl border px-2 py-1.5 transition-all duration-150',
                    active ? 'border-primary/40 bg-accent text-primary shadow-sm' : 'border-transparent hover:border-border hover:bg-muted',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelectConversation(conversation.id)}
                    title={conversation.title}
                  >
                    <span className="block truncate text-xs font-medium">{conversation.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {new Date(conversation.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                    </span>
                  </button>
                  {confirming ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className="rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground shadow-sm"
                        onClick={() => onConfirmDeleteConversation(conversation.id)}
                      >
                        删
                      </button>
                      <button
                        type="button"
                        className="rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                        onClick={onCancelDeleteConversation}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      title="删除该对话"
                      onClick={() => onDeleteConversation(conversation.id)}
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  )}
                </div>
              );
            }) : (
              <div className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                暂无历史对话
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* 底部用户按钮：与主侧栏共用样式，点击唤起 AvatarMenu。 */}
      <div className="border-t p-2">
        <button
          type="button"
          onClick={openAvatarMenu}
          title={collapsed ? tenantLabel : undefined}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-auto w-full gap-2 px-2 py-2', collapsed && 'justify-center px-0')}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRoundIcon className="size-4" />
          </span>
          {!collapsed && (
            <span className="flex-1 truncate text-left text-xs">
              <span className="block truncate font-medium text-foreground">{tenantLabel}</span>
              <span className="block truncate text-muted-foreground">{roleLabel}</span>
            </span>
          )}
          {!collapsed && <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />}
        </button>
      </div>
    </aside>
  );
}
