// Settings.tsx — 设置页。
//
// - cli：软件内置运行环境的只读状态（RuntimeEnvTab）。
// - gateway：模型与计费信息。
// - updates：检查更新与更新日志。
//
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCwIcon, HistoryIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useApp } from '@/App';
import { errorMessage } from '@/lib/api';
import {
  checkUpdate,
  clearCachedUpdate,
  downloadUpdate,
  loadCachedUpdate,
  loadUpdateChannel,
  saveCachedUpdate,
  saveUpdateChannel,
  type CachedUpdate,
  type UpdateChannel,
  type UpdateMetadata,
} from '@/lib/updater';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Markdown } from '@/components/markdown';
import { ChangelogDialog } from '@/components/ChangelogDialog';
import { RuntimeEnvTab } from './settings/RuntimeEnvTab';
import { BillingTab } from './settings/BillingTab';
import { PluginsTab } from './settings/PluginsTab';
import { GeneralTab } from './settings/GeneralTab';
import { AboutTab } from './settings/AboutTab';
import { Checkbox } from '@/components/ui/checkbox';
import { dragRegionProps } from '@/lib/window-drag';

// 字节数转人类可读（design §3.3：total 未知时显示已下载量）。
// 二进制单位（1024），保留 1 位小数。
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// 秒数转人类可读时长（下载 ETA：≥60s 显示「N 分 N 秒」，否则「N 秒」；过长给「超过 1 小时」兜底）。
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '即将完成';
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m} 分 ${rem} 秒` : `${m} 分`;
  return '超过 1 小时';
}

export function Settings({
  // 受控 Tab：默认 'cli'，支持父组件（如新手任务清单「去设置 → 模型与计费」）定向跳转。
  value,
  onValueChange,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const { backendUrl } = useApp();
  // 当前激活 Tab（用于动画 key）：受控时用 value，否则用内部 state。
  const [internalTab, setInternalTab] = useState('cli');
  const currentTab = value !== undefined ? value : internalTab;

  // === Tab3 检查更新 state（design §3.2） ===
  // checking：检查中态；updateMeta：非 null 时弹更新 Dialog；updateInstalling：下载安装中（锁 Dialog）。
  // progress：下载进度（total 为 Content-Length，未知则 null；downloaded 为已累计字节数）。
  const [checking, setChecking] = useState(false);
  const [updateMeta, setUpdateMeta] = useState<UpdateMetadata | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({
    downloaded: 0,
    total: null,
  });
  // 更新日志悬浮窗（ChangelogDialog）：检查更新卡片下方「查看更新日志」按钮触发。
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>(() => loadUpdateChannel());
  // 缓存的可用更新（启动/手动检查写入 localStorage）：设置页挂载即读，无需重新请求后端即可一键更新。
  const [cachedUpdate, setCachedUpdate] = useState<CachedUpdate | null>(() => loadCachedUpdate());
  // 下载失败标记：置 true 后 Dialog 主按钮文案变「重试下载」（updateMeta 仍在，无需重新检查）。
  const [downloadFailed, setDownloadFailed] = useState(false);
  // 下载起始时间戳（算速度/ETA 用），Started 事件时记录。
  const downloadStartedAtRef = useRef<number | null>(null);

  // === 检查更新逻辑（design §3.2） ===
  // checkUpdate：backendUrl 空 → 友好提示；返 null → 已是最新；非 null → 弹 Dialog。
  // 错误（网络/验签元数据/endpoint 无效）走 catch toast（ApiError.message）。
  async function checkForUpdate() {
    const base = backendUrl || '';
    if (!base) {
      toast.error('当前未连接协作服务，无法检查更新');
      return;
    }
    setChecking(true);
    try {
      const meta = await checkUpdate(base, updateChannel);
      if (!meta) {
        // 已是最新：清除历史缓存（避免设置页继续提示旧版本）。
        clearCachedUpdate();
        setCachedUpdate(null);
        toast.success(updateChannel === 'BETA' ? '当前已是最新 beta 版本' : '当前已是最新正式版本');
        return;
      }
      // 发现新版本：写缓存（下次进设置页无需重新检查即可直接更新）。
      saveCachedUpdate(meta, updateChannel);
      setCachedUpdate({ meta, channel: updateChannel, checkedAt: new Date().toISOString() });
      setDownloadFailed(false);
      setProgress({ downloaded: 0, total: null });
      setUpdateMeta(meta);
    } catch (err) {
      toast.error(errorMessage(err, '检查更新失败，请重试'));
    } finally {
      setChecking(false);
    }
  }

  function toggleBetaUpdates(enabled: boolean) {
    const next: UpdateChannel = enabled ? 'BETA' : 'STABLE';
    setUpdateChannel(next);
    saveUpdateChannel(next);
    toast.success(enabled ? '已启用 beta 更新' : '已切回正式版更新');
  }

  // 立即更新：downloadUpdate 订阅 Channel 事件（Started/Progress/Finished）。
  // Started 设 total，Progress 累加 downloaded，Finished 表示下载完成 + SHA-256 校验通过。
  // 之后 Rust 复制 updater.exe 到临时目录、调起它覆盖重启、app.exit()——进程退出，Promise 不再 resolve。
  // SHA-256 校验失败 / 网络中断 → catch toast + 解锁（更新中止，主程序仍可用）。
  // 兜底：若 Rust 因故未退出而 Promise resolve，解锁 Dialog 并提示手动重启，避免死锁。
  async function installUpdate() {
    if (!updateMeta) return;
    setUpdateInstalling(true);
    setDownloadFailed(false);
    downloadStartedAtRef.current = null;
    // 进入安装流程：清除「发现新版本」缓存提示（更新进行中）。
    clearCachedUpdate();
    setCachedUpdate(null);
    let finished = false;
    try {
      await downloadUpdate(updateMeta, (event) => {
        if (event.event === 'Started') {
          downloadStartedAtRef.current = Date.now();
          setProgress({ downloaded: 0, total: event.data.contentLength });
        } else if (event.event === 'Progress') {
          setProgress((prev) => ({
            ...prev,
            downloaded: prev.downloaded + event.data.chunkLength,
          }));
        } else if (event.event === 'Finished') {
          finished = true;
          toast.success('更新下载完成且校验通过，即将重启');
        }
      });
      // 成功 resolve 但进程未退出（Rust restart 失败兜底）：解锁 Dialog，提示手动重启。
      // finished=true 表示下载已完成，重启应在 Rust 侧自动发生；此处仅作 fallback 不重复 toast。
      setUpdateInstalling(false);
      if (finished) {
        toast.warning('更新已就绪，若未自动重启请手动重启应用完成安装。');
      } else {
        toast.warning('更新流程已结束，若未自动重启请手动重启应用。');
      }
    } catch (err) {
      toast.error(errorMessage(err, '下载更新失败，请重试'));
      setDownloadFailed(true);
      setUpdateInstalling(false);
    }
  }

  // 关闭更新 Dialog：安装中禁止关闭（避免误触中断）。dismissable=false 同步拦截 Esc/外点。
  function closeUpdateDialog(open: boolean) {
    if (!open && updateInstalling) return;
    setUpdateMeta(null);
  }

  const progressPercent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  // 下载速度 / 预计剩余时间：自 Started 起的平均速度（chunk 频繁触发渲染，显示持续刷新）。
  const elapsedMs =
    downloadStartedAtRef.current !== null ? Date.now() - downloadStartedAtRef.current : 0;
  const speedBps =
    updateInstalling && elapsedMs > 500 ? progress.downloaded / (elapsedMs / 1000) : null;
  const etaSeconds =
    speedBps && speedBps > 0 && progress.total
      ? (progress.total - progress.downloaded) / speedBps
      : null;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Tabs
        // value 未传时走 defaultValue（非受控，保持原行为）；传了则受控，支持父组件定向跳 Tab。
        {...(value !== undefined
          ? {
              value,
              onValueChange: (v: unknown) => {
                if (onValueChange && typeof v === 'string') onValueChange(v);
              },
            }
          : {
              defaultValue: 'cli',
              onValueChange: (v: unknown) => {
                if (typeof v === 'string') setInternalTab(v);
              },
            })}
      >
        <TabsList className="inline-flex w-fit max-w-full gap-1">
          <TabsTrigger value="general" className="px-3">
            通用
          </TabsTrigger>
          <TabsTrigger value="cli" className="px-3">
            脚本运行环境
          </TabsTrigger>
          <TabsTrigger value="gateway" className="px-3">
            模型与计费
          </TabsTrigger>
          <TabsTrigger value="plugins" className="px-3">
            插件
          </TabsTrigger>
          <TabsTrigger value="backend" className="px-3">
            更新
          </TabsTrigger>
          <TabsTrigger value="about" className="px-3">
            关于
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          <motion.div
            key={currentTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {/* 项 11：通用（关窗行为等应用级偏好） */}
            {currentTab === 'general' && (
              <TabsContent value="general" keepMounted className="mt-4 focus-visible:outline-none">
                <GeneralTab />
              </TabsContent>
            )}

            {/* Tab1：脚本运行时管理 */}
            {currentTab === 'cli' && (
              <TabsContent value="cli" keepMounted className="mt-4 focus-visible:outline-none">
                <RuntimeEnvTab />
              </TabsContent>
            )}

            {/* Tab2：模型与计费（只读模型版本 + 调用边界说明；不提供普通成员 API Key 配置） */}
            {currentTab === 'gateway' && (
              <TabsContent value="gateway" keepMounted className="mt-4 focus-visible:outline-none">
                <BillingTab />
              </TabsContent>
            )}

            {/* Tab：插件存放路径配置（组A，PRD 需求 6 / AC7） */}
            {currentTab === 'plugins' && (
              <TabsContent value="plugins" keepMounted className="mt-4 focus-visible:outline-none">
                <PluginsTab />
              </TabsContent>
            )}

            {/* Tab：检查更新 */}
            {currentTab === 'backend' && (
              <TabsContent value="backend" keepMounted className="mt-4 focus-visible:outline-none">
                <Card className="w-full">
                  <CardHeader>
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-center gap-2">
                        <RefreshCwIcon className="size-5 text-primary" />
                        <div className="flex items-center gap-2">
                          <CardTitle>更新</CardTitle>
                          <Badge variant={updateChannel === 'BETA' ? 'default' : 'secondary'}>
                            {updateChannel === 'BETA' ? 'Beta' : '正式版'}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                        <Checkbox
                          checked={updateChannel === 'BETA'}
                          onCheckedChange={(checked) => toggleBetaUpdates(Boolean(checked))}
                        />
                        <div className="leading-tight">
                          <div className="font-medium">启用 beta 更新</div>
                          <div className="text-xs text-muted-foreground">
                            默认关闭，开启后优先检查测试版
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* 缓存的可用更新提示：启动/上次检查发现的新版本，无需重新请求后端即可直接更新。 */}
                    {cachedUpdate && (
                      <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <span className="relative flex size-2">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                              <span className="relative inline-flex size-2 rounded-full bg-primary" />
                            </span>
                            发现新版本 v{cachedUpdate.meta.version}
                            {cachedUpdate.channel === 'BETA' && (
                              <Badge variant="default">Beta</Badge>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            检查于 {new Date(cachedUpdate.checkedAt).toLocaleString()}
                            ，可直接更新，无需重新检查。
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              void checkForUpdate();
                            }}
                          >
                            重新检查
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              setDownloadFailed(false);
                              setProgress({ downloaded: 0, total: null });
                              setUpdateMeta(cachedUpdate.meta);
                            }}
                          >
                            立即更新
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="rounded-lg border bg-background/40 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-medium">
                            {updateChannel === 'BETA' ? 'Beta 通道' : '正式版通道'}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {backendUrl
                              ? '已连接协作服务，可以检查更新。'
                              : '当前未连接协作服务，无法检查更新。'}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <LoadingButton
                            loading={checking}
                            onClick={() => {
                              void checkForUpdate();
                            }}
                          >
                            检查{updateChannel === 'BETA' ? ' beta' : '正式版'}更新
                          </LoadingButton>
                          <Button variant="outline" onClick={() => setChangelogOpen(true)}>
                            <HistoryIcon className="size-4" />
                            查看更新日志
                          </Button>
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-lg border bg-muted/20 px-3 py-2">
                        <div className="text-xs text-muted-foreground">校验</div>
                        <div className="mt-1 text-sm font-medium">SHA-256</div>
                      </div>
                      <div className="rounded-lg border bg-muted/20 px-3 py-2">
                        <div className="text-xs text-muted-foreground">安装</div>
                        <div className="mt-1 text-sm font-medium">下载后重启</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            )}

            {/* Tab：关于 */}
            {currentTab === 'about' && (
              <TabsContent value="about" keepMounted className="mt-4 focus-visible:outline-none">
                <AboutTab />
              </TabsContent>
            )}
          </motion.div>
        </AnimatePresence>
      </Tabs>

      {/* 更新 Dialog（design §3.2/§3.3）：发现新版本时展示 changelog + 进度条 + 立即更新。
          安装中锁定：disablePointerDismissal 阻外点 + closeUpdateDialog 拦 Esc/关闭按钮。 */}
      <Dialog
        open={updateMeta !== null}
        onOpenChange={closeUpdateDialog}
        disablePointerDismissal={updateInstalling}
      >
        <DialogContent showCloseButton={!updateInstalling} className="sm:max-w-lg">
          <DialogHeader {...dragRegionProps}>
            <DialogTitle data-tauri-drag-region>发现新版本 v{updateMeta?.version}</DialogTitle>
            <DialogDescription>
              当前版本 v{updateMeta?.currentVersion}，建议更新到最新版本。
            </DialogDescription>
          </DialogHeader>

          {/* changelog：复用 Markdown 组件渲染 notes（design §5）。notes 为空时给占位。 */}
          <div className="max-h-72 overflow-y-auto">
            <Markdown>{updateMeta?.notes ?? '本次更新暂无说明。'}</Markdown>
          </div>

          {/* 进度条（design §3.3）：下载中显示百分比（已知 total）或已下载字节数（未知 total）。 */}
          {updateInstalling ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {progress.total !== null ? '下载中' : '下载中（未知总大小）'}
                  {speedBps ? ` · ${formatBytes(speedBps)}/s` : ''}
                </span>
                <span>
                  {progressPercent !== null
                    ? `${progressPercent}%`
                    : formatBytes(progress.downloaded)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                {progressPercent !== null ? (
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                ) : (
                  // 未知总大小：不定进度动画（左右滑动），替代旧固定 36% 的误导进度。
                  <div className="h-full w-1/3 animate-indeterminate rounded-full bg-primary" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {etaSeconds !== null ? `预计剩余 ${formatDuration(etaSeconds)}，` : ''}
                下载完成后自动安装并重启，请勿关闭窗口。
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <LoadingButton
              variant="outline"
              loading={false}
              disabled={updateInstalling}
              onClick={() => closeUpdateDialog(false)}
            >
              稍后
            </LoadingButton>
            <LoadingButton
              loading={updateInstalling}
              disabled={updateInstalling}
              onClick={() => {
                void installUpdate();
              }}
            >
              {downloadFailed ? '重试下载' : '立即更新'}
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 更新日志悬浮窗：查看历史版本变更（react-markdown + GFM 任务列表 + 代码高亮）。 */}
      <ChangelogDialog open={changelogOpen} onOpenChange={setChangelogOpen} />
    </div>
  );
}
