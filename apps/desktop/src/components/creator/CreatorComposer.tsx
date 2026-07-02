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
      {/* Agent 风格输入容器：上方 Textarea（min-h-14 更高）+ 下方工具栏（左：附件/思考/模型，右：发送）。
          参考 ChatGPT/Claude：工具按钮作为 ghost 按钮沉到底部行，输入区占据上方主要空间。 */}
      <div className={cn(
        'mx-auto max-w-3xl rounded-xl border border-border bg-card/90 shadow-lg backdrop-blur',
        hero || embeddedBottom ? 'p-2' : 'p-2',
      )}>
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
        {/* 底部工具栏：左侧操作按钮 + 模型选择，右侧发送/停止。 */}
        <div className="flex items-center justify-between gap-1.5 px-1 pt-1">
          <div className="flex items-center gap-1">
            {showContextButton && (
              <button
                type="button"
                onClick={onOpenContext}
                disabled={busy || !canInspectContext}
                title={canInspectContext ? '打开上下文' : '先发送一次对话再查看上下文'}
                aria-label="上下文"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <EyeIcon className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onToggleThinking}
              disabled={busy}
              title={thinking ? '思考模式已开启（深入推理）' : '开启思考模式'}
              aria-pressed={thinking}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors duration-150 disabled:opacity-40',
                thinking
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <BrainIcon className="size-4" />
              {thinking && <span>思考中</span>}
            </button>
            <button
              type="button"
              onClick={onPickFiles}
              disabled={busy}
              title="选择文件或文件夹"
              aria-label="附件"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <FolderIcon className="size-4" />
            </button>
            {/* 模型切换：胶囊式分段，当前态高亮 primary。 */}
            <div className="ml-0.5 flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
              {(['fast', 'premium'] as const).map((nextTier) => (
                <button
                  key={nextTier}
                  type="button"
                  onClick={() => onSelectTier(nextTier)}
                  disabled={busy}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150 disabled:opacity-50',
                    tier === nextTier ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {modelTierShortLabel(nextTier)}
                </button>
              ))}
            </div>
          </div>
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              title="停止"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border text-muted-foreground shadow-sm transition-colors duration-150 hover:border-destructive hover:bg-destructive hover:text-destructive-foreground"
            >
              <XIcon className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!input.trim()}
              title="发送"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-all duration-150 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SendIcon className="size-4" />
            </button>
          )}
        </div>
      </div>
      {embedded && <CreatorQuickTags className="mx-auto mt-3 max-w-3xl" onSelect={onQuickPrompt} />}
    </div>
  );
}
