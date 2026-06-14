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
import { ServerIcon } from 'lucide-react';
import { useApp } from '@/App';
import { normalizeBackendUrl, testBackendUrl, tauriInvoke, tauriListen, type ApiError } from '@/lib/api';
import { probeScriptRuntime } from '@/lib/plugin-script';
import { installCli, installRuntime, AVAILABILITY_EVENT } from '@/lib/install-cli';
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
import { CliRuntimeTab } from './settings/CliRuntimeTab';
import { ModelGatewayTab } from './settings/ModelGatewayTab';

export function Settings() {
  const { backendUrl, saveBackendUrl, resetSession } = useApp();

  // === Tab3 后端地址 Card state（零改动保留原逻辑） ===
  const [backendInput, setBackendInput] = useState(backendUrl || '');
  const [testingBackend, setTestingBackend] = useState(false);
  const [savingBackend, setSavingBackend] = useState(false);

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
        toast.warning('安装需要管理员权限，请以管理员身份重试或手动安装。');
      } else if (result.status === 'Unsupported') {
        toast.warning(result.message || '当前平台不支持自动安装，请手动安装。');
      } else {
        // Failed：Rust 侧已清理半装残留（design D4），提示重试。
        toast.error(result.message || '安装失败，请重试。');
      }
    } catch (err) {
      toast.error((err as ApiError).message || '安装失败，请重试。');
    } finally {
      setInstalling((prev) => ({ ...prev, [target]: false }));
    }
  }, []);

  // === Tab3 后端地址 Card 逻辑（零改动，从原 Settings 搬入） ===
  async function testBackend() {
    const normalized = normalizeBackendUrl(backendInput);
    if (!normalized) return toast.error('请输入以 http:// 或 https:// 开头的后端地址');
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
    if (!normalized) return toast.error('请输入以 http:// 或 https:// 开头的后端地址');
    setSavingBackend(true);
    try {
      await testBackendUrl(normalized);
      const changed = normalized !== backendUrl;
      if (!saveBackendUrl(normalized)) return toast.error('后端地址格式不正确');
      setBackendInput(normalized);
      if (changed) {
        resetSession();
        toast.success('后端地址已保存，请重新登录');
      } else {
        toast.success('后端地址已保存');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingBackend(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Tabs defaultValue="cli">
        <TabsList>
          <TabsTrigger value="cli">CLI 与运行时</TabsTrigger>
          <TabsTrigger value="gateway">模型网关</TabsTrigger>
          <TabsTrigger value="backend">后端服务</TabsTrigger>
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
                <CardTitle>后端服务地址</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="text-sm text-muted-foreground">
                当前地址：<span className="font-mono text-foreground">{backendUrl || '未配置'}</span>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="backendServiceUrl">后端 URL</Label>
                <Input
                  id="backendServiceUrl"
                  placeholder="例如 http://127.0.0.1:3000 或 https://api.example.com"
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
                切换到另一套后端时当前登录态会失效，保存后需要重新登录。
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
