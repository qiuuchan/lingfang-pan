import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { PreviewPanel } from './panels/PreviewPanel';
import { SourcePanel } from './panels/SourcePanel';
import type { DraftFile } from '@/lib/types';

// design §3.3.3：全屏预览大窗（顶部「预览」按钮触发）。
// 复用 sheet.tsx + PreviewPanel + SourcePanel，不重写。
// SheetContent 的 className 覆盖 sheetVariants.right 的 w-[min(92vw,640px)]（sheet.tsx:37）
// 为 w-[min(95vw,1400px)]，给多文件预览与源码以足够宽度。
//
// 内部 grid：左 PreviewPanel（client→iframe / nodejs-python→ScriptPreviewPanel），右 SourcePanel（多文件 Tabs 切换）。
// activeFile / onActiveFileChange / activeContent / previewKey / onRefreshPreview 与原 DetailsPanel preview tab 同款透传。

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
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(95vw,1400px)] max-w-none p-0 flex flex-col">
        <SheetHeader className="flex-row shrink-0 items-center justify-between border-b px-4 py-3">
          <SheetTitle>插件预览</SheetTitle>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(280px,40%)]">
          <div className="min-h-0 overflow-hidden border-r">
            <PreviewPanel files={files} previewKey={previewKey} onRefresh={onRefreshPreview} />
          </div>
          <div className="min-h-0 overflow-auto p-3">
            <SourcePanel files={files} activeFile={activeFile} activeContent={activeContent} onActiveFileChange={onActiveFileChange} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
