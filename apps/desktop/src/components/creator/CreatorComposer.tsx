import {
  ArrowUpIcon,
  AtSignIcon,
  BrainIcon,
  ChevronDownIcon,
  CircleIcon,
  CrownIcon,
  MicIcon,
  PackageIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { LoadedPlugin } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';

export interface CreatorSelectedFile {
  id: string;
  name: string;
  file: File;
}

function ComposerTagButton({
  active,
  children,
  disabled,
  icon: Icon,
  onClick,
  title,
}: {
  active?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium transition-colors duration-150',
        'text-[#a0a0a3] hover:bg-[#2a2a2c] hover:text-[#e5e5e5] focus-visible:ring-2 focus-visible:ring-[#55565a]',
        'disabled:cursor-not-allowed disabled:text-[#5a5a5c] disabled:opacity-70',
        active && 'bg-[#2a2a2c] text-[#e5e5e5]',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{children}</span>
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
    </button>
  );
}

function ComposerIconButton({
  active,
  children,
  disabled,
  onClick,
  title,
}: {
  active?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[#a0a0a3] transition-colors duration-150',
        'hover:bg-[#2a2a2c] hover:text-[#e5e5e5] focus-visible:ring-2 focus-visible:ring-[#55565a] disabled:cursor-not-allowed disabled:text-[#5a5a5c]',
        active && 'bg-[#2a2a2c] text-[#e5e5e5]',
      )}
    >
      {children}
    </button>
  );
}

