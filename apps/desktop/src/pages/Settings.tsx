// Settings.tsx — 设置页（三 Tab 化）。
//
// 三个 Tab（design §7.1）：
// - cli：CLI 与运行时管理（探测 + 自动安装，复用桌面 Rust 探测/安装命令）。
// - gateway：模型网关配置（拉后端目录 + 绑定，apiKey 加密存储）。
// - backend：后端服务地址 Card（零功能改动，从原单 Card 布局搬入 Tab3）。
//
// 顶层 state（design B13）：探测结果（cliResults/runtimeResults）与安装态（installing）上提，
// 不进 useApp；因为 TabsContent keepMounted 切 Tab 时不卸载，state 保留避免重探。
// useRef 重入守卫（design B26）：probeAll 防止事件触发叠加并发探测。
//
// 监听 code-assistant://availability-changed（design B3）：Rust 安装成功后 emit 全量 ToolAvailability，
// 前端监听后自动重探刷新状态（无需手动点「重新检测」）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCwIcon, ServerIcon } from 'lucide-react';
import { useApp } from '@/App';
import { normalizeBackendUrl, testBackendUrl, tauriInvoke, tauriListen, type ApiError } from '@/lib/api';
import { probeScriptRuntime } from '@/lib/plugin-script';
import { installCli, installRuntime, AVAILABILITY_EVENT } from '@/lib/install-cli';
import { checkUpdate, downloadAndInstall, type UpdateMetadata } from '@/lib/updater';
import type {
  CliInstallTarget,
  InstallResult,
  InstallTarget,
  ProbeResult,
  RuntimeInstallTarget,
  ToolAvailability,
} from '@/lib/cli-types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/loading-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Markdown } from '@/components/markdown';
import { CliRuntimeTab } from './settings/CliRuntimeTab';
import { ModelGatewayTab } from './settings/ModelGatewayTab';

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

