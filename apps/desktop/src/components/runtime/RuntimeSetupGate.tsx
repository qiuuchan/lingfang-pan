// RuntimeSetupGate.tsx — 首启运行时引导卡（task 07-03 Step 6）。
//
// 逻辑：
// - App 启动时调 getRuntimeStatus()；若 python AND node 都不可用（available=false）
//   且 localStorage 无 `lf:runtime-setup-done` 标记 → 显示全屏引导卡。
// - 引导卡：「一键下载 Python + Node」（顺序触发 downloadRuntime('python') + downloadRuntime('node')，
//   进度条用 DownloadProgress，订阅 event）+「跳过（仅用 HTML 插件）」。
// - 全部完成后写 localStorage `lf:runtime-setup-done` = '1' 并关闭。
// - 不阻塞：跳过后仍能用 client 插件；后续可去设置页重新下载。
//
// 挂载：App.tsx 登录后条件渲染（覆盖层）。本组件自管理状态。

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2Icon, CpuIcon, DownloadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
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
  RUNTIME_LABEL,
  downloadRuntime,
  getRuntimeStatus,
  onDownloadProgress,
  onDownloadStage,
  type DownloadStagePayload,
  type RuntimeKind,
  type RuntimeStatusMap,
} from '@/lib/runtime-config';
import { DownloadProgress } from './DownloadProgress';

const SETUP_DONE_KEY = 'lf:runtime-setup-done';
const SETUP_ORDER: RuntimeKind[] = ['python', 'nodejs'];

// RuntimeStatusMap 的 key 用 'node'（Rust serde），RuntimeKind 用 'nodejs'；映射互转。
const STATUS_KEY: Record<RuntimeKind, 'python' | 'node'> = { python: 'python', nodejs: 'node' };

interface DownloadState {
  stage: DownloadStagePayload['stage'];
  downloaded: number;
  total: number | null;
}

