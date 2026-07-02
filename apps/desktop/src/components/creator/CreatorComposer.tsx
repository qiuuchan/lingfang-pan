import { BrainIcon, EyeIcon, FolderIcon, PackageIcon, SendIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { CreatorQuickTags } from '@/components/creator/CreatorWorkspaceChrome';
import { modelTierShortLabel } from '@/lib/model-tier';
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
  onQuickPrompt,
  onRemoveFile,
  onSend,
  onSelectTier,
  onStop,
  onToggleThinking,
  placement,
  showContextButton = false,
  selectedFiles,
  thinking,
  tier,
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
  onQuickPrompt: (prompt: string) => void;
  onRemoveFile: (id: string) => void;
  onSend: () => void;
  onSelectTier: (tier: 'fast' | 'premium') => void;
  onStop: () => void;
  onToggleThinking: () => void;
  placement: 'hero' | 'bottom';
  showContextButton?: boolean;
  selectedFiles: CreatorSelectedFile[];
  thinking: boolean;
  tier: 'fast' | 'premium';
}) {
  const hero = placement === 'hero';
  const embeddedBottom = embedded && !hero;
  return (
    <div className={cn(
      hero ? 'w-full' : 'shrink-0',
      !hero && (embeddedBottom
        ? 'bg-background/95 px-6 pb-5 pt-2'
        : 'border-t bg-gradient-to-b from-background to-muted/20 px-6 py-4'),
    )}>
      {selectedFiles.length > 0 && (
        <div className={cn('mx-auto mb-3 max-w-3xl', hero && 'rounded-xl border bg-card/70 p-3 text-left shadow-lg')}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">已选择 {selectedFiles.length} 个文件</span>
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                className="h-7 gap-1.5 px-3 text-xs shadow-sm"
                onClick={onImportFiles}
                disabled={busy}
              >
                <PackageIcon className="size-3.5" />
                导入为插件
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onClearFiles}>
                清空
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedFiles.map((file) => (
              <Badge key={file.id} variant="secondary" className="gap-1.5 px-2.5 py-1.5 text-xs shadow-sm">
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
      <div className={cn(
        'mx-auto flex max-w-3xl items-end gap-1.5',
        (hero || embeddedBottom) && 'rounded-xl border bg-card/90 p-1 shadow-xl shadow-black/20',
      )}>
        {showContextButton && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onOpenContext}
            disabled={busy || !canInspectContext}
            title={canInspectContext ? '打开上下文' : '先发送一次对话再查看上下文'}
            aria-label="上下文"
            className="h-9 w-9 shrink-0 shadow-sm transition-all hover:scale-105"
          >
            <EyeIcon className="size-4" />
          </Button>
        )}
        <Button
          type="button"
          variant={thinking ? 'default' : 'outline'}
          size="icon"
          onClick={onToggleThinking}
          disabled={busy}
          title={thinking ? '思考模式已开启（深入推理）' : '开启思考模式'}
          className="h-9 w-9 shrink-0 shadow-sm transition-all hover:scale-105"
        >
          <BrainIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onPickFiles}
          disabled={busy}
          title="选择文件或文件夹"
          className="h-9 w-9 shrink-0 shadow-sm transition-all hover:scale-105"
        >
          <FolderIcon className="size-4" />
        </Button>
        <div className="flex h-9 shrink-0 rounded-lg border bg-background/70 p-0.5">
          {(['fast', 'premium'] as const).map((nextTier) => (
            <button
              key={nextTier}
              type="button"
              onClick={() => onSelectTier(nextTier)}
              disabled={busy}
              className={cn(
                'rounded-md px-2 text-xs font-medium transition-colors disabled:opacity-50',
                tier === nextTier ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {modelTierShortLabel(nextTier)}
            </button>
          ))}
        </div>
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
          className={cn(
            '!min-h-9 max-h-24 resize-none px-3 py-1.5 text-sm shadow-sm transition-all focus-visible:shadow-md',
            hero
              ? 'rounded-lg border-0 bg-transparent shadow-none focus-visible:ring-0'
              : embeddedBottom
                ? 'rounded-lg border-0 bg-transparent shadow-none focus-visible:ring-0'
                : 'rounded-xl border-border/60',
          )}
          disabled={busy}
        />
        {busy ? (
          <Button variant="outline" size="icon" onClick={onStop} title="停止" className="h-9 w-9 shrink-0 shadow-sm transition-all hover:scale-105 hover:border-destructive hover:text-destructive">
            <XIcon className="size-4" />
          </Button>
        ) : (
          <Button size="icon" onClick={onSend} disabled={!input.trim()} title="发送" className="h-9 w-9 shrink-0 shadow-sm transition-all hover:scale-105 disabled:opacity-50">
            <SendIcon className="size-4" />
          </Button>
        )}
      </div>
      {embedded && <CreatorQuickTags className="mx-auto mt-3 max-w-3xl" onSelect={onQuickPrompt} />}
    </div>
  );
}
