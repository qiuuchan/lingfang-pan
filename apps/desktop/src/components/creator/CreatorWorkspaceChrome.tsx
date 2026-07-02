import {
  BookOpenIcon,
  Code2Icon,
  EyeIcon,
  FileCode2Icon,
  HeartIcon,
  HistoryIcon,
  PenLineIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  WandSparklesIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import type { LoadedPlugin } from '@/lib/types';
import { modelTierShortLabel } from '@/lib/model-tier';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type CreatorTier = 'fast' | 'premium';
type CreatorConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

const QUICK_TAGS = [
  { label: 'Code', icon: Code2Icon, prompt: '做一个代码相关的插件，包含清晰的输入、运行结果和错误提示。' },
  { label: 'Learn', icon: BookOpenIcon, prompt: '做一个学习辅助插件，可以拆解知识点、生成练习并追踪学习进度。' },
  { label: 'Create', icon: WandSparklesIcon, prompt: '做一个创作工作流插件，帮助我从想法生成可用的内容或素材。' },
  { label: 'Write', icon: PenLineIcon, prompt: '做一个写作插件，支持润色、改写、摘要和结构化输出。' },
  { label: 'Life stuff', icon: HeartIcon, prompt: '做一个日常生活助手插件，帮助规划、记录或自动化琐事。' },
] as const;

export function CreatorQuickTags({
  className,
  onSelect,
}: {
  className?: string;
  onSelect: (prompt: string) => void;
}) {
  return (
    <div className={cn('flex flex-wrap justify-center gap-2', className)}>
      {QUICK_TAGS.map((tag) => {
        const Icon = tag.icon;
        return (
          <button
            key={tag.label}
            type="button"
            onClick={() => onSelect(tag.prompt)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs font-medium text-muted-foreground shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent hover:text-foreground hover:shadow-md"
          >
            <Icon className="size-3.5" />
            {tag.label}
          </button>
        );
      })}
    </div>
  );
}

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
  compressedHint,
  activeConversationId,
  confirmDeleteId,
  conversations,
  draftName,
  onCancelDeleteConversation,
  onConfirmDeleteConversation,
  onDeleteConversation,
  onNewConversation,
  onOpenSkills,
  onSelectConversation,
  onSelectReferencedPlugin,
  recentPlugins,
  referencedPlugin,
  turnsCount,
}: {
  activeSkillCount: number;
  busy: boolean;
  compressedHint: number;
  activeConversationId: string | null;
  confirmDeleteId: string | null;
  conversations: CreatorConversationSummary[];
  draftName?: string | null;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewConversation: () => void;
  onOpenSkills: () => void;
  onSelectConversation: (id: string) => void;
  onSelectReferencedPlugin: (plugin: LoadedPlugin | null) => void;
  recentPlugins: LoadedPlugin[];
  referencedPlugin: LoadedPlugin | null;
  turnsCount: number;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/40/70 text-foreground backdrop-blur">
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border bg-card/80 shadow-sm">
            <SparklesIcon className="size-4 text-primary" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">开发插件</div>
            <div className="text-[11px] text-muted-foreground">AI plugin builder</div>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <div className="space-y-1.5">
          <Button variant="default" size="sm" className="w-full justify-start gap-2 rounded-xl bg-primary shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-md" disabled={busy} onClick={onNewConversation}>
            <PlusIcon className="size-3.5" />
            新建对话
            {compressedHint > 0 && <Badge variant="outline" className="ml-auto h-4 border-border px-1 text-[10px]">压缩 {compressedHint}</Badge>}
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2 rounded-xl text-muted-foreground transition-all duration-150 hover:-translate-y-0.5 hover:bg-accent hover:text-foreground" onClick={onOpenSkills}>
            <WrenchIcon className="size-3.5" />
            技能
            {activeSkillCount > 0 && <Badge variant="secondary" className="ml-auto h-4 bg-accent px-1 text-[10px] text-primary">{activeSkillCount}</Badge>}
          </Button>
          {recentPlugins.length > 0 && (
            <Popover>
              <PopoverTrigger render={<Button type="button" variant={referencedPlugin ? 'default' : 'ghost'} size="sm" className={cn('w-full justify-start gap-2 rounded-xl transition-all duration-150', referencedPlugin ? 'bg-primary hover:bg-primary/90' : 'text-muted-foreground hover:-translate-y-0.5 hover:bg-accent hover:text-foreground')} />}>
                <FileCode2Icon className="size-3.5" />
                <span className="min-w-0 flex-1 truncate text-left">{referencedPlugin ? referencedPlugin.name : '引用插件'}</span>
              </PopoverTrigger>
              <PopoverContent className="w-64 rounded-xl border-border bg-card shadow-lg" align="start">
                <div className="text-xs font-medium text-muted-foreground">引用已有插件</div>
                <div className="mt-1.5 max-h-60 space-y-0.5 overflow-y-auto">
                  {recentPlugins.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => onSelectReferencedPlugin(referencedPlugin?.id === plugin.id ? null : plugin)}
                      className={cn(
                        'block w-full truncate rounded-xl px-2 py-1.5 text-left text-sm transition-all duration-150',
                        referencedPlugin?.id === plugin.id ? 'bg-accent text-primary' : 'hover:bg-background',
                      )}
                      title={plugin.name}
                    >
                      {plugin.name}
                    </button>
                  ))}
                </div>
                {referencedPlugin && (
                  <button
                    type="button"
                    onClick={() => onSelectReferencedPlugin(null)}
                    className="mt-1.5 w-full rounded-xl px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-background"
                  >
                    取消引用
                  </button>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between px-2 text-[11px] font-medium text-muted-foreground">
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
                    active ? 'border-primary/40 bg-accent text-primary shadow-sm' : 'border-transparent hover:-translate-y-0.5 hover:border-border hover:bg-card hover:shadow-sm',
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
                        className="rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-background"
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
      </div>

      <div className="border-t border-border p-3 text-[11px] text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>{turnsCount > 0 ? `${turnsCount} 条消息` : '新对话'}</span>
          {draftName && <span className="max-w-24 truncate text-foreground" title={draftName}>{draftName}</span>}
        </div>
      </div>
    </aside>
  );
}