export function Settings({
  // 受控 Tab：默认 'cli'，支持父组件（如新手任务清单「去设置 → 模型服务」）定向跳转。
  value,
  onValueChange,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const { backendUrl, saveBackendUrl, resetSession } = useApp();

  // === Tab3 后端地址 Card state（零改动保留原逻辑） ===
  const [backendInput, setBackendInput] = useState(backendUrl || '');
  const [testingBackend, setTestingBackend] = useState(false);
  const [savingBackend, setSavingBackend] = useState(false);

  // === Tab3 检查更新 state（design §3.2） ===
  // checking：检查中态；updateMeta：非 null 时弹更新 Dialog；updateInstalling：下载安装中（锁 Dialog）。
  // progress：下载进度（total 为 Content-Length，未知则 null；downloaded 为已累计字节数）。
  // 注：installing（Tab1 安装态，Record<InstallTarget, boolean>）已占用，故此处用 updateInstalling 避名冲突。
  const [checking, setChecking] = useState(false);
  const [updateMeta, setUpdateMeta] = useState<UpdateMetadata | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });

  // === Tab1 CLI/运行时 state（design B13，顶层缓存避免切 Tab 重探） ===
  const [cliResults, setCliResults] = useState<ToolAvailability[] | null>(null);
  const [runtimeResults, setRuntimeResults] = useState<Partial<Record<RuntimeInstallTarget, ProbeResult | null>> | null>(null);
  const [probing, setProbing] = useState(false);
  const [installing, setInstalling] = useState<Partial<Record<InstallTarget, boolean>>>({});
  const probingRef = useRef(false); // B26 重入守卫

  // 重新探测全部：并行 list_tools + probe_script_runtime(nodejs/python)。
  // probeScriptRuntime 可能 throw（探测失败），catch 后该项置 null；list_tools 失败整体保持上次结果。
  const probeAll = useCallback(async () => {
    if (probingRef.current) return; // 已在探测，跳过叠加。
    probingRef.current = true;
    setProbing(true);
    try {
      // list_tools 是 CLI 探测主通道；失败时 cliResults 置空让 UI 显检测中/未装。
      let tools: ToolAvailability[] | null = null;
      try {
        tools = await tauriInvoke<ToolAvailability[]>('code_assistant_list_tools');
      } catch {
        tools = null;
      }
      setCliResults(tools);

      // 并行探测两个运行时，各自独立兜底。
      const runtimes = await Promise.all([
        probeScriptRuntime('nodejs').then((r) => [r] as const).catch(() => [null] as const),
        probeScriptRuntime('python').then((r) => [r] as const).catch(() => [null] as const),
      ]);
      setRuntimeResults({
        nodejs: runtimes[0][0],
        python: runtimes[1][0],
      });
    } finally {
      probingRef.current = false;
      setProbing(false);
    }
  }, []);

  // 挂载探测一次 + 监听 Rust 安装完成事件自动重探。
  useEffect(() => {
    void probeAll();
    // tauriListen 可能在非 Tauri 环境 throw（开发态 SSR/单测），失败时不挂监听，不阻塞探测。
    let unlisten: (() => void) | null = null;
    tauriListen<ToolAvailability[]>(AVAILABILITY_EVENT, () => { void probeAll(); })
      .then((fn) => { unlisten = fn; })
      .catch(() => { /* 非 Tauri 环境忽略 */ });
    return () => { if (unlisten) unlisten(); };
  }, [probeAll]);

  /** 安装某目标：按类型路由 install_cli/install_runtime；catch toast；finally 清安装态。
   *  Rust 安装成功后自动 emit AVAILABILITY_EVENT → 上面监听触发 probeAll 刷新，无需手动重探。 */
  const onInstall = useCallback(async (target: InstallTarget) => {
    setInstalling((prev) => ({ ...prev, [target]: true }));
    try {
      let result: InstallResult;
      if (target === 'nodejs' || target === 'python') {
        result = await installRuntime(target as RuntimeInstallTarget);
      } else {
        result = await installCli(target as CliInstallTarget);
      }
      // 按 Rust InstallResult.status 分支友好提示（status 是 PascalCase）。
      if (result.status === 'Succeeded') {
        toast.success('安装成功');
      } else if (result.status === 'NeedsConfirmation') {
        toast.warning('安装需要管理员权限，请以管理员身份重试或手动安装');
      } else if (result.status === 'Unsupported') {
        toast.warning(result.message || '当前平台不支持自动安装，请手动安装');
      } else {
        // Failed：Rust 侧已清理半装残留（design D4），提示重试。
        toast.error(result.message || '安装失败，请重试');
      }
    } catch (err) {
      toast.error((err as ApiError).message || '安装失败，请重试');
    } finally {
      setInstalling((prev) => ({ ...prev, [target]: false }));
    }
  }, []);

  // === Tab3 后端地址 Card 逻辑（零改动，从原 Settings 搬入） ===
  async function testBackend() {
    const normalized = normalizeBackendUrl(backendInput);
    if (!normalized) return toast.error('输入以 http:// 或 https:// 开头的后端地址');
    setTestingBackend(true);
    try {
      await testBackendUrl(normalized);
      toast.success('后端连接正常');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestingBackend(false);
    }
  }

  async function saveBackend() {
    const normalized = normalizeBackendUrl(backendInput);
    if (!normalized) return toast.error('输入以 http:// 或 https:// 开头的后端地址');
    setSavingBackend(true);
    try {
      await testBackendUrl(normalized);
      const changed = normalized !== backendUrl;
      if (!saveBackendUrl(normalized)) return toast.error('公司平台地址格式不正确');
      setBackendInput(normalized);
      if (changed) {
        resetSession();
        toast.success('公司平台地址已保存，需重新登录');
      } else {
        toast.success('公司平台地址已保存');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingBackend(false);
    }
  }

  // === Tab3 检查更新逻辑（design §3.2） ===
  // checkUpdate：backendUrl 空 → 友好提示；返 null → 已是最新；非 null → 弹 Dialog。
  // 错误（网络/验签元数据/endpoint 无效）走 catch toast（ApiError.message）。
  async function checkForUpdate() {
    const base = backendUrl || '';
    if (!base) {
      toast.error('先在上方配置公司平台地址');
      return;
    }
    setChecking(true);
    try {
      const meta = await checkUpdate(base);
      if (!meta) {
        toast.success('当前已是最新版本');
        return;
      }
      setProgress({ downloaded: 0, total: null });
      setUpdateMeta(meta);
    } catch (err) {
      toast.error((err as ApiError).message || '检查更新失败，请重试');
    } finally {
      setChecking(false);
    }
  }

  // 立即更新：downloadAndInstall 订阅 Channel 事件（Started/Progress/Finished）。
  // Started 设 total，Progress 累加 downloaded，Finished 提示即将重启（Rust 侧 app.restart 自动执行）。
  // 安装包验签失败/网络中断 → catch toast + 解锁。
  // 修复 H1：成功路径的 downloadAndInstall 若 Rust 侧 app.restart 未触发（restart 失败被吞/平台异常），
  // Promise 会 resolve 而进程未退出，此前仅 catch 解锁，Dialog 永久锁死（disablePointerDismissal + showCloseButton=false）。
  // 现在成功 resolve 兜底解锁并提示用户手动重启，避免更新流程死锁只能强杀进程。
  async function installUpdate() {
    setUpdateInstalling(true);
    let finished = false;
    try {
      await downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setProgress({ downloaded: 0, total: event.data.contentLength });
        } else if (event.event === 'Progress') {
          setProgress((prev) => ({ ...prev, downloaded: prev.downloaded + event.data.chunkLength }));
        } else if (event.event === 'Finished') {
          finished = true;
          toast.success('更新下载完成，即将重启');
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
      toast.error((err as ApiError).message || '下载更新失败，请重试');
      setUpdateInstalling(false);
    }
  }

  // 关闭更新 Dialog：安装中禁止关闭（避免误触中断）。dismissable=false 同步拦截 Esc/外点。
  function closeUpdateDialog(open: boolean) {
    if (!open && updateInstalling) return;
    setUpdateMeta(null);
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Tabs
        // value 未传时走 defaultValue（非受控，保持原行为）；传了则受控，支持父组件定向跳 Tab。
        {...(value !== undefined ? { value, onValueChange: (v: unknown) => { if (onValueChange && typeof v === 'string') onValueChange(v); } } : { defaultValue: 'cli' })}
      >
        <TabsList>
          <TabsTrigger value="cli">CLI 与运行环境</TabsTrigger>
          <TabsTrigger value="gateway">模型服务</TabsTrigger>
          <TabsTrigger value="backend">公司平台</TabsTrigger>
        </TabsList>

        {/* Tab1：CLI 与运行时管理 */}
        <TabsContent value="cli" keepMounted>
          <CliRuntimeTab
            cliResults={cliResults}
            runtimeResults={runtimeResults}
            probing={probing}
            installing={installing}
            onProbeAll={() => { void probeAll(); }}
            onInstall={(t) => { void onInstall(t); }}
          />
        </TabsContent>

        {/* Tab2：模型网关配置（自管 state，独立于探测） */}
        <TabsContent value="gateway" keepMounted>
          <ModelGatewayTab />
        </TabsContent>

        {/* Tab3：后端服务地址（零功能改动搬入） */}
        <TabsContent value="backend" keepMounted>
          <Card className="w-full">
            <CardHeader>
              <div className="flex items-center gap-2">
                <ServerIcon className="size-5 text-primary" />
                <CardTitle>公司平台地址</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="text-sm text-muted-foreground">
                当前地址：<span className="font-mono text-foreground">{backendUrl || '未配置'}</span>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="backendServiceUrl">平台地址</Label>
                <Input
                  id="backendServiceUrl"
                  placeholder="例如 https://platform.example.com"
                  value={backendInput}
                  onChange={(e) => setBackendInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveBackend()}
                />
              </div>
              <div className="flex items-center gap-2">
                <LoadingButton variant="outline" loading={testingBackend} onClick={() => { void testBackend(); }}>测试连接</LoadingButton>
                <LoadingButton loading={savingBackend} onClick={() => { void saveBackend(); }}>测试并保存</LoadingButton>
              </div>
              <p className="text-xs text-muted-foreground">
                切换到另一个平台时当前登录会失效，保存后需重新登录。
              </p>
            </CardContent>
          </Card>

          {/* 检查更新 Card（design §3.2）：放在后端地址 Card 下方，复用 backendUrl 作为更新源。 */}
          <Card className="mt-4 w-full">
            <CardHeader>
              <div className="flex items-center gap-2">
                <RefreshCwIcon className="size-5 text-primary" />
                <CardTitle>检查更新</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                连接公司平台检查新版本，发现更新后可下载安装包并自动重启。
              </p>
              <LoadingButton loading={checking} onClick={() => { void checkForUpdate(); }}>检查更新</LoadingButton>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 更新 Dialog（design §3.2/§3.3）：发现新版本时展示 changelog + 进度条 + 立即更新。
          安装中锁定：disablePointerDismissal 阻外点 + closeUpdateDialog 拦 Esc/关闭按钮。 */}
      <Dialog open={updateMeta !== null} onOpenChange={closeUpdateDialog} disablePointerDismissal={updateInstalling}>
        <DialogContent showCloseButton={!updateInstalling} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>发现新版本 v{updateMeta?.version}</DialogTitle>
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
                <span>{progress.total !== null ? '下载中' : '下载中（未知总大小）'}</span>
                <span>
                  {progress.total !== null
                    ? `${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`
                    : `${formatBytes(progress.downloaded)}`}
                </span>
              </div>
              <progress
                className="h-2 w-full overflow-hidden rounded-full bg-muted [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                value={progress.downloaded}
                max={progress.total ?? undefined}
              />
              <p className="text-xs text-muted-foreground">下载完成后自动安装并重启，请勿关闭窗口。</p>
            </div>
          ) : null}

          <DialogFooter>
            <LoadingButton variant="outline" loading={false} disabled={updateInstalling} onClick={() => closeUpdateDialog(false)}>稍后</LoadingButton>
            <LoadingButton loading={updateInstalling} disabled={updateInstalling} onClick={() => { void installUpdate(); }}>
              立即更新
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
