import { AtSignIcon, BrainIcon, CircleIcon, CrownIcon, FolderIcon, PackageIcon, SendIcon, XIcon, ZapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { LoadedPlugin } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface CreatorSelectedFile {
  id: string;
  name: string;
  file: File;
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
  return (
    <div className={cn(
      hero ? 'w-full' : 'shrink-0',
      !hero && (embeddedBottom
        ? 'bg-background/95 px-6 pb-5 pt-2 backdrop-blur'
        : 'border-t border-border bg-gradient-to-b from-background to-muted/30 px-6 py-4'),
    )}>
      {selectedFiles.length > 0 && (
        <div className={cn('mx-auto mb-3 max-w-3xl', hero && 'rounded-xl border border-border bg-card/70 p-3 text-left shadow-lg backdrop-blur')}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">已选择 {selectedFiles.length} 个文件</span>
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                className="h-7 gap-1.5 rounded-lg px-3 text-xs shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-md"
                onClick={onImportFiles}
                disabled={busy}
              >
                <PackageIcon className="size-3.5" />
                导入为插件
              </Button>
              <Button variant="ghost" size="sm" className="h-7 rounded-lg px-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground" onClick={onClearFiles}>
                清空
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedFiles.map((file) => (
              <Badge key={file.id} variant="secondary" className="gap-1.5 rounded-lg border-border bg-accent px-2.5 py-1.5 text-xs text-foreground shadow-sm">
                <span className="max-w-[200px] truncate" title={file.name}>{file.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(file.id)}
                  className="inline-flex shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted-foreground/20"
                  aria-label="移除"
                >
                  <XIcon className="size-3.5" />
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}
      {/* Agent 风格输入容器：上方 Textarea（min-h-14 更高）+ 下方工具栏。
          左侧：@ 引用插件 / 思考 / 附件；右侧：上下文（圆圈）/ 模型切换 / 发送。 */}
      <div className="mx-auto max-w-3xl rounded-xl border border-border bg-card/90 p-2 shadow-lg backdrop-blur">
        <Textarea
          placeholder={thinking ? '思考模式：描述需求，模型会深入分析后生成…' : '描述插件需求，Enter 发送，Shift+Enter 换行'}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          className="max-h-40 min-h-14 resize-none border-0 bg-transparent px-2.5 py-2 text-sm shadow-none focus-visible:ring-0"
          disabled={busy}
        />
        <div className="flex items-center justify-between gap-1.5 px-1 pt-1">
          {/* 左侧：@ 引用插件 + 思考 + 附件 */}
          <div className="flex items-center gap-1">
            {hasRecentPlugins && (
              <Popover>
                <PopoverTrigger render={
                  <button
                    type="button"
                    title="引用已有插件做修改"
                    className={cn(
                      'inline-flex h-9 items-center gap-1 rounded-xl px-2.5 text-sm font-medium transition-colors duration-150',
                      referencedPlugin
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  />
                }>
                  <AtSignIcon className="size-4" />
                  {referencedPlugin && <span className="max-w-24 truncate text-xs">{referencedPlugin.name}</span>}
                </PopoverTrigger>
                <PopoverContent className="w-64 rounded-xl border-border bg-card shadow-lg" align="start">
                  <div className="text-xs font-medium text-muted-foreground">引用已有插件（注入源码到上下文）</div>
                  <div className="mt-1.5 max-h-60 space-y-0.5 overflow-y-auto">
                    {recentPlugins.map((plugin) => (
                      <button
                        key={plugin.id}
                        type="button"
                        onClick={() => onSelectReferencedPlugin(referencedPlugin?.id === plugin.id ? null : plugin)}
                        className={cn(
                          'block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150',
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
                      className="mt-1.5 w-full rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-background"
                    >
                      取消引用
                    </button>
                  )}
                </PopoverContent>
              </Popover>
            )}
            <button
              type="button"
              onClick={onToggleThinking}
              disabled={busy}
              title={thinking ? '思考模式已开启（深入推理）' : '开启思考模式'}
              aria-pressed={thinking}
              className={cn(
                'inline-flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-150 disabled:opacity-40',
                thinking
                  ? 'bg-primary/10 text-primary shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <BrainIcon className="size-4" />
            </button>
            <button
              type="button"
              onClick={onPickFiles}
              disabled={busy}
              title="选择文件或文件夹"
              aria-label="附件"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <FolderIcon className="size-4" />
            </button>
          </div>
          {/* 右侧：上下文（圆角方形+阴影）/ 模型切换（图标）/ 发送。所有按钮统一 size-9 高度。 */}
          <div className="flex items-center gap-2">
            {showContextButton && (
              <button
                type="button"
                onClick={onOpenContext}
                disabled={busy || !canInspectContext}
                title={canInspectContext ? '打开上下文' : '先发送一次对话再查看上下文'}
                aria-label="上下文"
                className={cn(
                  'inline-flex size-9 shrink-0 items-center justify-center rounded-xl shadow-sm transition-colors duration-150 disabled:opacity-40',
                  canInspectContext
                    ? 'bg-muted text-foreground hover:bg-accent'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                <CircleIcon className="size-4" />
              </button>
            )}
            {/* 模型切换：fast=闪电图标，premium=皇冠图标。 */}
            <div className="flex shrink-0 items-center rounded-xl border border-border bg-muted/40 p-0.5">
              {([
                { tier: 'fast' as const, icon: ZapIcon, label: '快速' },
                { tier: 'premium' as const, icon: CrownIcon, label: '高级' },
              ]).map(({ tier: nextTier, icon: Icon, label }) => (
                <button
                  key={nextTier}
                  type="button"
                  onClick={() => onSelectTier(nextTier)}
                  disabled={busy}
                  title={label}
                  className={cn(
                    'inline-flex size-8 items-center justify-center rounded-lg transition-all duration-150 disabled:opacity-50',
                    tier === nextTier ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
            {busy ? (
              <button
                type="button"
                onClick={onStop}
                title="停止"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground shadow-sm transition-colors duration-150 hover:border-destructive hover:bg-destructive hover:text-destructive-foreground"
              >
                <XIcon className="size-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!input.trim()}
                title="发送"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-all duration-150 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SendIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
