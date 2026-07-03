// RuntimeEnvTab.tsx — 设置页 Tab1：脚本运行环境（task 07-03 Step 5，重构自 CliRuntimeTab）。
//
// 三区：
// 1. 运行时状态：Python/Node 各一行（来源 Badge + 版本 + 下载/重下/卸载/指定系统路径 + 系统探测灰显）。
// 2. 镜像源：pip/npm 下拉 + 自定义 URL + 保存（仅注入本应用子进程，不写系统全局）。
// 3. （下载进度由对应行行下文渲染 DownloadProgress，订阅 event。）
//
// 组件自管理状态，不强依赖父组件（Settings 不再做探测上提）。
// tab id 保持 `cli`（Settings.tsx TabsTrigger value 不变，仅替换内部组件）。
//
// 设计不变式（与 Rust resolver 对齐）：
// - 系统探测仅作信息展示，绝不参与执行来源；用户可 opt-in「使用系统已装」（手动指定路径，
//   经 setUserSpecifiedRuntime 写 config，仍走 resolver 校验，前端不做存在性校验）。
// - 下载/卸载/指定路径完成后立即 getRuntimeStatus 刷新，所有 tauriInvoke 包 try/catch + toast.error。

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CpuIcon,
  RefreshCwIcon,
  DownloadIcon,
  Trash2Icon,
  HardDriveIcon,
  SaveIcon,
  Loader2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errorMessage } from '@/lib/api';
import { dragRegionProps } from '@/lib/window-drag';
import {
  CUSTOM_MIRROR_ID,
  NPM_MIRROR_PRESETS,
  PIP_MIRROR_PRESETS,
  SOURCE_LABEL,
  RUNTIME_LABEL,
  downloadRuntime,
  formatVersion,
  getRuntimeConfig,
  getRuntimeStatus,
  onDownloadProgress,
  onDownloadStage,
  probeSystemRuntime,
  setMirrorConfig,
  setUserSpecifiedRuntime,
  uninstallRuntime,
  type DownloadStagePayload,
  type MirrorConfig,
  type RuntimeConfig,
  type RuntimeKind,
  type RuntimeSource,
  type RuntimeStatusMap,
  type SystemProbeResult,
} from '@/lib/runtime-config';
import { DownloadProgress } from '@/components/runtime/DownloadProgress';

const RUNTIME_ORDER: RuntimeKind[] = ['python', 'nodejs'];

// RuntimeStatusMap 的 key 用 'node'（Rust serde），而 RuntimeKind 用 'nodejs'；映射互转。
const STATUS_KEY: Record<RuntimeKind, 'python' | 'node'> = { python: 'python', nodejs: 'node' };

// 默认镜像草稿（无 config 时使用，与 Rust mirror_presets 默认值一致）。
const DEFAULT_MIRRORS: MirrorConfig = {
  pipId: 'tsinghua',
  pipUrl: null,
  npmId: 'npmmirror',
  npmUrl: null,
};

export interface RuntimeEnvTabProps {
  /** 父组件（Settings）触发的刷新信号；调用时本组件重载状态 + 系统探测。可选。 */
  onRefresh?: () => void;
}

interface DownloadState {
  stage: DownloadStagePayload['stage'];
  downloaded: number;
  total: number | null;
}