export function RuntimeSetupGate() {
  // 三态：'loading'（探测中）/ 'show'（需引导）/ 'hidden'（已就绪或已跳过）。
  const [gate, setGate] = useState<'loading' | 'show' | 'hidden'>('loading');
  const [statusMap, setStatusMap] = useState<RuntimeStatusMap | null>(null);
  const [downloadState, setDownloadState] = useState<Partial<Record<RuntimeKind, DownloadState>>>({});
  const [downloading, setDownloading] = useState<Partial<Record<RuntimeKind, boolean>>>({});
  const [batchRunning, setBatchRunning] = useState(false);

  // 判定是否需要展示：两运行时都不可用且未标记 done。
  const decideGate = useCallback((status: RuntimeStatusMap | null) => {
    if (!status) return 'hidden' as const;
    const bothMissing = !status.python.available && !status.node.available;
    if (!bothMissing) return 'hidden' as const;
    let done = false;
    try { done = localStorage.getItem(SETUP_DONE_KEY) === '1'; } catch { /* 忽略 */ }
    return done ? ('hidden' as const) : ('show' as const);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await getRuntimeStatus();
      setStatusMap(status);
      setGate(decideGate(status));
    } catch {
      // 探测失败不阻塞主流程，隐藏 gate。
      setGate('hidden');
    }
  }, [decideGate]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // 订阅下载 event：更新进度；done 刷新 status（statusMap 更新后若两运行时都就绪会触发 gate=hidden）。
  useEffect(() => {
    let unStage: (() => void) | undefined;
    let unProgress: (() => void) | undefined;
    let cancelled = false;
    onDownloadStage((payload) => {
      setDownloadState((prev) => ({
        ...prev,
        [payload.kind]: {
          stage: payload.stage,
          downloaded: prev[payload.kind]?.downloaded ?? 0,
          total: prev[payload.kind]?.total ?? null,
        },
      }));
      if (payload.stage === 'done') {
        setDownloading((prev) => ({ ...prev, [payload.kind]: false }));
        toast.success(`${RUNTIME_LABEL[payload.kind]} 已就绪`);
        void refreshStatus();
      } else if (payload.stage === 'failed') {
        setDownloading((prev) => ({ ...prev, [payload.kind]: false }));
        setBatchRunning(false);
        toast.error(`${RUNTIME_LABEL[payload.kind]} 下载失败，请检查网络后重试`);
      }
    })
      .then((fn) => { if (cancelled) fn(); else unStage = fn; })
      .catch(() => { /* 无 Tauri 壳忽略 */ });
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
      .then((fn) => { if (cancelled) fn(); else unProgress = fn; })
      .catch(() => { /* 忽略 */ });
    return () => {
      cancelled = true;
      unStage?.();
      unProgress?.();
    };
  }, [refreshStatus]);

  // statusMap 更新后，若两运行时都就绪 → 写 done 标记并隐藏。
  useEffect(() => {
    if (gate !== 'show') return;
    if (statusMap && statusMap.python.available && statusMap.node.available) {
      try { localStorage.setItem(SETUP_DONE_KEY, '1'); } catch { /* 忽略 */ }
      setGate('hidden');
    }
  }, [statusMap, gate]);

  // 一键下载：顺序触发 python + node。
  const handleDownloadAll = useCallback(async () => {
    setBatchRunning(true);
    for (const kind of SETUP_ORDER) {
      setDownloading((prev) => ({ ...prev, [kind]: true }));
      setDownloadState((prev) => ({ ...prev, [kind]: { stage: 'downloading', downloaded: 0, total: null } }));
      try {
        await downloadRuntime(kind);
        // 成功 resolve 后由 done event 刷新 status；继续下一个。
      } catch (err) {
        setDownloading((prev) => ({ ...prev, [kind]: false }));
        setDownloadState((prev) => ({ ...prev, [kind]: { stage: 'failed', downloaded: 0, total: null } }));
        toast.error(errorMessage(err, `${RUNTIME_LABEL[kind]} 下载失败`));
        setBatchRunning(false);
        return;
      }
    }
    setBatchRunning(false);
  }, []);

  const handleSkip = useCallback(() => {
    try { localStorage.setItem(SETUP_DONE_KEY, '1'); } catch { /* 忽略 */ }
    setGate('hidden');
  }, []);

  if (gate !== 'show') return null;

  return (
    <Dialog open onOpenChange={() => { /* 不允许外点关闭，强制走按钮 */ }}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader {...dragRegionProps}>
          <DialogTitle className="flex items-center gap-2 text-base" data-tauri-drag-region>
            <CpuIcon className="size-4 text-primary" />
            准备脚本运行环境
          </DialogTitle>
          <DialogDescription>
            下载便携版 Python 与 Node.js（约 200MB），用于运行 Python/Node 插件。你也可以之后在设置页下载。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {SETUP_ORDER.map((kind) => {
            const ds = downloadState[kind];
            const isDownloading = Boolean(downloading[kind]);
            return (
              <div key={kind} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{RUNTIME_LABEL[kind]}</span>
                  <span className="text-xs text-muted-foreground">
                    {ds?.stage === 'done'
                      ? '已就绪'
                      : isDownloading
                        ? '下载中'
                        : statusMap?.[STATUS_KEY[kind]]?.available
                          ? '已就绪'
                          : '未安装'}
                  </span>
                </div>
                {ds && isDownloading ? (
                  <DownloadProgress
                    kind={kind}
                    stage={ds.stage}
                    downloaded={ds.downloaded}
                    total={ds.total}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          跳过后仍可使用 HTML（client）插件；Python/Node 插件需运行时才能运行。
        </p>

        <DialogFooter>
          <Button variant="ghost" disabled={batchRunning} onClick={handleSkip}>
            跳过（仅用 HTML 插件）
          </Button>
          <LoadingButton loading={batchRunning} onClick={() => { void handleDownloadAll(); }}>
            {batchRunning ? <Loader2Icon className="size-4 animate-spin" /> : <DownloadIcon />}
            一键下载 Python + Node
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
