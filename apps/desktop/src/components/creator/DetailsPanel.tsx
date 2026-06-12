import { ScrollArea } from '@/components/ui/scroll-area';
import { SessionStatusPanel } from './panels/SessionStatusPanel';
import { CreationStatusPanel } from './panels/CreationStatusPanel';
import { PreviewPanel } from './panels/PreviewPanel';
import { SourcePanel } from './panels/SourcePanel';
import { CloudSharePanel } from './panels/CloudSharePanel';
import { RecentPlugins } from './panels/RecentPlugins';
import type { AssistantSessionState } from '@/lib/plugin-draft';
import type { DraftFile, LoadedPlugin } from '@/lib/types';

export function DetailsPanel({
  assistantSession,
  status,
  files,
  diagnostics,
  activeFile,
  activeContent,
  previewKey,
  cloudPlugin,
  recent,
  uploading,
  submitting,
  onActiveFileChange,
  onRefreshPreview,
  onUpload,
  onSubmitMarketplace,
  onRun,
  onRunRecent,
}: {
  assistantSession: AssistantSessionState | null;
  status?: string;
  files: DraftFile[];
  diagnostics: { stage: string; status: string; message: string }[];
  activeFile: string;
  activeContent: string;
  previewKey: number;
  cloudPlugin: LoadedPlugin | null;
  recent: LoadedPlugin[];
  uploading: boolean;
  submitting: boolean;
  onActiveFileChange: (value: string) => void;
  onRefreshPreview: () => void;
  onUpload: () => void;
  onSubmitMarketplace: () => void;
  onRun: () => void;
  onRunRecent: (plugin: LoadedPlugin) => void;
}) {
  const shareDisabled = !files.length || (status !== 'ready' && status !== 'published');
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-4 p-4">
        <SessionStatusPanel session={assistantSession} />
        <CreationStatusPanel status={status} files={files} diagnostics={diagnostics} />
        <PreviewPanel files={files} previewKey={previewKey} onRefresh={onRefreshPreview} />
        <SourcePanel files={files} activeFile={activeFile} activeContent={activeContent} onActiveFileChange={onActiveFileChange} />
        <CloudSharePanel
          cloudPlugin={cloudPlugin}
          disabled={shareDisabled}
          submitting={submitting}
          uploading={uploading}
          onRun={onRun}
          onSubmitMarketplace={onSubmitMarketplace}
          onUpload={onUpload}
        />
        <RecentPlugins plugins={recent} onRun={onRunRecent} />
      </div>
    </ScrollArea>
  );
}