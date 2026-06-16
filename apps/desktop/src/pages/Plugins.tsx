import { useEffect, useRef, useState, type Ref } from 'react';
import { toast } from 'sonner';
import { ArrowLeftIcon, PencilIcon, PackageIcon, CloudIcon, PlayIcon, SquareIcon, RefreshCwIcon, InfoIcon } from 'lucide-react';
import { useApp } from '@/App';
import type { LoadedPlugin, DraftFile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import { PluginList } from './PluginList';
import { Shimmer } from '@/lib/motion';
import { PluginManifestDialog } from '@/components/PluginManifestDialog';
import { parseManifest } from '@/lib/plugin-draft';
import { dragRegionProps } from '@/lib/window-drag';
import type { ScriptRuntime } from '@/lib/plugin-script';
import { ScriptPreviewPanel } from '@/components/creator/panels/ScriptPreviewPanel';
import {
  errorMessage,
  handleRuntimeCall,
  loadPluginDocument,
  loadPlugins,
  runtimeMessage,
} from './plugins-runtime';
// 组C：本地插件持久化目录扫描（动态状态 + 运行/停止进程）。
import {
  scanPluginStatus,
  startPlugin,
  stopPlugin,
  readLocalPluginFile,
  STATUS_DISPLAY,
  STATUS_VARIANT,
  RUNTIME_DISPLAY,
  type LocalPluginStatus,
} from '@/lib/plugin-status';

const PAGE_SIZE = 6;

// R3 runtime 分派判定：nodejs/python 走脚本运行视图（复用 ScriptPreviewPanel），client 走 iframe，cloud 给说明。
function isScriptRuntime(runtime: string): runtime is ScriptRuntime {
  return runtime === 'nodejs' || runtime === 'python';
}

function Runner({ plugin, onBack }: { plugin: LoadedPlugin; onBack: () => void }) {
  const { setCurrentDraft, setView, setRunningPlugin, session } = useApp();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc, setSrcDoc] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [editing, setEditing] = useState(false);
  // 详情弹窗（体验完善需求 1：展示插件 manifest.json 信息）。
  const [manifestOpen, setManifestOpen] = useState(false);
  // R3 脚本运行视图刷新 key：点刷新时 +1 触发 ScriptPreviewPanel 重新探测。
  const [scriptPreviewKey, setScriptPreviewKey] = useState(0);

  // R3 据 manifest 的 runtime_type 分派运行态。client→iframe（不变），nodejs/python→脚本运行，cloud→说明。
  const runtime = plugin.runtime_type || parseManifest(plugin.files || []).runtime_type;

  // 修改权限（与后端 ensurePluginManager 一致）：作者本人 或 当前用户是 TEAM_ADMIN。
  // 内置插件（builtin）不可改；市场第三方插件（source==='marketplace' 且非本团队）无 files 也不可改。
  const canEdit = !plugin.builtin
    && plugin.source === 'team'
    && (plugin.authorUserId === session.userId || session.role === 'TEAM_ADMIN')
    && Boolean(plugin.files?.length);

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
    // R3 脚本型/cloud runtime 不走 iframe 文档加载，跳过。
    if (isScriptRuntime(runtime) || runtime === 'cloud') return;
    (async () => {
      try {
        setError('');
        setSrcDoc(await loadPluginDocument(plugin));
      } catch (caught) {
        setError(errorMessage(caught));
      }
    })();
  }, [plugin, runtime]);

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
      <RunnerHeader
        plugin={plugin}
        editing={editing}
        canEdit={canEdit}
        onBack={onBack}
        onEdit={editInGenerator}
        onShowManifest={() => setManifestOpen(true)}
      />
      {isScriptRuntime(runtime) ? (
        // R3 nodejs/python：复用创建器的脚本运行组件（探测→运行→终端回显 + 缺失运行时引导）。
        // 「使用/启用」即点「运行」执行 entry 脚本；缺失解释器时组件内引导安装。
        // 组C 改造（task 06-16）：Python/Node 改为独立进程运行（venv/pnpm），不再嵌入软件内终端。
        // ScriptPreviewPanel 的「运行」按钮现已改为 startPlugin 独立进程启动，软件内仅显示运行状态 + 停止按钮。
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
          <ScriptPreviewPanel
            pluginId={plugin.id}
            files={plugin.files || []}
            runtime={runtime}
            previewKey={scriptPreviewKey}
            onRefresh={() => setScriptPreviewKey((k) => k + 1)}
          />
        </div>
      ) : runtime === 'cloud' ? (
        // R3 cloud runtime：不在桌面壳本地运行范围，给说明而非空 iframe。
        <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-6">
          <div className="flex max-w-md flex-col items-center gap-3 text-center">
            <CloudIcon className="size-10 text-muted-foreground/50" />
            <h3 className="text-base font-semibold">{plugin.name}</h3>
            <p className="text-sm text-muted-foreground">
              这是一个云端运行时插件，其逻辑在服务端执行，桌面端仅提供入口与配置。请在插件市场或对应服务页面使用。
            </p>
          </div>
        </div>
      ) : (
        <RunnerBody error={error} iframeRef={iframeRef} plugin={plugin} srcDoc={srcDoc} />
      )}
      <PluginManifestDialog
        open={manifestOpen}
        onOpenChange={setManifestOpen}
        pluginName={plugin.name}
        files={plugin.files}
        fallback={{
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          runtime_type: plugin.runtime_type,
          entry: plugin.entry,
          description: plugin.description,
        }}
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
}: {
  plugin: LoadedPlugin;
  editing: boolean;
  canEdit: boolean;
  onBack: () => void;
  onEdit: () => void;
  onShowManifest: () => void;
}) {
  return (
    <div {...dragRegionProps} className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
      <span className="truncate text-sm font-medium" data-tauri-drag-region>{plugin.name}</span>
      <div className="flex items-center gap-2">
        {/* 详情：展示插件 manifest.json 信息（体验完善需求 1，所有插件可用）。 */}
        <Button variant="ghost" size="sm" onClick={onShowManifest}>
          <InfoIcon className="size-4" />详情
        </Button>
        {/* 继续修改：作者本人 或 TEAM_ADMIN 可改（与后端 ensurePluginManager 一致，需求 3）。 */}
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

// 组C：本地持久化插件列表项（从 scan_plugin_status 扫描文件系统获取）。
// 与 PluginListItem（数据库/内置插件）解耦：本地插件的运行方式与状态展示完全不同
// （独立进程运行 + 动态状态 Badge），不复用 PluginListItem 的作者改价/审核 UI。
function LocalPluginItem({
  item,
  onStart,
  onStop,
  onOpen,
}: {
  item: LocalPluginStatus;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onOpen: (item: LocalPluginStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  // 详情弹窗（体验完善需求 1：展示本地插件 manifest.json 信息，懒加载读取）。
  const [manifestOpen, setManifestOpen] = useState(false);
  // 本地插件 manifest 文件列表（详情弹窗打开时懒加载读取 manifest.json）。
  const [manifestFiles, setManifestFiles] = useState<DraftFile[]>([]);
  const isRunning = item.status === 'running';
  const isScript = item.runtime === 'nodejs' || item.runtime === 'python';

  // 本地插件仅 client（HTML）可「打开」内嵌 iframe；nodejs/python 走「运行」独立进程。
  const canOpen = item.runtime === 'client' && item.status !== 'error';

  // 打开详情：懒加载读取本地插件 manifest.json（首次打开才读，避免列表渲染时 N 次文件 IO）。
  async function openManifest() {
    if (!manifestFiles.length) {
      try {
        const content = await readLocalPluginFile(item.id, 'manifest.json');
        setManifestFiles([{ path: 'manifest.json', content }]);
      } catch {
        // manifest 读取失败（incomplete/error 插件可能无 manifest）：留空，弹窗用 fallback 字段展示。
        setManifestFiles([]);
      }
    }
    setManifestOpen(true);
  }

  async function handleToggle() {
    setBusy(true);
    try {
      if (isRunning) {
        await stopPlugin(item.id);
        toast.success('插件已停止');
      } else {
        await startPlugin(item.id);
        toast.success('插件已启动，运行在独立进程');
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* 名称：用户命名（不取 manifest.name，scan 时已优先 title 字段）。 */}
          <span className="truncate font-medium">{item.name}</span>
          {/* 类型图标（运行时分类，PRD 需求：类型图标）。 */}
          <span className="shrink-0 text-xs text-muted-foreground">{RUNTIME_DISPLAY[item.runtime]}</span>
          {/* 动态状态 Badge：ready/incomplete/error/running/stopped（PRD AC2）。 */}
          <span
            className={`inline-flex h-5 items-center rounded-full px-2 text-xs font-medium ${
              STATUS_VARIANT[item.status] === 'default'
                ? 'bg-primary text-primary-foreground'
                : STATUS_VARIANT[item.status] === 'destructive'
                  ? 'bg-destructive/10 text-destructive dark:bg-destructive/20'
                  : STATUS_VARIANT[item.status] === 'secondary'
                    ? 'bg-secondary text-secondary-foreground'
                    : 'border border-border text-foreground'
            }`}
          >
            {STATUS_DISPLAY[item.status]}
          </span>
        </div>
        {/* 状态诊断说明：incomplete/error 时展示原因，便于用户修复。 */}
        <div className="truncate text-sm text-muted-foreground">
          {item.detail || item.description || '—'}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">v{item.version}</span>
        {/* 详情：展示插件 manifest.json 信息（体验完善需求 1，所有插件可用）。 */}
        <Button variant="ghost" size="sm" onClick={openManifest} title="查看插件信息">
          <InfoIcon className="size-3.5" />
        </Button>
        {/* 脚本型（Python/Node）：运行/停止按钮（独立进程，PRD AC5）。 */}
        {isScript && (
          <LoadingButton
            variant={isRunning ? 'destructive' : 'default'}
            size="sm"
            loading={busy}
            disabled={item.status === 'incomplete' || item.status === 'error'}
            onClick={handleToggle}
            title={item.status === 'incomplete' || item.status === 'error' ? '插件未就绪，无法运行' : undefined}
          >
            {isRunning ? <SquareIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
            {isRunning ? '停止' : '运行'}
          </LoadingButton>
        )}
        {/* 网页型（HTML）：打开按钮（软件内 iframe 显示，PRD AC9）。 */}
        {canOpen && (
          <Button variant="default" size="sm" onClick={() => onOpen(item)}>
            打开
          </Button>
        )}
      </div>
      <PluginManifestDialog
        open={manifestOpen}
        onOpenChange={setManifestOpen}
        pluginName={item.name}
        files={manifestFiles}
        fallback={{
          id: item.id,
          name: item.name,
          version: item.version,
          runtime_type: item.runtime,
          entry: item.entry,
          description: item.description,
        }}
      />
    </div>
  );
}

// 组C：本地持久化插件列表（从 scan_plugin_status 获取，独立于数据库插件列表）。
// 本地插件是「持久化目录扫描」的产物，与 PluginList（数据库/内置）分离展示，避免状态来源混淆。
function LocalPluginList({
  items,
  loading,
  onStart,
  onStop,
  onOpen,
  onRefresh,
}: {
  items: LocalPluginStatus[];
  loading: boolean;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onOpen: (item: LocalPluginStatus) => void;
  onRefresh: () => void;
}) {
  return (
    <Card className="w-full">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle>本地插件</CardTitle>
          <span className="text-xs text-muted-foreground">{items.length} 个（持久化目录）</span>
        </div>
        <Button variant="ghost" size="icon-sm" title="重新扫描本地插件状态" onClick={onRefresh}>
          <RefreshCwIcon className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          // 加载骨架：与数据库列表一致的 6 行占位。
          <div className="flex flex-col divide-y rounded-lg border">
            {Array.from({ length: PAGE_SIZE }).map((_, i) => <Shimmer key={i} className="h-14 w-full rounded-none" />)}
          </div>
        ) : items.length ? (
          <div className="flex flex-col divide-y rounded-lg border">
            {items.map((item) => (
              <LocalPluginItem
                key={item.id}
                item={item}
                onStart={onStart}
                onStop={onStop}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : (
          // 空状态：引导去创建插件（本地插件由 AI 生成器写入持久化目录）。
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <PackageIcon className="size-7 text-muted-foreground/50" />
            <span>还没有本地插件</span>
            <span className="text-xs">在创建器生成的插件会保存在这里，重启后仍可用。</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Plugins() {
  const { runningPlugin, setRunningPlugin, pinPlugin, unpinPlugin, isPinned, setView } = useApp();
  const [list, setList] = useState<LoadedPlugin[] | null>(null);
  const [error, setError] = useState<string>('');
  const [page, setPage] = useState(1);

  // 组C：本地持久化插件列表（文件系统扫描，动态状态）。
  const [localPlugins, setLocalPlugins] = useState<LocalPluginStatus[] | null>(null);
  const [localLoading, setLocalLoading] = useState(false);

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

  // 组C：扫描本地持久化插件（挂载 + runningPlugin 变化时刷新）。
  // scan 失败（Rust 命令未实现或目录读取失败）降级为空数组，不阻断数据库插件列表展示。
  const reloadLocal = () => {
    setLocalLoading(true);
    void scanPluginStatus()
      .then((items) => setLocalPlugins(items))
      .catch((caught) => {
        // scan 失败：保留上次结果（首次失败置空数组），不刷错误 toast（与数据库列表分离，降级静默）。
        setLocalPlugins((prev) => prev ?? []);
        toast.error(`扫描本地插件失败：${errorMessage(caught)}`);
      })
      .finally(() => setLocalLoading(false));
  };

  useEffect(() => {
    if (runningPlugin) return;
    reloadLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningPlugin]);

  if (runningPlugin) return <Runner plugin={runningPlugin} onBack={() => setRunningPlugin(null)} />;

  // 作者改价/切状态后重新拉取列表，刷新审核状态/价格/启用态角标。
  const reload = () => {
    void (async () => {
      const result = await loadPlugins();
      setError(result.error);
      setList(result.plugins);
      setPage(1);
    })();
  };

  // 组C：打开本地 HTML 插件（读取持久化目录的 entry 文件内容，复用 Runner 的 iframe 分支）。
  // 本地插件文件在 plugins_root/<pluginId>/，通过组A 的 read_local_plugin_file 读取 entry HTML，
  // 填入 adapted.files 让 Runner 的 loadPluginDocument 走 sdkShim + 插件 HTML 路径（与数据库插件一致）。
  // read_local_plugin_file 失败（Rust 未实现 / 文件缺失）回退占位 adapted（Runner 显示占位 HTML）。
  const openLocal = async (item: LocalPluginStatus) => {
    let files: LoadedPlugin['files'];
    try {
      const entryContent = await readLocalPluginFile(item.id, item.entry);
      files = [{ path: item.entry, content: entryContent }];
    } catch {
      // 读取失败：files 留空，Runner 的 loadPluginDocument 会渲染占位 HTML（不崩）。
      files = [];
    }
    const adapted: LoadedPlugin = {
      id: item.id,
      name: item.name,
      description: item.description,
      version: item.version,
      entry: item.entry,
      builtin: false,
      runtime_type: 'client',
      status: item.status,
      files,
    };
    setRunningPlugin(adapted);
  };

  // 组C：启动/停止本地脚本插件后刷新扫描，状态变 running/stopped 同步 Badge。
  const onLocalStart = (id: string) => {
    void startPlugin(id)
      .then(() => { toast.success('插件已启动，运行在独立进程'); reloadLocal(); })
      .catch((caught) => toast.error(`启动失败：${errorMessage(caught)}`));
  };
  const onLocalStop = (id: string) => {
    void stopPlugin(id)
      .then(() => { toast.success('插件已停止'); reloadLocal(); })
      .catch((caught) => toast.error(`停止失败：${errorMessage(caught)}`));
  };

  const total = list?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageItems = (list ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      {/* 组C：本地持久化插件列表（动态状态 + 运行/停止/打开 UI），置于数据库插件列表上方。
          PRD 需求 4：插件数据持久化，重启软件后还在，故本地插件是用户最常用的入口。 */}
      <LocalPluginList
        items={localPlugins ?? []}
        loading={localLoading}
        onStart={onLocalStart}
        onStop={onLocalStop}
        onOpen={openLocal}
        onRefresh={reloadLocal}
      />

      <Card className="w-full">
        <CardHeader>
          <CardTitle>我的插件</CardTitle>
        </CardHeader>
        <CardContent>
          {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
          {list === null ? (
            // 加载骨架：6 行（与单页条数一致）占位，替代「加载中…」纯文字。
            <div className="flex flex-col divide-y rounded-lg border">
              {Array.from({ length: PAGE_SIZE }).map((_, i) => <Shimmer key={i} className="h-14 w-full rounded-none" />)}
            </div>
          ) : total ? (
            <PluginList
              isPinned={isPinned}
              items={pageItems}
              onRun={setRunningPlugin}
              onAuthorChanged={reload}
              onTogglePin={(plugin, pinned) => (pinned ? unpinPlugin(plugin.id) : pinPlugin(plugin))}
              page={page}
              setPage={setPage}
              totalPages={totalPages}
            />
          ) : (
            !error && (
              // 空状态：图标 + 引导文案 + 两个去向，替代单行「暂无插件」。
              <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
                <PackageIcon className="size-8 text-muted-foreground/50" />
                <span>还没有可运行的插件</span>
                <span className="text-xs">创建一个新插件，或从市场安装一个。</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setView('home')}>去创建插件</Button>
                  <Button variant="outline" size="sm" onClick={() => setView('market')}>去市场安装</Button>
                </div>
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
