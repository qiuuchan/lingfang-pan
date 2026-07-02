import { useState } from 'react';
import { toast } from 'sonner';
import { PinIcon, PinOffIcon, RefreshCwIcon, InfoIcon, PlayIcon, SquareIcon, DownloadIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import { PluginManifestDialog } from '@/components/PluginManifestDialog';
import { fmtYuan } from '@/lib/money';
import { installMarketplacePluginPackage } from '@/lib/plugin-installation';
import { stopPlugin } from '@/lib/plugin-status';
import { errorMessage } from '../plugins-runtime';
import type { DraftFile, LoadedPlugin } from '@/lib/types';
import {
  isAuthorManaged,
  PluginDeleteDialog,
  PluginMetaEditDialog,
  PluginPriceEditDialog,
  PluginStatusToggle,
  PluginSubmitDialog,
} from '@/components/plugins/author-actions';

const SOURCE_LABEL: Record<NonNullable<LoadedPlugin['source']>, string> = {
  published: '已发布',
  installed: '已安装',
  builtin: '内置',
  platform: '平台',
  team: '团队共享',
  marketplace: '市场',
};

const REVIEW_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
};

const RUNTIME_LABEL: Record<NonNullable<LoadedPlugin['runtime_type']>, string> = {
  client: '客户端',
  nodejs: 'Node.js',
  python: 'Python',
  cloud: '云端',
};

export function TeamPluginRow({
  isPinned,
  isRunning,
  onChanged,
  onRun,
  onStopped,
  onTogglePin,
  onUpdate,
  plugin,
}: {
  isPinned: boolean;
  /** 该插件是否正在运行（client/cloud 由 runningPlugin overlay 接管；nodejs/python 由进程表）。 */
  isRunning: boolean;
  onChanged: () => void;
  onRun: (plugin: LoadedPlugin) => void;
  /** nodejs/python 插件停止后刷新列表状态。 */
  onStopped: () => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  /** 更新插件到最新版（仅已安装且有新版时传入）。 */
  onUpdate?: (plugin: LoadedPlugin) => void;
  plugin: LoadedPlugin;
}) {
  const source = pluginSource(plugin);
  const authorManaged = isAuthorManaged(plugin);
  const isDisabled = plugin.status === 'DISABLED';
  // 有更新：已安装且云端版本 > 已安装版本。
  const hasUpdate = Boolean(plugin.installedVersion && isVersionNewer(plugin.version, plugin.installedVersion));
  const runtime = plugin.runtime_type || 'client';
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      <TeamPluginSummary authorManaged={authorManaged} isDisabled={isDisabled} plugin={plugin} runtime={runtime} source={source} />
      <TeamPluginActions
        authorManaged={authorManaged}
        hasUpdate={hasUpdate}
        isDisabled={isDisabled}
        isPinned={isPinned}
        isRunning={isRunning}
        onChanged={onChanged}
        onRun={onRun}
        onStopped={onStopped}
        onTogglePin={onTogglePin}
        onUpdate={onUpdate}
        plugin={plugin}
      />
    </div>
  );
}

function TeamPluginSummary({
  authorManaged,
  isDisabled,
  plugin,
  runtime,
  source,
}: {
  authorManaged: boolean;
  isDisabled: boolean;
  plugin: LoadedPlugin;
  runtime: NonNullable<LoadedPlugin['runtime_type']>;
  source: NonNullable<LoadedPlugin['source']>;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{plugin.name}</span>
          <Badge variant={source === 'builtin' ? 'secondary' : 'outline'} className="shrink-0">{SOURCE_LABEL[source]}</Badge>
          <Badge variant="outline" className="shrink-0 text-xs">{RUNTIME_LABEL[runtime]}</Badge>
          <ReviewBadge authorManaged={authorManaged} plugin={plugin} />
          <PriceBadge authorManaged={authorManaged} plugin={plugin} />
          {authorManaged && isDisabled && <Badge variant="destructive" className="shrink-0 text-xs">已禁用</Badge>}
        </div>
        <div className="truncate text-sm text-muted-foreground">{plugin.description || '—'}</div>
      </div>
    </div>
  );
}

function ReviewBadge({ authorManaged, plugin }: { authorManaged: boolean; plugin: LoadedPlugin }) {
  if (!authorManaged || !plugin.reviewStatus) return null;
  return (
    <Badge variant={plugin.reviewStatus === 'APPROVED' ? 'secondary' : 'outline'} className="shrink-0 text-xs">
      {REVIEW_LABEL[plugin.reviewStatus] || plugin.reviewStatus}
    </Badge>
  );
}

function PriceBadge({ authorManaged, plugin }: { authorManaged: boolean; plugin: LoadedPlugin }) {
  if (!authorManaged || typeof plugin.priceCents !== 'number') return null;
  return (
    <Badge variant={plugin.priceCents > 0 ? 'default' : 'secondary'} className="shrink-0 text-xs">
      {fmtYuan(plugin.priceCents)}
    </Badge>
  );
}