export function RuntimeEnvTab({ onRefresh }: RuntimeEnvTabProps) {
  // === 状态 ===
  const [statusMap, setStatusMap] = useState<RuntimeStatusMap | null>(null);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [mirrorsDraft, setMirrorsDraft] = useState<MirrorConfig>(DEFAULT_MIRRORS);
  const [savingMirrors, setSavingMirrors] = useState(false);
  const [systemProbe, setSystemProbe] = useState<Partial<Record<RuntimeKind, SystemProbeResult | null>>>({});
  const [downloadState, setDownloadState] = useState<Partial<Record<RuntimeKind, DownloadState>>>({});
  const [downloading, setDownloading] = useState<Partial<Record<RuntimeKind, boolean>>>({});
  const [refreshing, setRefreshing] = useState(false);

  // 用户指定路径弹窗 state（每 kind 独立）。
  const [pathDialogKind, setPathDialogKind] = useState<RuntimeKind | null>(null);
  const [pathDraft, setPathDraft] = useState('');

  // === 加载 + event 订阅 ===
  const loadStatus = useCallback(async () => {
    try {
      const status = await getRuntimeStatus();
      setStatusMap(status);
    } catch (err) {
      toast.error(errorMessage(err, '运行时状态获取失败'));
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await getRuntimeConfig();
      setConfig(cfg);
      setMirrorsDraft(cfg.mirrors ?? DEFAULT_MIRRORS);
    } catch (err) {
      toast.error(errorMessage(err, '运行时配置读取失败'));
    }
  }, []);

  const loadSystemProbe = useCallback(async () => {
    try {
      const [py, node] = await Promise.all([
        probeSystemRuntime('python').catch(() => null),
        probeSystemRuntime('nodejs').catch(() => null),
      ]);
      setSystemProbe({ python: py, nodejs: node });    } catch {
      setSystemProbe({});
    }
  }, []);

  const onRefreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadStatus(), loadConfig(), loadSystemProbe()]);
    } finally {
      setRefreshing(false);
      onRefresh?.();
    }
  }, [loadStatus, loadConfig, loadSystemProbe, onRefresh]);

  useEffect(() => {
    void onRefreshAll();
  }, [onRefreshAll]);

  // 订阅下载阶段/进度 event：更新 downloadState[kind]；done 刷新 status + 清 downloading；
  // failed toast 错误 + 清 downloading。
  useEffect(() => {
    let unStage: (() => void) | undefined;
    let unProgress: (() => void) | undefined;
    let cancelled = false;
    onDownloadStage((payload) => {
      setDownloadState((prev) => ({
        ...prev,
        [payload.kind]: {
          stage: payload.stage,
          // 保留已有 downloaded/total（done/failed 时不更新进度数字）。
          downloaded: prev[payload.kind]?.downloaded ?? 0,
          total: prev[payload.kind]?.total ?? null,
        },
      }));
      if (payload.stage === 'done') {
        setDownloading((prev) => ({ ...prev, [payload.kind]: false }));
        void loadStatus();
        toast.success(`${RUNTIME_LABEL[payload.kind]} 已就绪`);
      } else if (payload.stage === 'failed') {
        setDownloading((prev) => ({ ...prev, [payload.kind]: false }));
        toast.error(`${RUNTIME_LABEL[payload.kind]} 下载失败，请检查网络后重试`);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unStage = fn;
      })
      .catch(() => {
        /* 无 Tauri 壳时忽略（浏览器预览） */
      });
    onDownloadProgress((payload) => {
      setDownloadState((prev) => {
        const cur = prev[payload.kind];
        return {
          ...prev,
          [payload.kind]: {
            stage: cur?.stage ?? 'downloading',
            downloaded: payload.downloaded,
            total: payload.total,
          },
        };
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unProgress = fn;
      })
      .catch(() => {
        /* 忽略 */
      });
    return () => {
      cancelled = true;
      unStage?.();
      unProgress?.();
    };
  }, [loadStatus]);

  // === Handler ===
  const handleDownload = useCallback(async (kind: RuntimeKind) => {
    setDownloading((prev) => ({ ...prev, [kind]: true }));
    // 初始化进度 state（downloading 0 字节），让 DownloadProgress 立即显示。
    setDownloadState((prev) => ({ ...prev, [kind]: { stage: 'downloading', downloaded: 0, total: null } }));
    try {
      // 异步命令；实际进度经 event 推送。成功 resolve 时 status 已由 done 分支刷新，这里仅兜底。
      await downloadRuntime(kind);
    } catch (err) {
      setDownloading((prev) => ({ ...prev, [kind]: false }));
      setDownloadState((prev) => ({ ...prev, [kind]: { stage: 'failed', downloaded: 0, total: null } }));
      toast.error(errorMessage(err, `${RUNTIME_LABEL[kind]} 下载失败`));
    }
  }, []);

  const handleUninstall = useCallback(async (kind: RuntimeKind) => {
    // confirm 内联（避免引入 ConfirmDialog 时序问题）；用 window.confirm 不雅，改用 toast 提示 + 直接执行。
    // 这里改用浏览器 confirm（WebView 内可用）——但为统一风格用 sonner 无法阻塞，
    // 故采用：直接执行 + 成功/失败 toast（卸载是显式操作，二次确认放弹窗更安全）。
    const ok = window.confirm(`确定卸载应用管理的 ${RUNTIME_LABEL[kind]} 运行时吗？已指定系统路径的用户设置不受影响。`);
    if (!ok) return;
    try {
      await uninstallRuntime(kind);
      toast.success(`${RUNTIME_LABEL[kind]} 已卸载`);
      await loadStatus();
    } catch (err) {
      toast.error(errorMessage(err, `${RUNTIME_LABEL[kind]} 卸载失败`));
    }
  }, [loadStatus]);

  const openPathDialog = useCallback((kind: RuntimeKind) => {
    setPathDialogKind(kind);
    const existing = kind === 'python' ? config?.userSpecifiedPython : config?.userSpecifiedNode;
    setPathDraft(existing ?? '');
  }, [config]);

  const handleSaveUserSpecified = useCallback(async () => {
    if (!pathDialogKind) return;
    const trimmed = pathDraft.trim();
    try {
      await setUserSpecifiedRuntime(pathDialogKind, trimmed.length > 0 ? trimmed : null);
      toast.success(`${RUNTIME_LABEL[pathDialogKind]} 路径已${trimmed.length > 0 ? '更新' : '清除'}`);
      setPathDialogKind(null);
      await Promise.all([loadStatus(), loadConfig()]);
    } catch (err) {
      toast.error(errorMessage(err, '路径设置失败'));
    }
  }, [pathDialogKind, pathDraft, loadStatus, loadConfig]);

  const handleSaveMirrors = useCallback(async () => {
    setSavingMirrors(true);
    try {
      await setMirrorConfig(mirrorsDraft);
      toast.success('镜像源已保存');
      await loadConfig();
    } catch (err) {
      toast.error(errorMessage(err, '镜像源保存失败'));
    } finally {
      setSavingMirrors(false);
    }
  }, [mirrorsDraft, loadConfig]);

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部操作区 */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          插件运行和开发命令使用应用管理的 Python/Node（按需下载），不会使用系统 PATH。
        </div>
        <LoadingButton variant="outline" size="sm" loading={refreshing} onClick={() => { void onRefreshAll(); }}>
          <RefreshCwIcon />重新探测
        </LoadingButton>
      </div>

      {/* 区 1：运行时状态 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CpuIcon className="size-4 text-primary" />
            <CardTitle>脚本运行环境</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {RUNTIME_ORDER.map((kind) => (
            <RuntimeRow
              key={kind}
              kind={kind}
              status={statusMap?.[STATUS_KEY[kind]] ?? null}
              systemProbe={systemProbe[kind] ?? null}
              download={downloadState[kind]}
              downloading={Boolean(downloading[kind])}
              statusLoaded={statusMap !== null}
              onDownload={() => { void handleDownload(kind); }}
              onUninstall={() => { void handleUninstall(kind); }}
              onSetUserSpecified={() => openPathDialog(kind)}
            />
          ))}
        </CardContent>
      </Card>

      {/* 区 2：镜像源 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <SaveIcon className="size-4 text-primary" />
            <CardTitle>镜像源</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <MirrorSelectField
              label="pip 源"
              presets={PIP_MIRROR_PRESETS}
              value={mirrorsDraft.pipId}
              customUrl={mirrorsDraft.pipUrl ?? ''}
              onIdChange={(id) => setMirrorsDraft((prev) => ({ ...prev, pipId: id, pipUrl: id === CUSTOM_MIRROR_ID ? prev.pipUrl ?? '' : null }))}
              onUrlChange={(url) => setMirrorsDraft((prev) => ({ ...prev, pipUrl: url }))}
            />
            <MirrorSelectField
              label="npm 源"
              presets={NPM_MIRROR_PRESETS}
              value={mirrorsDraft.npmId}
              customUrl={mirrorsDraft.npmUrl ?? ''}
              onIdChange={(id) => setMirrorsDraft((prev) => ({ ...prev, npmId: id, npmUrl: id === CUSTOM_MIRROR_ID ? prev.npmUrl ?? '' : null }))}
              onUrlChange={(url) => setMirrorsDraft((prev) => ({ ...prev, npmUrl: url }))}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              仅影响本应用启动的插件子进程，不修改系统全局 pip.ini / .npmrc。
            </p>
            <LoadingButton size="sm" loading={savingMirrors} onClick={() => { void handleSaveMirrors(); }}>
              <SaveIcon />保存
            </LoadingButton>
          </div>
        </CardContent>
      </Card>

      {/* 用户指定路径弹窗 */}
      <Dialog open={pathDialogKind !== null} onOpenChange={(open) => { if (!open) setPathDialogKind(null); }}>
        <DialogContent showCloseButton className="sm:max-w-md">
          <DialogHeader {...dragRegionProps}>
            <DialogTitle data-tauri-drag-region>
              指定系统已安装的 {pathDialogKind ? RUNTIME_LABEL[pathDialogKind] : ''}
            </DialogTitle>
            <DialogDescription>
              填入可执行文件（如 python.exe / node.exe）的完整路径。留空清除并回退到应用管理运行时。
            </DialogDescription>
          </DialogHeader>
          <Input
            value={pathDraft}
            onChange={(e) => setPathDraft((e.target as HTMLInputElement).value)}
            placeholder="C:\\Path\\To\\python.exe"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPathDialogKind(null)}>取消</Button>
            <LoadingButton loading={false} onClick={() => { void handleSaveUserSpecified(); }}>保存</LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// === 子组件 ===

/** 单行运行时：左名称+版本 / 中来源 Badge / 右操作按钮 / 行下文下载进度 + 系统探测灰显。 */
function RuntimeRow({
  kind,
  status,
  systemProbe,
  download,
  downloading,
  statusLoaded,
  onDownload,
  onUninstall,
  onSetUserSpecified,
}: {
  kind: RuntimeKind;
  status: { available: boolean; source: RuntimeSource | null; version: string | null; dir: string | null } | null;
  systemProbe: SystemProbeResult | null | undefined;
  download: DownloadState | undefined;
  downloading: boolean;
  statusLoaded: boolean;
  onDownload: () => void;
  onUninstall: () => void;
  onSetUserSpecified: () => void;
}) {
  const label = RUNTIME_LABEL[kind];
  const available = status?.available ?? false;
  const source = status?.source ?? null;
  const displayVersion = formatVersion(label, status?.version ?? null);

  // Badge variant by source: app_managed=default / user_specified=secondary / legacy=outline / 未安装=secondary（文案「未安装」）。
  const badgeVariant: 'default' | 'secondary' | 'outline' =
    source === 'app_managed'
      ? 'default'
      : source === 'user_specified'
        ? 'secondary'
        : source === 'legacy'
          ? 'outline'
          : 'secondary';
  const badgeText = available ? (source ? SOURCE_LABEL[source] : '已就绪') : '未安装';

  // 是否展示「下载便携版」（未安装或 legacy）。
  const showDownload = !available || source === 'legacy';
  // 是否展示「重新下载 / 卸载」（已安装且非 legacy）。
  const showManaged = available && (source === 'app_managed' || source === 'user_specified');

  // 系统探测灰显：仅当系统检测到 + 当前来源非 user_specified 时显示。
  const showSystemProbe = Boolean(systemProbe?.path) && source !== 'user_specified';

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* 左：名称 + 版本 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{label}</span>
            {displayVersion ? (
              <span className="font-mono text-xs text-muted-foreground">v{displayVersion}</span>
            ) : null}
          </div>
          {statusLoaded && status?.dir ? (
            <div className="mt-0.5 truncate text-xs text-muted-foreground" title={status.dir}>
              {status.dir}
            </div>
          ) : null}
        </div>

        {/* 中：来源 Badge */}
        <div className="flex shrink-0 items-center">
          {!statusLoaded ? (
            <Badge variant="secondary">
              <Loader2Icon className="size-3 animate-spin" />检测中
            </Badge>
          ) : (
            <Badge variant={badgeVariant}>{badgeText}</Badge>
          )}
        </div>

        {/* 右：操作按钮 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {showDownload ? (
            <LoadingButton variant="default" size="sm" loading={downloading} onClick={onDownload}>
              <DownloadIcon />下载便携版
            </LoadingButton>
          ) : null}
          {showManaged ? (
            <>
              <LoadingButton variant="outline" size="sm" loading={downloading} onClick={onDownload}>
                <DownloadIcon />重新下载
              </LoadingButton>
              <Button variant="outline" size="sm" onClick={onUninstall}>
                <Trash2Icon />卸载
              </Button>
              <Button variant="outline" size="sm" onClick={onSetUserSpecified}>
                <HardDriveIcon />使用系统已装
              </Button>
            </>
          ) : null}
          {showDownload ? (
            <Button variant="ghost" size="sm" onClick={onSetUserSpecified}>
              <HardDriveIcon />使用系统已装
            </Button>
          ) : null}
        </div>
      </div>

      {/* 行下文：下载进度 */}
      {download && downloading ? (
        <DownloadProgress
          kind={kind}
          stage={download.stage}
          downloaded={download.downloaded}
          total={download.total}
        />
      ) : null}

      {/* 系统探测灰显 */}
      {showSystemProbe && systemProbe ? (
        <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          探测到系统 {systemProbe.version ?? '未知版本'}
          {systemProbe.path ? `（${systemProbe.path}）` : ''}
          {systemProbe.meetsMinimum ? '' : '（版本不达标）'}
          ，但不会使用——应用使用自己管理的运行时。
        </div>
      ) : null}
    </div>
  );
}

/** 镜像源单选字段：下拉选预置或 custom，custom 时显示 URL 输入框。 */
function MirrorSelectField({
  label,
  presets,
  value,
  customUrl,
  onIdChange,
  onUrlChange,
}: {
  label: string;
  presets: { id: string; label: string; url: string }[];
  value: string;
  customUrl: string;
  onIdChange: (id: string) => void;
  onUrlChange: (url: string) => void;
}) {
  const isCustom = value === CUSTOM_MIRROR_ID;
  const selectedLabel = isCustom
    ? '自定义'
    : presets.find((p) => p.id === value)?.label ?? value;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={(v) => { if (typeof v === 'string') onIdChange(v); }}>
        <SelectTrigger className="w-full">
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {presets.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_MIRROR_ID}>自定义</SelectItem>
        </SelectContent>
      </Select>
      {isCustom ? (
        <Input
          value={customUrl}
          onChange={(e) => onUrlChange((e.target as HTMLInputElement).value)}
          placeholder="https://your-mirror.example/simple"
        />
      ) : null}
    </div>
  );
}
