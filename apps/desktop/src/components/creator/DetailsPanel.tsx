import { EyeIcon, ActivityIcon, StethoscopeIcon, Share2Icon } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SessionStatusPanel } from './panels/SessionStatusPanel';
import { CreationStatusPanel } from './panels/CreationStatusPanel';
import { PreviewPanel } from './panels/PreviewPanel';
import { SourcePanel } from './panels/SourcePanel';
import { CloudSharePanel } from './panels/CloudSharePanel';
import type { AssistantSessionState } from '@/lib/plugin-draft';
import type { DraftFile, LoadedPlugin } from '@/lib/types';

// 右侧详情：顶部 tab 切换（预览 / 状态 / 分析 / 分享），取代原来 6 个 Card 垂直堆叠。
// 每个面板沿用既有 panel 组件，tab 只做容器与切换；去掉了与创建流无关的「最近插件」。
export function DetailsPanel({
  assistantSession,
  status,
  files,
  diagnostics,
  activeFile,
  activeContent,
  previewKey,
  cloudPlugin,
  uploading,
  submitting,
  onActiveFileChange,
  onRefreshPreview,
  onUpload,
  onSubmitMarketplace,
  onRun,
}: {
  assistantSession: AssistantSessionState | null;
  status?: string;
  files: DraftFile[];
  diagnostics: { stage: string; status: string; message: string }[];
  activeFile: string;
  activeContent: string;
  previewKey: number;
  cloudPlugin: LoadedPlugin | null;
  uploading: boolean;
  submitting: boolean;
  onActiveFileChange: (value: string) => void;
  onRefreshPreview: () => void;
  onUpload: () => void;
  onSubmitMarketplace: () => void;
  onRun: () => void;
}) {
  const shareDisabled = !files.length || (status !== 'ready' && status !== 'published');
  return (
    <Tabs defaultValue="preview" className="flex min-h-0 flex-1 flex-col">
      {/* 顶部 tab 切换条：固定不滚动 */}
      <TabsList className="m-3 mb-0 grid-cols-4 shrink-0">
        <TabsTrigger value="preview"><EyeIcon className="size-3.5" />预览</TabsTrigger>
        <TabsTrigger value="status"><ActivityIcon className="size-3.5" />状态</TabsTrigger>
        <TabsTrigger value="analyze"><StethoscopeIcon className="size-3.5" />分析</TabsTrigger>
        <TabsTrigger value="share"><Share2Icon className="size-3.5" />分享</TabsTrigger>
      </TabsList>
      {/* 单 tab 内容区：各自滚动，互不挤压 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <TabsContent value="preview" className="mt-0 space-y-4 focus-visible:outline-none">
            <PreviewPanel files={files} previewKey={previewKey} onRefresh={onRefreshPreview} />
            <SourcePanel files={files} activeFile={activeFile} activeContent={activeContent} onActiveFileChange={onActiveFileChange} />
          </TabsContent>
          <TabsContent value="status" className="mt-0 focus-visible:outline-none">
            <CreationStatusPanel status={status} files={files} diagnostics={diagnostics} />
          </TabsContent>
          <TabsContent value="analyze" className="mt-0 focus-visible:outline-none">
            <SessionStatusPanel session={assistantSession} />
          </TabsContent>
          <TabsContent value="share" className="mt-0 focus-visible:outline-none">
            <CloudSharePanel
              cloudPlugin={cloudPlugin}
              disabled={shareDisabled}
              submitting={submitting}
              uploading={uploading}
              onRun={onRun}
              onSubmitMarketplace={onSubmitMarketplace}
              onUpload={onUpload}
            />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  );
}
