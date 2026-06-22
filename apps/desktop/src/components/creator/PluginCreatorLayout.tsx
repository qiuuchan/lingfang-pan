import type { LegacyRef } from 'react';
import { AlertTriangleIcon, EyeIcon, HistoryIcon, PanelRightOpenIcon, SparklesIcon, WandSparklesIcon, XIcon } from 'lucide-react';
import { AssistantChat } from '@/components/chat/AssistantChat';
import { ErrorBubble } from '@/components/chat/ErrorBubble';
import { LoadingButton } from '@/components/loading-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Composer } from '@/components/creator/Composer';
import { ConversationRail } from '@/components/creator/ConversationRail';
import { DetailsPanel } from '@/components/creator/DetailsPanel';
import { PreviewDrawer } from '@/components/creator/PreviewDrawer';
import type { EnvReadinessResult } from '@/lib/env-readiness';
import { EXAMPLES, STATUS_LABEL, type AskUserQuestion, type AssistantSessionState, type ConversationMeta, type EffortLevel, type ProviderId } from '@/lib/plugin-draft';
import type { CreatorError } from '@/lib/creator-error';
import type { AccountSettingsTab, DraftDiagnostic, DraftFile, DraftTurn, LoadedPlugin, Session, SettingsTab, View } from '@/lib/types';
import { cn } from '@/lib/utils';
import { dragRegionProps } from '@/lib/window-drag';
import { STATUS_DISPLAY, STATUS_VARIANT, type LocalPluginStatus } from '@/lib/plugin-status';

type LiveSegment = { stream: 'stdout' | 'stderr' | 'thought' | 'tool'; text: string };
type ProviderInfo = { id: string; label: string; models: string[] };
type AttachedPlugin = { id: string; name: string; summary: string };

interface PluginCreatorLayoutProps {
  chatRef: LegacyRef<HTMLDivElement>;
  activeConversationTitle: string;
  pluginStatus: LocalPluginStatus | null;
  status?: string;
  showConvertAction: boolean;
  hasDraft: boolean;
  envReadiness: EnvReadinessResult;
  hasConversation: boolean;
  turns: DraftTurn[];
  pendingUser: string | null;
  liveSegments: LiveSegment[];
  streaming: boolean;
  liveStage: string;
  liveError: CreatorError | null;
  askAnswering: boolean;
  isFollowup: boolean;
  input: string;
  model: string;
  provider: string;
  providerInfo: ProviderInfo;
  providers: ProviderInfo[];
  effort: EffortLevel;
  attachedPlugins: AttachedPlugin[];
  mentionablePlugins: AttachedPlugin[];
  detailsOpen: boolean;
  previewOpen: boolean;
  historyOpen: boolean;
  files: DraftFile[];
  activeFile: string;
  activeContent: string;
  previewKey: number;
  pluginId?: string;
  assistantSession: AssistantSessionState | null;
  diagnostics: DraftDiagnostic[];
  cloudPlugin: LoadedPlugin | null;
  uploading: boolean;
  submitting: boolean;
  metas: ConversationMeta[];
  activeId: string | null;
  session: Session;
  onChatScroll: () => void;
  onInputChange: (value: string) => void;
  onNewDraft: () => void;
  onHistoryOpenChange: (open: boolean) => void;
  onForceConvert: () => void;
  onPreviewOpenChange: (open: boolean) => void;
  onDetailsOpenChange: (open: boolean) => void;
  onSettingsNavigate: (tab: AccountSettingsTab, settingsTab?: SettingsTab) => void;
  onAskUserAnswer: (question: AskUserQuestion, optionLabel: string) => void;
  onRetry?: () => void;
  onAttach: (plugin: AttachedPlugin) => void;
  onDetach: (id: string) => void;
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onEffortChange: (value: EffortLevel) => void;
  onCustomModel: () => void;
  onSend: (overrideText?: string) => void;
  onStop: () => void;
  onUpload: () => void;
  onSubmitMarketplace: () => void;
  onRunPlugin: () => void;
  onActiveFileChange: (value: string) => void;
  onRefreshPreview: () => void;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
  setView: (view: View) => void;
  setSettingsTab: (tab: SettingsTab) => void;
}

