import { useEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { toast } from 'sonner';
import { ArrowLeftIcon, CloudIcon, InfoIcon, PencilIcon, ExternalLinkIcon, WandSparklesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import { PluginManifestDialog } from '@/components/PluginManifestDialog';
import { ScriptPreviewPanel } from '@/components/plugins/ScriptPreviewPanel';
import { PluginLaunchScreen } from '@/components/plugins/PluginLaunchScreen';
import { useApp } from '@/App';
import type { LoadedPlugin } from '@/lib/types';
import type { ScriptRuntime } from '@/lib/plugin-script';
import { resolvePluginRuntime } from '@/lib/plugin-runtime';
import { dragRegionProps } from '@/lib/window-drag';
import { openPluginInWindow } from '@/lib/plugin-window';
import { ErrorBubble } from '@/components/chat/ErrorBubble';
import { toCreatorError, type CreatorError } from '@/lib/creator-error';
import {
  handleRuntimeCall,
  loadPluginDocument,
  runtimeMessage,
} from '../plugins-runtime';
import { usePluginRunnerActions } from './use-plugin-runner-actions';

function isScriptRuntime(runtime: string): runtime is ScriptRuntime {
  return runtime === 'nodejs' || runtime === 'python';
}

export function PluginRunner({ plugin, onBack }: { plugin: LoadedPlugin; onBack: () => void }) {
  const { setCurrentDraft, setView, setRunningPlugin, session, setPendingAutoFix } = useApp();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const runtime = resolvePluginRuntime(plugin);
  const document = usePluginDocument(plugin, runtime);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [scriptPreviewKey, setScriptPreviewKey] = useState(0);
  const actions = usePluginRunnerActions({
    plugin,
    setCurrentDraft,
    setPendingAutoFix,
    setRunningPlugin,
    setView,
  });
  const canEdit = !plugin.builtin
    && plugin.source === 'team'
    && (plugin.authorUserId === session.userId || session.role === 'TEAM_ADMIN')
    && Boolean(plugin.files?.length);
  usePluginBridge(plugin, iframeRef);

  return (
    <div className="flex h-full flex-col">
      <RunnerHeader
        plugin={plugin}
        editing={actions.editing}
        canEdit={canEdit}
        onBack={onBack}
        onEdit={actions.editInGenerator}
        onShowManifest={() => setManifestOpen(true)}
        onPopOut={() => { void openPluginInWindow(plugin).catch((e) => toast.error(e instanceof Error ? e.message : String(e))); }}
      />
      <RunnerContent
        error={document.error}
        iframeRef={iframeRef}
        loading={document.loading}
        onAutoFix={actions.handleAutoFix}
        onRefreshScript={() => setScriptPreviewKey((key) => key + 1)}
        plugin={plugin}
        runtime={runtime}
        scriptPreviewKey={scriptPreviewKey}
        srcDoc={document.srcDoc}
      />
      <PluginManifestDialog
        open={manifestOpen}
        onOpenChange={setManifestOpen}
        pluginName={plugin.name}
        files={plugin.files}
        fallback={{
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          runtime_type: runtime,
          entry: plugin.entry,
          description: plugin.description,
        }}
      />
    </div>
  );
}

function usePluginDocument(plugin: LoadedPlugin, runtime: string) {
  const [srcDoc, setSrcDoc] = useState('');
  const [error, setError] = useState<CreatorError | null>(null);
  // 统一中转页：HTML 文档加载期间为 loading=true，展示统一「启动中」视觉，成功后切 iframe。
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isScriptRuntime(runtime) || runtime === 'cloud') return;
    setLoading(true);
    void (async () => {
      try {
        setError(null);
        setSrcDoc(await loadPluginDocument(plugin));
      } catch (caught) {
        // HTML 插件入口读取/加载失败：包成结构化错误（标题+建议+raw），可让 AI 修。
        setError(toCreatorError('entry_load_failed', caught));
      } finally {
        setLoading(false);
      }
    })();
  }, [plugin, runtime]);

  return { error, loading, srcDoc };
}