export function CreatorComposer({
  busy,
  canInspectContext,
  embedded,
  input,
  onClearFiles,
  onImportFiles,
  onOpenContext,
  onInputChange,
  onPickFiles,
  onRemoveFile,
  onSend,
  onSelectReferencedPlugin,
  onSelectTier,
  onStop,
  onToggleThinking,
  placement,
  recentPlugins,
  showContextButton = false,
  selectedFiles,
  thinking,
  tier,
  referencedPlugin,
}: {
  busy: boolean;
  canInspectContext: boolean;
  embedded: boolean;
  input: string;
  onClearFiles: () => void;
  onImportFiles: () => void;
  onOpenContext: () => void;
  onInputChange: (value: string) => void;
  onPickFiles: () => void;
  onRemoveFile: (id: string) => void;
  onSend: () => void;
  onSelectReferencedPlugin: (plugin: LoadedPlugin | null) => void;
  onSelectTier: (tier: 'fast' | 'premium') => void;
  onStop: () => void;
  onToggleThinking: () => void;
  placement: 'hero' | 'bottom';
  recentPlugins: LoadedPlugin[];
  showContextButton?: boolean;
  selectedFiles: CreatorSelectedFile[];
  thinking: boolean;
  tier: 'fast' | 'premium';
  referencedPlugin: LoadedPlugin | null;
}) {
  const hero = placement === 'hero';
  const embeddedBottom = embedded && !hero;
  const hasRecentPlugins = recentPlugins.length > 0;
  const selectedModelLabel = 'Kimi-K2.7-Code';
  return (
    <div className={cn(
      hero ? 'w-full' : 'shrink-0',
      !hero && (embeddedBottom
        ? 'bg-background px-3 pb-6 pt-3 sm:px-6'
        : 'bg-background px-3 py-4 sm:px-6'),
      )}>
      {selectedFiles.length > 0 && (
        <div className={cn(CREATOR_COLUMN_CLASS, 'mb-3', hero && 'rounded-md border border-border bg-card p-3 text-left shadow-sm')}>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[11px] font-medium text-muted-foreground">{selectedFiles.length} file(s) selected</span>
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                className="h-7 gap-1.5 rounded-md px-3 text-xs transition-colors duration-150 hover:bg-primary/90"
                onClick={onImportFiles}
                disabled={busy}
              >
                <PackageIcon className="size-3.5" />
                导入为插件
              </Button>
              <Button variant="ghost" size="sm" className="h-7 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground" onClick={onClearFiles}>
                清空
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedFiles.map((file) => (
              <Badge key={file.id} variant="secondary" className="gap-1.5 rounded-md border-border bg-muted px-2.5 py-1.5 font-mono text-[11px] text-foreground">
                <span className="max-w-[200px] truncate" title={file.name}>{file.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(file.id)}
                  className="inline-flex shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-muted-foreground/20"
                  aria-label="移除"
                >
                  <XIcon className="size-3.5" />
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}
      <div className={CREATOR_COLUMN_CLASS}>
        <div className="rounded-2xl bg-[#1c1c1e] p-3 shadow-[0_18px_60px_rgba(0,0,0,0.3)] sm:p-4">
        <Textarea
          placeholder="今天帮你做些什么？@ 引用对话文件，/ 调用技能与指令"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          className="max-h-44 min-h-24 resize-none border-0 bg-transparent px-0 py-0 text-base leading-7 text-[#f4f4f5] shadow-none outline-none placeholder:text-[#5a5a5c] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:opacity-60 md:text-sm dark:bg-transparent dark:disabled:bg-transparent"
          disabled={busy}
        />
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ComposerTagButton
              active={thinking}
              disabled={busy}
              icon={BrainIcon}
              onClick={onToggleThinking}
              title={thinking ? 'Plan 已开启' : '开启 Plan'}
            >
              Plan
            </ComposerTagButton>
            <Popover>
              <PopoverTrigger render={
                <button
                  type="button"
                  disabled={busy}
                  title="选择模型档位"
                  className="inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium text-[#a0a0a3] transition-colors duration-150 hover:bg-[#2a2a2c] hover:text-[#e5e5e5] focus-visible:ring-2 focus-visible:ring-[#55565a] disabled:cursor-not-allowed disabled:text-[#5a5a5c]"
                />
              }>
                <span className="inline-flex size-4 shrink-0 items-center justify-center rounded bg-[#2a2a2c] text-[10px] font-semibold text-[#a0a0a3]">K</span>
                <span className="max-w-[8.75rem] truncate">{selectedModelLabel}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </PopoverTrigger>
              <PopoverContent className="w-44 rounded-xl border-[#2a2a2c] bg-[#1c1c1e] p-1 shadow-md" align="start">
                {([
                  { tier: 'fast' as const, icon: ZapIcon, label: '快速' },
                  { tier: 'premium' as const, icon: CrownIcon, label: '高级' },
                ]).map(({ tier: nextTier, icon: Icon, label }) => (
                  <button
                    key={nextTier}
                    type="button"
                    onClick={() => onSelectTier(nextTier)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150',
                      tier === nextTier ? 'bg-[#2a2a2c] text-[#e5e5e5]' : 'text-[#a0a0a3] hover:bg-[#2a2a2c] hover:text-[#e5e5e5]',
                    )}
                  >
                    <Icon className="size-4" />
                    {label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            {hasRecentPlugins ? (
              <Popover>
                <PopoverTrigger render={
                  <button
                    type="button"
                    title="调用技能"
                    className={cn(
                      'inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium transition-colors duration-150',
                      referencedPlugin
                        ? 'bg-[#2a2a2c] text-[#e5e5e5]'
                        : 'text-[#a0a0a3] hover:bg-[#2a2a2c] hover:text-[#e5e5e5]',
                    )}
                  />
                }>
                  <SparklesIcon className="size-4 shrink-0" />
                  <span className="truncate">{referencedPlugin?.name ?? '技能'}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
                </PopoverTrigger>
                <PopoverContent className="w-64 rounded-xl border-[#2a2a2c] bg-[#1c1c1e] shadow-md" align="start">
                  <div className="text-xs font-medium text-[#a0a0a3]">引用已有插件（注入源码到上下文）</div>
                  <div className="mt-1.5 max-h-60 space-y-0.5 overflow-y-auto">
                    {recentPlugins.map((plugin) => (
                      <button
                        key={plugin.id}
                        type="button"
                        onClick={() => onSelectReferencedPlugin(referencedPlugin?.id === plugin.id ? null : plugin)}
                        className={cn(
                          'block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150',
                          referencedPlugin?.id === plugin.id ? 'bg-[#2a2a2c] text-[#e5e5e5]' : 'text-[#a0a0a3] hover:bg-[#2a2a2c] hover:text-[#e5e5e5]',
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
                      className="mt-1.5 w-full rounded-lg px-2 py-1 text-xs text-[#8d8d92] transition-colors duration-150 hover:bg-[#2a2a2c] hover:text-[#e5e5e5]"
                    >
                      取消引用
                    </button>
                  )}
                </PopoverContent>
              </Popover>
            ) : (
              <ComposerTagButton disabled icon={SparklesIcon} title="暂无可调用技能">
                技能
              </ComposerTagButton>
            )}
            <ComposerTagButton
              disabled={busy || !showContextButton || !canInspectContext}
              icon={AtSignIcon}
              onClick={showContextButton && canInspectContext ? onOpenContext : undefined}
              title={canInspectContext ? '连接应用上下文' : '先发送一次对话再连接应用上下文'}
            >
              连应用
            </ComposerTagButton>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-1.5">
            <ComposerIconButton
              disabled={busy || !showContextButton || !canInspectContext}
              onClick={showContextButton && canInspectContext ? onOpenContext : undefined}
              title={canInspectContext ? '打开上下文' : '先发送一次对话再查看上下文'}
            >
              <CircleIcon className="size-5" />
            </ComposerIconButton>
            <ComposerIconButton disabled={busy} onClick={onPickFiles} title="上传附件">
              <PlusIcon className="size-5" />
            </ComposerIconButton>
            <ComposerIconButton active={thinking} disabled={busy} onClick={onToggleThinking} title={thinking ? '关闭提示优化' : '提示词优化'}>
              <SparklesIcon className="size-5" />
            </ComposerIconButton>
            <ComposerIconButton disabled title="语音输入">
              <MicIcon className="size-5" />
            </ComposerIconButton>
            {busy ? (
              <button
                type="button"
                onClick={onStop}
                title="停止"
                aria-label="停止"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[#2a2a2c] text-[#a0a0a3] transition-colors duration-150 hover:bg-[#343437] hover:text-[#e5e5e5] focus-visible:ring-2 focus-visible:ring-[#55565a]"
              >
                <XIcon className="size-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!input.trim()}
                title="发送"
                aria-label="发送"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[#2a2a2c] text-[#a0a0a3] transition-colors duration-150 hover:bg-[#343437] hover:text-[#e5e5e5] focus-visible:ring-2 focus-visible:ring-[#55565a] disabled:cursor-not-allowed disabled:text-[#5a5a5c]"
              >
                <ArrowUpIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-[#5a5a5c]">内容由 AI 生成，请核实重要信息</p>
      </div>
    </div>
  );
}
