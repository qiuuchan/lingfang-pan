import { useEffect, useRef, useState, type Ref } from 'react';
import { toast } from 'sonner';
import { ArrowLeftIcon, PencilIcon } from 'lucide-react';
import { useApp } from '@/App';
import type { LoadedPlugin } from '@/lib/types';
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
      // collab-api 的 publicPlugin 始终内联返回 files，直接用本地数据派生草稿即可，
      // 不再回退到已下线的 Rust /plugins/:id/edit 路由（collab-api 无对应能力）。
      if (plugin.files?.length) {
        setCurrentDraft({
          id: plugin.id,
          status: plugin.status || 'ready',
          files: plugin.files,
          turns: [],
          diagnostics: [],
          plugin_id: plugin.id,
        });
      } else {
        throw new Error('插件缺少安装文件，无法进入编辑器。');
      }
      setRunningPlugin(null);
      setView('home');
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
    <div className="flex h-full flex-col">
      <RunnerHeader plugin={plugin} editing={editing} onBack={onBack} onEdit={editInGenerator} />
      <RunnerBody error={error} iframeRef={iframeRef} plugin={plugin} srcDoc={srcDoc} />
    </div>
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
    <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
      <span className="truncate text-sm font-medium">{plugin.name}</span>
      <div className="flex items-center gap-2">
        {plugin.source === 'team' && (
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
  plugin,
  srcDoc,
}: {
  error: string;
  iframeRef: Ref<HTMLIFrameElement>;
  plugin: LoadedPlugin;
  srcDoc: string;
}) {
  return (
    <div className="relative min-h-0 flex-1 bg-muted/30">
      {error ? (
        <p className="p-4 text-sm text-destructive">{error}</p>
      ) : (
        // 运行态：iframe 铺满整个主体区（无边框无圆角），插件自身内容滚动。
        // 修复 RT-01（critical iframe 越权）：去掉 allow-same-origin，使 srcDoc iframe 成为 opaque origin，
        // 不继承宿主 origin，无法访问 parent.__TAURI__.core.invoke 或 parent.localStorage 中的 JWT，
        // 三重 capability 校验不再被旁路。postMessage 通信不依赖 same-origin，运行态桥不受影响。
        // localStorage 在 opaque origin 下仍可用（独立存储），内置插件（todo-list 等）正常工作。
        <iframe
          ref={iframeRef}
          title={plugin.name}
          sandbox="allow-scripts allow-forms allow-popups"
          srcDoc={srcDoc}
          className="absolute inset-0 h-full w-full border-0 bg-white"
        />
      )}
    </div>
  );
}

export function Plugins() {
  const { runningPlugin, setRunningPlugin, pinPlugin, unpinPlugin, isPinned, setView } = useApp();
  const [list, setList] = useState<LoadedPlugin[] | null>(null);
  const [error, setError] = useState<string>('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (runningPlugin) return;
    // DESK-PLUGINS-01 修复：loadPlugins 用 Promise.allSettled 永不 reject，
    // 此前外层 try/catch 是死代码（catch 不可达）。错误实际经 setError(result.error) 生效。
    void (async () => {
      const result = await loadPlugins();
      setError(result.error);
      setList(result.plugins);
      setPage(1);
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
          !error && (
            <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
              <span>暂无插件</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setView('home')}>去创建插件</Button>
                <Button variant="outline" size="sm" onClick={() => setView('market')}>去市场安装</Button>
              </div>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
