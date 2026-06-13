import { useState } from 'react';
import { RefreshCwIcon, CodeIcon, EyeIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { parseManifest, previewSrcDoc } from '@/lib/plugin-draft';
import type { ScriptRuntime } from '@/lib/plugin-script';
import type { DraftFile } from '@/lib/types';
import { ScriptPreviewPanel } from './panels/ScriptPreviewPanel';
import { SourcePanel } from './panels/SourcePanel';

// 全屏预览大窗（顶部「预览」按钮触发）：铺满整个视口，预览主体撑满可滚动。
// 左侧预览（client→iframe 撑满 / nodejs-python→ScriptPreviewPanel），右侧可收起的源码面板（多文件切换）。
// 预览内容（iframe 内的插件自身）由插件 CSS 决定是否滚动；iframe 容器本身铺满。

interface PreviewDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: DraftFile[];
  activeFile: string;
  activeContent: string;
  previewKey: number;
  onActiveFileChange: (value: string) => void;
  onRefreshPreview: () => void;
}

function isScriptRuntime(runtime: string): runtime is ScriptRuntime {
  return runtime === 'nodejs' || runtime === 'python';
}

export function PreviewDrawer({
  open,
  onOpenChange,
  files,
  activeFile,
  activeContent,
  previewKey,
  onActiveFileChange,
  onRefreshPreview,
}: PreviewDrawerProps) {
  const runtime = parseManifest(files).runtime_type;
  const [showSource, setShowSource] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[100vh] w-[100vw] max-w-none gap-0 rounded-none border-0 p-0 sm:max-w-none">
        {/* 顶部条：标题 + 刷新 + 源码切换 */}
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <DialogTitle className="text-sm font-medium">插件预览</DialogTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={!files.length} onClick={onRefreshPreview}>
              <RefreshCwIcon className="size-4" /> 刷新
            </Button>
            <Button variant={showSource ? 'default' : 'outline'} size="sm" disabled={!files.length} onClick={() => setShowSource((v) => !v)}>
              <CodeIcon className="size-4" /> 源码
            </Button>
          </div>
        </div>
        {/* 主体：预览撑满 + 可选源码侧栏 */}
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 flex-1 overflow-auto bg-muted/30">
            {files.length ? (
              isScriptRuntime(runtime) ? (
                <div className="h-full p-4"><ScriptPreviewPanel files={files} runtime={runtime} previewKey={previewKey} onRefresh={onRefreshPreview} /></div>
              ) : (
                // client runtime：iframe absolute 撑满父容器，插件自身内容由其 CSS 滚动
                <iframe key={previewKey} title="plugin-preview" sandbox="allow-scripts" srcDoc={previewSrcDoc(files)} className="absolute inset-0 h-full w-full border-0 bg-white" />
              )
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <EyeIcon className="mr-2 size-4" />生成插件后显示预览
              </div>
            )}
          </div>
          {showSource && (
            <div className="flex w-[min(40vw,520px)] shrink-0 flex-col border-l">
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-3">
                  <SourcePanel files={files} activeFile={activeFile} activeContent={activeContent} onActiveFileChange={onActiveFileChange} />
                </div>
              </ScrollArea>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
