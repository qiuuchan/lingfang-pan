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
        ? 'bg-[#F7F4EF]/95 px-6 pb-5 pt-2 backdrop-blur'
        : 'border-t border-[#E7E1D7] bg-gradient-to-b from-[#F7F4EF] to-[#FBF9F5] px-6 py-4'),
    )}>
      {selectedFiles.length > 0 && (
        <div className={cn('mx-auto mb-3 max-w-3xl', hero && 'rounded-xl border border-[#E7E1D7] bg-[#FFFFFF]/70 p-3 text-left shadow-lg backdrop-blur')}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-[#5C635D]">已选择 {selectedFiles.length} 个文件</span>
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                className="h-7 gap-1.5 rounded-full bg-[#C4612F] px-3 text-xs shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-[#A94E22] hover:shadow-md"
                onClick={onImportFiles}
                disabled={busy}
              >
                <PackageIcon className="size-3.5" />
                导入为插件
              </Button>
              <Button variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs text-[#5C635D] transition-colors duration-150 hover:bg-[#F2E3D6] hover:text-[#1F2421]" onClick={onClearFiles}>
                清空
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedFiles.map((file) => (
              <Badge key={file.id} variant="secondary" className="gap-1.5 rounded-full border-[#E7E1D7] bg-[#F2E3D6] px-2.5 py-1.5 text-xs text-[#1F2421] shadow-sm">
                <span className="max-w-[200px] truncate" title={file.name}>{file.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(file.id)}
                  className="inline-flex shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[#5C635D]/20"
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
        (hero || embeddedBottom) && 'rounded-xl border border-[#E7E1D7] bg-[#FFFFFF]/90 p-1 shadow-xl backdrop-blur',
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
            className="h-9 w-9 shrink-0 rounded-xl border-[#E7E1D7] text-[#5C635D] shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-[#C4612F]/40 hover:bg-[#F2E3D6] hover:text-[#1F2421] hover:shadow-md"
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
          className={cn(
            'h-9 w-9 shrink-0 rounded-xl shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md',
            thinking ? 'border-[#C4612F] bg-[#C4612F] text-white hover:bg-[#A94E22]' : 'border-[#E7E1D7] text-[#5C635D] hover:border-[#C4612F]/40 hover:bg-[#F2E3D6] hover:text-[#1F2421]',
          )}
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
          className="h-9 w-9 shrink-0 rounded-xl border-[#E7E1D7] text-[#5C635D] shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-[#C4612F]/40 hover:bg-[#F2E3D6] hover:text-[#1F2421] hover:shadow-md"
        >
          <FolderIcon className="size-4" />
        </Button>
        <div className="flex h-9 shrink-0 rounded-xl border border-[#E7E1D7] bg-[#FBF9F5]/70 p-0.5 shadow-sm">
          {(['fast', 'premium'] as const).map((nextTier) => (
            <button
              key={nextTier}
              type="button"
              onClick={() => onSelectTier(nextTier)}
              disabled={busy}
              className={cn(
                'rounded-lg px-2 text-xs font-medium transition-all duration-150 disabled:opacity-50',
                tier === nextTier ? 'bg-[#C4612F] text-white shadow-sm' : 'text-[#5C635D] hover:bg-[#F2E3D6] hover:text-[#1F2421]',
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
            '!min-h-9 max-h-24 resize-none px-3 py-1.5 text-sm shadow-sm transition-all duration-150 focus-visible:shadow-md',
            hero
              ? 'rounded-lg border-0 bg-transparent shadow-none focus-visible:ring-0'
              : embeddedBottom
                ? 'rounded-lg border-0 bg-transparent shadow-none focus-visible:ring-0'
                : 'rounded-xl border-[#E7E1D7]/60',
          )}
          disabled={busy}
        />
        {busy ? (
          <Button variant="outline" size="icon" onClick={onStop} title="停止" className="h-9 w-9 shrink-0 rounded-xl border-[#E7E1D7] text-[#5C635D] shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-destructive hover:text-destructive hover:shadow-md">
            <XIcon className="size-4" />
          </Button>
        ) : (
          <Button size="icon" onClick={onSend} disabled={!input.trim()} title="发送" className="h-9 w-9 shrink-0 rounded-xl bg-[#C4612F] text-white shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:scale-105 hover:bg-[#A94E22] hover:shadow-md disabled:opacity-50">
            <SendIcon className="size-4" />
          </Button>
        )}
      </div>
      {embedded && <CreatorQuickTags className="mx-auto mt-3 max-w-3xl" onSelect={onQuickPrompt} />}
    </div>
  );
}
