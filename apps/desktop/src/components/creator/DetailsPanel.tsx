import { type ReactNode } from 'react';
import { ActivityIcon, StethoscopeIcon, Share2Icon } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SessionStatusPanel } from './panels/SessionStatusPanel';
import { CreationStatusPanel } from './panels/CreationStatusPanel';
import { CloudSharePanel } from './panels/CloudSharePanel';
import type { AssistantSessionState } from '@/lib/plugin-draft';
import type { DraftFile, LoadedPlugin } from '@/lib/types';

// 项 15a：精简右侧详情面板——原 状态/分析/分享 三 tab 合并为单滚动面板的三个分区
// （去 tab 切换，一屏可览全部信息；各自 panel 逻辑零改动）。
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
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-5 p-4">
        <Section title="创建状态" icon={<ActivityIcon className="size-3.5" />}>
          <CreationStatusPanel status={status} files={files} diagnostics={diagnostics} />
        </Section>
        <Section title="会话分析" icon={<StethoscopeIcon className="size-3.5" />}>
          <SessionStatusPanel session={assistantSession} />
        </Section>
        <Section title="云端分享" icon={<Share2Icon className="size-3.5" />}>
          <CloudSharePanel
            cloudPlugin={cloudPlugin}
            disabled={shareDisabled}
            submitting={submitting}
            uploading={uploading}
            onRun={onRun}
            onSubmitMarketplace={onSubmitMarketplace}
            onUpload={onUpload}
          />
        </Section>
      </div>
    </ScrollArea>
  );
}

/** 分区：标题（图标 + 文案）+ 内容。替代原 tab，单面板内堆叠展示。 */
function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}