function usePluginBridge(plugin: LoadedPlugin, iframeRef: RefObject<HTMLIFrameElement>) {
  useEffect(() => {
    const handler = async (ev: MessageEvent) => {
      const message = runtimeMessage(ev.data);
      const frame = iframeRef.current;
      if (!message || !frame || ev.source !== frame.contentWindow) return;
      await handleRuntimeCall(plugin, frame, message);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [plugin, iframeRef]);
}

function RunnerContent({
  error,
  iframeRef,
  loading,
  onAutoFix,
  onRefreshScript,
  plugin,
  runtime,
  scriptPreviewKey,
  srcDoc,
}: {
  error: CreatorError | null;
  iframeRef: Ref<HTMLIFrameElement>;
  loading: boolean;
  onAutoFix: (stderr: string) => void;
  onRefreshScript: () => void;
  plugin: LoadedPlugin;
  runtime: string;
  scriptPreviewKey: number;
  srcDoc: string;
}) {
  if (isScriptRuntime(runtime)) {
    return (
      <ScriptRunner
        plugin={plugin}
        runtime={runtime}
        previewKey={scriptPreviewKey}
        onAutoFix={onAutoFix}
        onRefresh={onRefreshScript}
      />
    );
  }
  if (runtime === 'cloud') return <CloudRuntimeNotice plugin={plugin} />;
  return <RunnerBody error={error} iframeRef={iframeRef} loading={loading} onAutoFix={onAutoFix} plugin={plugin} srcDoc={srcDoc} />;
}

function ScriptRunner({
  plugin,
  runtime,
  previewKey,
  onAutoFix,
  onRefresh,
}: {
  plugin: LoadedPlugin;
  runtime: ScriptRuntime;
  previewKey: number;
  onAutoFix: (stderr: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
      <ScriptPreviewPanel
        pluginId={plugin.id}
        files={plugin.files || []}
        runtime={runtime}
        builtin={plugin.source === 'builtin' || Boolean(plugin.builtin)}
        previewKey={previewKey}
        onRefresh={onRefresh}
        onRequestFix={onAutoFix}
      />
    </div>
  );
}

function RunnerHeader({
  plugin,
  editing,
  canEdit,
  onBack,
  onEdit,
  onShowManifest,
  onPopOut,
}: {
  plugin: LoadedPlugin;
  editing: boolean;
  canEdit: boolean;
  onBack: () => void;
  onEdit: () => void;
  onShowManifest: () => void;
  /** Task 15：弹出到独立窗口运行。 */
  onPopOut: () => void;
}) {
  return (
    <div {...dragRegionProps} className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
      <span className="truncate text-sm font-medium" data-tauri-drag-region>{plugin.name}</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onShowManifest}>
          <InfoIcon className="size-4" />详情
        </Button>
        {/* Task 15 多窗口：把插件弹出到独立窗口运行（一插件一窗口，聚焦即不重复创建）。 */}
        <Button variant="ghost" size="sm" title="在新窗口打开" onClick={onPopOut}>
          <ExternalLinkIcon className="size-4" />新窗口
        </Button>
        {canEdit && (
          <LoadingButton variant="outline" size="sm" loading={editing} onClick={onEdit}>
            <PencilIcon className="size-4" />继续修改
          </LoadingButton>
        )}
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />返回插件列表
        </Button>
      </div>
    </div>
  );
}

function RunnerBody({
  error,
  iframeRef,
  loading,
  onAutoFix,
  plugin,
  srcDoc,
}: {
  error: CreatorError | null;
  iframeRef: Ref<HTMLIFrameElement>;
  loading: boolean;
  onAutoFix: (stderr: string) => void;
  plugin: LoadedPlugin;
  srcDoc: string;
}) {
  // 仅对有源码的非内置插件提供「让 AI 修复」（内置插件源码不在前端，无法交 AI 改）。
  const canAutoFix = !plugin.builtin && Boolean(plugin.files?.length);
  if (error) {
    return (
      <div className="relative min-h-0 flex-1 bg-muted/30">
        <div className="space-y-3 p-4">
          <ErrorBubble error={error} />
          {canAutoFix && (
            <Button variant="outline" size="sm" onClick={() => onAutoFix(error.raw || error.title)}>
              <WandSparklesIcon className="mr-1 size-3.5" />
              让 AI 修复
            </Button>
          )}
        </div>
      </div>
    );
  }
  // 统一中转页：HTML 文档加载中显示「启动中」，与脚本类启动体验一致。
  if (loading) return <PluginLaunchScreen pluginName={plugin.name} hint="正在加载插件页面…" />;
  return (
    <div className="relative min-h-0 flex-1 bg-muted/30">
      <iframe
        ref={iframeRef}
        title={plugin.name}
        sandbox="allow-scripts allow-forms allow-popups"
        srcDoc={srcDoc}
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
    </div>
  );
}

function CloudRuntimeNotice({ plugin }: { plugin: LoadedPlugin }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <CloudIcon className="size-10 text-muted-foreground/50" />
        <h3 className="text-base font-semibold">{plugin.name}</h3>
        <p className="text-sm text-muted-foreground">
          这是一个云端运行时插件，其逻辑在服务端执行，桌面端仅提供入口与配置。请在插件市场或对应服务页面使用。
        </p>
      </div>
    </div>
  );
}