export function PluginCreatorLayout(props: PluginCreatorLayoutProps) {
  const statusBadge = props.pluginStatus
    ? <Badge variant={STATUS_VARIANT[props.pluginStatus.status]}>{STATUS_DISPLAY[props.pluginStatus.status]}</Badge>
    : props.status
      ? <Badge variant={props.status === 'ready' ? 'default' : props.status === 'invalid' ? 'destructive' : 'secondary'}>{STATUS_LABEL[props.status] || props.status}</Badge>
      : null;

  return (
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <SparklesIcon className="size-4 shrink-0 text-primary" />
            <span className="shrink-0">插件创建</span>
            {props.activeConversationTitle && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <span className="truncate text-muted-foreground">{props.activeConversationTitle}</span>
              </>
            )}
            {statusBadge}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={props.onNewDraft}>新对话</Button>
            <Button variant="ghost" size="sm" className="gap-1" title="历史对话" onClick={() => props.onHistoryOpenChange(true)}>
              <HistoryIcon className="size-4" /> 历史
            </Button>
            {props.showConvertAction && (
              <Button variant="outline" size="sm" onClick={props.onForceConvert}>
                <WandSparklesIcon className="size-3.5" /> 转为草稿
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={!props.hasDraft} onClick={() => props.onPreviewOpenChange(true)} title={props.hasDraft ? '使用插件' : '尚未生成插件草稿'}>
              <EyeIcon className="size-4" /> 使用插件
            </Button>
            <Button variant="outline" size="sm" onClick={() => props.onDetailsOpenChange(true)}>
              <PanelRightOpenIcon className="size-4" /> 详情
            </Button>
          </div>
        </div>

        {!props.envReadiness.loading && !props.envReadiness.ready && (
          <div className="flex shrink-0 items-start gap-3 border-b bg-amber-50 px-4 py-2.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1 text-xs leading-relaxed">环境未就绪：{props.envReadiness.missing.join('；')}。完善后即可创建插件。</div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 border-amber-300 bg-transparent text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/50"
              onClick={() => {
                const missing = props.envReadiness.missing.join('');
                props.onSettingsNavigate('settings', missing.includes('CLI') ? 'cli' : missing.includes('API 密钥') ? 'gateway' : 'backend');
              }}
            >
              去设置
            </Button>
          </div>
        )}

        <div ref={props.chatRef} onScroll={props.onChatScroll} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto max-w-3xl px-4 py-6 pb-20">
            {!props.hasConversation ? (
              <div className="flex h-full flex-col justify-center text-center">
                <h1 className="text-balance text-4xl font-semibold tracking-tight md:text-5xl">今天想创建什么插件？</h1>
                <div className="mx-auto mt-8 grid w-full max-w-2xl gap-2">
                  {EXAMPLES.map((example) => (
                    <Button key={example} variant="outline" className="h-auto justify-start whitespace-normal rounded-xl px-4 py-3 text-left text-muted-foreground" onClick={() => props.onInputChange(example)}>
                      {example}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <AssistantChat
                  turns={[...props.turns, ...(props.pendingUser ? [{ role: 'user' as const, content: props.pendingUser }] : [])]}
                  segments={props.liveSegments}
                  streaming={props.streaming}
                  stage={props.liveStage}
                  onAskUserAnswer={props.onAskUserAnswer}
                  askAnswering={props.askAnswering}
                />
                {!props.streaming && props.liveError && <ErrorBubble error={props.liveError} onRetry={props.onRetry} />}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <Composer
              input={props.input}
              model={props.model}
              provider={props.provider}
              providerInfo={props.providerInfo}
              providers={props.providers}
              streaming={props.streaming}
              effort={props.effort}
              attachedPlugins={props.attachedPlugins}
              mentionablePlugins={props.mentionablePlugins}
              onAttach={props.onAttach}
              onDetach={props.onDetach}
              onInputChange={props.onInputChange}
              onModelChange={props.onModelChange}
              onProviderChange={props.onProviderChange}
              onEffortChange={props.onEffortChange}
              onCustomModel={props.onCustomModel}
              onSend={props.onSend}
              onStop={props.onStop}
            />
          </div>
        </div>
      </div>

      <aside className={cn('flex h-full shrink-0 flex-col overflow-hidden border-l bg-card transition-all duration-200', props.detailsOpen ? 'z-20 w-full md:w-[min(32vw,560px)] md:min-w-[360px] xl:w-[min(24vw,560px)]' : 'w-0')}>
        <div className="flex h-full w-full flex-col md:w-[min(32vw,560px)] md:min-w-[360px] xl:w-[min(24vw,560px)]">
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-medium">插件创建详情</span>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => props.onDetailsOpenChange(false)}>
              <XIcon className="size-4" />
            </Button>
          </div>
          <DetailsPanel
            assistantSession={props.assistantSession}
            status={props.status}
            files={props.files}
            diagnostics={props.diagnostics}
            cloudPlugin={props.cloudPlugin}
            uploading={props.uploading}
            submitting={props.submitting}
            onUpload={props.onUpload}
            onSubmitMarketplace={props.onSubmitMarketplace}
            onRun={props.onRunPlugin}
          />
        </div>
      </aside>

      <PreviewDrawer
        open={props.previewOpen}
        onOpenChange={props.onPreviewOpenChange}
        files={props.files}
        activeFile={props.activeFile}
        activeContent={props.activeContent}
        previewKey={props.previewKey}
        onActiveFileChange={props.onActiveFileChange}
        onRefreshPreview={props.onRefreshPreview}
        pluginId={props.pluginId}
      />
      <Dialog open={props.historyOpen} onOpenChange={props.onHistoryOpenChange}>
        <DialogContent className="gap-0 p-0 sm:max-w-xl">
          <DialogHeader className="border-b px-4 py-3" {...dragRegionProps}>
            <DialogTitle className="text-base" data-tauri-drag-region>历史对话</DialogTitle>
          </DialogHeader>
          <ConversationRail
            metas={props.metas}
            activeId={props.activeId}
            onSelect={(id) => props.onSelectConversation(id)}
            onNew={props.onNewDraft}
            onRename={props.onRenameConversation}
            onDelete={props.onDeleteConversation}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
