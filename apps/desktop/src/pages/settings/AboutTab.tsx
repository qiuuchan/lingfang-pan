// AboutTab.tsx —— 设置页「关于」tab。
//
// 仅展示版本信息（应用名 / 版本号）。
//  来源 @tauri-apps/api/app，非 Tauri 环境（web 预览）降级为 package.json 版本 + 提示。
//
// 版本通道（Beta / 正式版）的开关与说明统一在「更新」tab，本页不再重复展示，避免两处混淆。
import { useEffect, useState } from 'react';
import { getVersion, getName } from '@tauri-apps/api/app';
import { InfoIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
// 兜底版本（非 Tauri 环境展示）：构建时由 vite 注入。
import pkg from '../../../package.json';

/** 把 ISO 构建时间格式化为本地可读串（解析失败原样返回）。 */
function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

interface AppInfo {
  name: string;
  version: string;
  desktop: boolean; // true=Tauri 桌面环境，false=web 预览/降级
}

/** 是否运行在 Tauri 桌面环境（withGlobalTauri 时注入 __TAURI_INTERNALS__）。 */
function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

/** 拉取应用信息：Tauri 环境用 app API，否则用 package.json 兜底。 */
async function loadAppInfo(): Promise<AppInfo> {
  if (!isTauriEnv()) {
    return {
      name: pkg.name ?? 'lingfang-desktop',
      version: pkg.version ?? '0.0.0',
      desktop: false,
    };
  }
  const [name, version] = await Promise.all([
    getName().catch(() => 'lingfang-desktop'),
    getVersion().catch(() => pkg.version ?? '0.0.0'),
  ]);
  return { name, version, desktop: true };
}

export function AboutTab() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAppInfo()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* ── 第一块：版本信息 ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <InfoIcon className="size-5 text-primary" />
            <CardTitle>版本信息</CardTitle>
            {!info?.desktop && info ? <Badge variant="secondary">非桌面环境</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!info?.desktop && info ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              当前为 web 预览，显示的是 package.json 兜底版本；在桌面客户端中以 Tauri 实际版本为准。
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">应用名</div>
              <div className="mt-1 truncate font-mono text-sm font-medium" title={info?.name ?? ''}>
                {info?.name ?? '加载中…'}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">版本号</div>
              <div
                className="mt-1 truncate font-mono text-sm font-medium"
                title={info ? `v${info.version}` : ''}
              >
                {info ? `v${info.version}` : '加载中…'}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/20 px-3 py-2 sm:col-span-2">
              <div className="text-xs text-muted-foreground">构建时间</div>
              <div className="mt-1 truncate font-mono text-sm font-medium" title={__BUILD_TIME__}>
                {formatBuildTime(__BUILD_TIME__)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
