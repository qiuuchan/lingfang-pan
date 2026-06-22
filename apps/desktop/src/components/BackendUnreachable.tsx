// BackendUnreachable.tsx — R6 后端不可达友好页。
//
// 触发：api.ts 的 fetch 抛网络异常（连接拒绝/DNS 失败/超时）时派发 BACKEND_UNREACHABLE_EVENT，
// App.tsx 监听后置 backendUnreachable=true，主界面 main 区渲染本组件替代业务页（避免反复 toast）。
//
// 设计：
// - 友好图标 + 「无法访问 LingFang 服务」标题 + 当前后端地址展示。
// - 「重试」按钮：调 testBackendUrl 重新探测，成功派发 reachable 退出不可达态。
// - 「去设置」按钮：跳 backend tab 让用户修改后端地址。
// - 与创建器 env-readiness 横幅互补：横幅处理「地址未配置」，本组件处理「地址已配但 fetch 失败」。

import { useState } from 'react';
import { CloudOffIcon, RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { apiBase, testBackendUrl, dispatchBackendReachable } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface BackendUnreachableProps {
  /** 跳转设置页（backend tab）。由 App 透传。 */
  onGoSettings: () => void;
}

export function BackendUnreachable({ onGoSettings }: BackendUnreachableProps) {
  const [retrying, setRetrying] = useState(false);
  const [lastError, setLastError] = useState<string>('');
  const address = apiBase() || '未配置';

  async function handleRetry() {
    setRetrying(true);
    setLastError('');
    try {
      const base = apiBase();
      if (!base) {
        setLastError('尚未配置后端地址，请先在设置中填写。');
        return;
      }
      await testBackendUrl(base);
      // 探测成功：后端已恢复，派发 reachable 让 App 退出不可达态并重新加载业务页。
      dispatchBackendReachable();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : '连接仍失败，请确认后端服务已启动。');
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-2xl border bg-background p-8 text-center shadow-sm">
        {/* 品牌图标：云离线，靛蓝渐变呼应 app icon 配色 */}
        <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-sky-500/15 ring-1 ring-foreground/10">
          <CloudOffIcon className="size-8 text-indigo-500 dark:text-indigo-400" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold">无法访问此页面</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            灵坊 桌面端无法连接到协作服务。请确认后端服务已启动，或检查网络与地址配置后重试。
          </p>
        </div>

        {/* 当前后端地址展示 */}
        <div className="w-full rounded-lg bg-muted/60 px-3 py-2 text-left text-xs">
          <span className="text-muted-foreground">后端地址：</span>
          <span className="break-all font-mono text-foreground">{address}</span>
        </div>

        {lastError && (
          <p className="text-xs text-destructive">{lastError}</p>
        )}

        <div className="flex w-full gap-2">
          <Button className="flex-1" onClick={handleRetry} disabled={retrying}>
            <RefreshCwIcon className={retrying ? 'size-4 animate-spin' : 'size-4'} />
            {retrying ? '正在重试…' : '重试连接'}
          </Button>
          <Button variant="outline" className="flex-1" onClick={onGoSettings}>
            <SettingsIcon className="size-4" />
            去设置
          </Button>
        </div>
      </div>
    </div>
  );
}