function TeamPluginActions({
  authorManaged,
  hasUpdate,
  isDisabled,
  isPinned,
  isRunning,
  onChanged,
  onRun,
  onStopped,
  onTogglePin,
  onUpdate,
  plugin,
}: {
  authorManaged: boolean;
  hasUpdate: boolean;
  isDisabled: boolean;
  isPinned: boolean;
  isRunning: boolean;
  onChanged: () => void;
  onRun: (plugin: LoadedPlugin) => void;
  onStopped: () => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  onUpdate?: (plugin: LoadedPlugin) => void;
  plugin: LoadedPlugin;
}) {
  const [updating, setUpdating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoFiles, setInfoFiles] = useState<DraftFile[]>([]);

  const runtime = plugin.runtime_type || 'client';
  // 是否可运行：后端为本团队 / 内置 / 已安装的插件下发 files（plugin-package.ts:213）。
  // 其余插件（其他团队未安装）无 files，脚本类无法运行——引导先安装。
  const hasFiles = Boolean(plugin.files?.length);
  const canRun = hasFiles || plugin.builtin || plugin.source === 'team' || runtime === 'client' || runtime === 'cloud';

  // nodejs/python 独立进程可经 stopPlugin 停止（id 与落盘目录一致）；client/cloud 由 runningPlugin overlay 接管。
  const isScriptRuntime = runtime === 'nodejs' || runtime === 'python';

  async function openInfo() {
    // files 已随插件下发则直接展示；否则尝试从本地落盘目录读 manifest.json。
    if (!plugin.files?.length) {
      try {
        const content = await readLocalManifest(plugin.id);
        setInfoFiles(content ? [{ path: 'manifest.json', content }] : []);
      } catch {
        setInfoFiles([]);
      }
    } else {
      setInfoFiles(plugin.files.filter((f) => f.path === 'manifest.json'));
    }
    setInfoOpen(true);
  }

  async function stopRun() {
    setStopping(true);
    try {
      await stopPlugin(plugin.id);
      toast.success('插件已停止');
      onStopped();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setStopping(false);
    }
  }

  async function installThenRun() {
    // 未安装（其他团队插件无 files）：先安装落盘，再刷新后运行。
    setInstalling(true);
    try {
      await installMarketplacePluginPackage(plugin.id);
      toast.success(`已安装「${plugin.name}」`);
      onChanged();
      onRun(plugin);
    } catch (e) {
      toast.error(`安装失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {authorManaged && <PluginMetaEditDialog plugin={plugin} onSaved={onChanged} />}
      {authorManaged && <PluginPriceEditDialog plugin={plugin} onSaved={onChanged} />}
      {authorManaged && <PluginSubmitDialog plugin={plugin} onSubmitted={onChanged} />}
      {authorManaged && <PluginStatusToggle plugin={plugin} onToggled={onChanged} />}
      {authorManaged && <PluginDeleteDialog plugin={plugin} onDeleted={onChanged} />}
      {/* 有新版可更新：显示更新按钮（带最新版本号）。非作者也能更新自己安装的插件。 */}
      {hasUpdate && onUpdate && (
        <LoadingButton
          variant="outline"
          size="sm"
          loading={updating}
          className="h-7 gap-1.5 border-blue-500/40 px-2.5 text-xs text-blue-600 hover:bg-blue-500/5 dark:text-blue-400"
          onClick={async () => {
            setUpdating(true);
            try { await onUpdate(plugin); } finally { setUpdating(false); }
          }}
          title={`更新到 v${plugin.version}（当前 v${plugin.installedVersion}）`}
        >
          <RefreshCwIcon className="size-3" />
          更新 v{plugin.version}
        </LoadingButton>
      )}
      <span className="ml-1 text-xs text-muted-foreground">v{plugin.version}</span>
      <Button variant="ghost" size="icon-sm" onClick={openInfo} title="查看插件信息">
        <InfoIcon className="size-3.5" />
      </Button>
      {/* 运行中的脚本插件：便捷「停止」（client/cloud 运行由 runningPlugin overlay 接管，停止=关 overlay，不在此显示）。 */}
      {isRunning && isScriptRuntime && (
        <LoadingButton variant="destructive" size="sm" loading={stopping} onClick={stopRun}>
          <SquareIcon className="size-3.5" />停止
        </LoadingButton>
      )}
      {/* 运行/打开：已安装或本团队/内置可直接运行；其他团队未安装脚本类引导先安装。 */}
      {isDisabled ? (
        <Button variant="outline" size="sm" disabled title="插件已被作者禁用">已禁用</Button>
      ) : canRun ? (
        <Button variant="default" size="sm" onClick={() => onRun(plugin)} title={isRunning ? '已在运行，点击切到运行窗口' : '运行插件'}>
          <PlayIcon className="size-3.5" />{isRunning ? '运行中' : '运行'}
        </Button>
      ) : (
        <LoadingButton variant="outline" size="sm" loading={installing} onClick={installThenRun} title="先安装到本地再运行">
          <DownloadIcon className="size-3.5" />安装后运行
        </LoadingButton>
      )}
      <PinButton isPinned={isPinned} onClick={() => onTogglePin(plugin, isPinned)} />
      <PluginManifestDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        pluginName={plugin.name}
        files={infoFiles}
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

function PinButton({ isPinned, onClick }: { isPinned: boolean; onClick: () => void }) {
  return (
    <Button
      variant={isPinned ? 'secondary' : 'ghost'}
      size="icon-sm"
      title={isPinned ? '已固定到侧边栏，点击取消' : '固定到侧边栏'}
      onClick={onClick}
    >
      {isPinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
    </Button>
  );
}

function pluginSource(plugin: LoadedPlugin): NonNullable<LoadedPlugin['source']> {
  return plugin.source || (plugin.builtin ? 'builtin' : 'published');
}

/** 读本地落盘 manifest.json（团队插件已 ensurePluginPackagePersisted 时存在）。无则返回 null。 */
async function readLocalManifest(pluginId: string): Promise<string | null> {
  try {
    const { readLocalPluginFile } = await import('@/lib/plugin-status');
    return await readLocalPluginFile(pluginId, 'manifest.json');
  } catch {
    return null;
  }
}

/** 语义版本比较：newVer 是否严格大于 oldVer（x.y.z）。非法格式按 0.0.0 处理。 */
function isVersionNewer(newVer: string, oldVer: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const [a1, a2, a3] = parse(newVer);
  const [b1, b2, b3] = parse(oldVer);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
