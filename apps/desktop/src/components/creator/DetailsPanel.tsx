import { ActivityIcon, StethoscopeIcon, Share2Icon } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SessionStatusPanel } from './panels/SessionStatusPanel';
import { CreationStatusPanel } from './panels/CreationStatusPanel';
import { CloudSharePanel } from './panels/CloudSharePanel';
import type { AssistantSessionState } from '@/lib/plugin-draft';
import type { DraftFile, LoadedPlugin } from '@/lib/types';

// design §3.3.1：右侧详情只保留 状态 / 分析 / 分享 三个 tab。
// 预览与源码已上移到顶部「预览」按钮触发的全屏 PreviewDrawer（见 PreviewDrawer.tsx），
// 不再挤在 420px aside 里。组件 PreviewPanel/SourcePanel 本身保留，供 PreviewDrawer 复用。
export function DetailsPanel({
  assistantSession,
  status,
  files,
  diagnostics,
  cloudPlugin,
  uploading,
  submitting,
  onUpload,
  onSubmitMarketplace,
  onRun,
}: {
  assistantSession: AssistantSessionState | null;
  status?: string;
  files: DraftFile[];
  diagnostics: { stage: string; status: string; message: string }[];
  cloudPlugin: LoadedPlugin | null;
  uploading: boolean;
  submitting: boolean;
  onUpload: () => void;
  onSubmitMarketplace: () => void;
  onRun: () => void;
}) {
  const shareDisabled = !files.length || (status !== 'ready' && status !== 'published');
  return (
    <Tabs defaultValue="status" className="flex min-h-0 flex-1 flex-col">
      {/* 顶部 tab 切换条：固定不滚动（grid-cols-3，去掉了 preview） */}
      <TabsList className="m-3 mb-0 grid-cols-3 shrink-0">
        <TabsTrigger value="status"><ActivityIcon className="size-3.5" />状态</TabsTrigger>
        <TabsTrigger value="analyze"><StethoscopeIcon className="size-3.5" />分析</TabsTrigger>
        <TabsTrigger value="share"><Share2Icon className="size-3.5" />分享</TabsTrigger>
      </TabsList>
      {/* 单 tab 内容区：各自滚动，互不挤压 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
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
