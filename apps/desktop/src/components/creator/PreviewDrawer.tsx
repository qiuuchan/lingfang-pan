import { useState } from 'react';
import { RefreshCwIcon, CodeIcon, EyeIcon, XIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { parseManifest, previewSrcDoc } from '@/lib/plugin-draft';
import { dragRegionProps } from '@/lib/window-drag';
import type { ScriptRuntime } from '@/lib/plugin-script';
import type { DraftFile } from '@/lib/types';
import { ScriptPreviewPanel } from './panels/ScriptPreviewPanel';
import { SourcePanel } from './panels/SourcePanel';

// 全屏使用插件大窗（顶部「使用插件」按钮触发）：铺满整个视口，运行主体撑满可滚动。
// 左侧运行（client→iframe 撑满 / nodejs-python→ScriptPreviewPanel），右侧可收起的源码面板（多文件切换）。
// 运行内容（iframe 内的插件自身）由插件 CSS 决定是否滚动；iframe 容器本身铺满。

interface PreviewDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: DraftFile[];
  activeFile: string;
  activeContent: string;
  previewKey: number;
  onActiveFileChange: (value: string) => void;
  onRefreshPreview: () => void;
  /** 持久化插件 id（创建期已落地 plugins_root/<id>/）。提供时 ScriptPreviewPanel 走 start_plugin
   *  独立进程运行（pnpm install + pnpm start），缺失时降级 run_plugin_script 一次性预览。
   *  透传 pluginId 让 Electron 等需专属运行时的插件在创建期也能直接拉起（而非被预检拦截）。 */
  pluginId?: string;
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
  pluginId,
}: PreviewDrawerProps) {
  const runtime = parseManifest(files).runtime_type;
  const [showSource, setShowSource] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="flex h-[100vh] w-[100vw] max-w-none flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none">
        {/* 顶部条：标题 + 刷新 + 源码 + 关闭（自带 X 已隐藏避免与按钮重叠；条上可拖动窗口） */}
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5" {...dragRegionProps}>
          <DialogTitle className="text-sm font-medium" data-tauri-drag-region>使用插件</DialogTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={!files.length} onClick={onRefreshPreview}>
              <RefreshCwIcon className="size-4" /> 刷新
            </Button>
            <Button variant={showSource ? 'default' : 'outline'} size="sm" disabled={!files.length} onClick={() => setShowSource((v) => !v)}>
              <CodeIcon className="size-4" /> 源码
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)} title="关闭">
              <XIcon className="size-4" />
            </Button>
          </div>
        </div>
        {/* 主体：预览撑满 + 可选源码侧栏 */}
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 flex-1 bg-muted/30">
            {files.length ? (
              isScriptRuntime(runtime) ? (
                <div className="h-full overflow-auto p-4"><ScriptPreviewPanel pluginId={pluginId} files={files} runtime={runtime} previewKey={previewKey} onRefresh={onRefreshPreview} /></div>
              ) : (
                // client runtime：iframe absolute 撑满 relative 父容器；父容器 overflow-hidden，iframe 自身滚动。
                // 修复 RT-01：去掉 allow-same-origin（opaque origin 隔离 parent.__TAURI__/localStorage 越权）。
                <iframe key={previewKey} title="plugin-preview" sandbox="allow-scripts allow-forms allow-popups" srcDoc={previewSrcDoc(files)} className="absolute inset-0 h-full w-full border-0 bg-white" />
              )
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <EyeIcon className="mr-2 size-4" />生成插件后即可使用
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
