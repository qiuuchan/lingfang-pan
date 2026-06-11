import { useEffect, useRef, useState, type Ref } from 'react';
import { toast } from 'sonner';
import { ArrowLeftIcon, PencilIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api } from '@/lib/api';
import type { LoadedPlugin, PluginDraft } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import { PluginList } from './PluginList';
import {
  errorMessage,
  handleRuntimeCall,
  loadPluginDocument,
  loadPlugins,
  runtimeMessage,
} from './plugins-runtime';

const PAGE_SIZE = 6;

function Runner({ plugin, onBack }: { plugin: LoadedPlugin; onBack: () => void }) {
  const { setCurrentDraft, setView, setRunningPlugin } = useApp();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc, setSrcDoc] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [editing, setEditing] = useState(false);

  async function editInGenerator() {
    setEditing(true);
    try {
      const draft = await api<PluginDraft>(`/plugins/${plugin.id}/edit`, { method: 'POST' });
      setCurrentDraft(draft);
      setRunningPlugin(null);
      setView('team');
    } catch (caught) {
      toast.error(errorMessage(caught));
      setEditing(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        setError('');
        setSrcDoc(await loadPluginDocument(plugin));
      } catch (caught) {
        setError(errorMessage(caught));
      }
    })();
  }, [plugin]);

  useEffect(() => {
    const handler = async (ev: MessageEvent) => {
      const message = runtimeMessage(ev.data);
      const frame = iframeRef.current;
      if (!message || !frame) return;
      if (ev.source !== frame.contentWindow) return;
      await handleRuntimeCall(plugin, frame, message);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [plugin]);

  return (
    <Card>
      <RunnerHeader plugin={plugin} editing={editing} onBack={onBack} onEdit={editInGenerator} />
      <RunnerBody error={error} iframeRef={iframeRef} plugin={plugin} srcDoc={srcDoc} />
    </Card>
  );
}

function RunnerHeader({
  plugin,
  editing,
  onBack,
  onEdit,
}: {
  plugin: LoadedPlugin;
  editing: boolean;
  onBack: () => void;
  onEdit: () => void;
}) {
  return (
    <CardHeader className="flex-row items-center justify-between space-y-0">
      <CardTitle>{plugin.name}</CardTitle>
      <div className="flex items-center gap-2">
        {plugin.source === 'published' && (
          <LoadingButton variant="outline" size="sm" loading={editing} onClick={onEdit}>
            <PencilIcon className="size-4" />继续修改
          </LoadingButton>
        )}
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />返回插件列表
        </Button>
      </div>
    </CardHeader>
  );
}

function RunnerBody({
  error,
  iframeRef,
  plugin,
  srcDoc,
}: {
  error: string;
  iframeRef: Ref<HTMLIFrameElement>;
  plugin: LoadedPlugin;
  srcDoc: string;
}) {
  return (
    <CardContent>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <iframe
          ref={iframeRef}
          title={plugin.name}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="h-[520px] w-full rounded-md border bg-white"
        />
      )}
    </CardContent>
  );
}

export function Plugins() {
  const { runningPlugin, setRunningPlugin, pinPlugin, unpinPlugin, isPinned } = useApp();
  const [list, setList] = useState<LoadedPlugin[] | null>(null);
  const [error, setError] = useState<string>('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (runningPlugin) return;
    (async () => {
      try {
        const result = await loadPlugins();
        setError(result.error);
        setList(result.plugins);
        setPage(1);
      } catch (caught) {
        setError(errorMessage(caught));
        setList([]);
      }
    })();
  }, [runningPlugin]);

  if (runningPlugin) return <Runner plugin={runningPlugin} onBack={() => setRunningPlugin(null)} />;

  const total = list?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageItems = (list ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <Card>
      <CardHeader>
        <CardTitle>我的插件</CardTitle>
        <p className="text-sm text-muted-foreground">本地内置插件、你发布的插件、从市场安装的插件都在这里运行。</p>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
        {list === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : total ? (
          <PluginList
            isPinned={isPinned}
            items={pageItems}
            onRun={setRunningPlugin}
            onTogglePin={(plugin, pinned) => (pinned ? unpinPlugin(plugin.id) : pinPlugin(plugin))}
            page={page}
            setPage={setPage}
            totalPages={totalPages}
          />
        ) : (
          !error && <span className="text-sm text-muted-foreground">暂无插件。先到「造插件」生成并发布，或到「市场」安装。</span>
        )}
      </CardContent>
    </Card>
  );
}
