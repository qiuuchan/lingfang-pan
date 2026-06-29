// AboutTab.tsx —— 设置页「关于」tab。
//
// 两块内容（按需求）：
//  1. 版本信息：应用名 / 版本号（Tauri 内核与应用标识属技术细节，不在此展示）。
//     来源 @tauri-apps/api/app，非 Tauri 环境（web 预览）降级为 package.json 版本 + 提示。
//  2. 版本通道：当前通道（Beta/正式版）Badge + 通道说明 + 跳更新 tab。
//     Beta 开关统一在「更新」tab，本页不重复放置，避免两处开关混淆。
//
// channel state 由 Settings 顶层持有并传入（与「更新」tab 共享同一份）。
import { useEffect, useState } from 'react';
import { getVersion, getName } from '@tauri-apps/api/app';
import { InfoIcon, RefreshCwIcon, ArrowRightIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { UpdateChannel } from '@/lib/updater';
// 兜底版本（非 Tauri 环境展示）：构建时由 vite 注入。
import pkg from '../../../package.json';

interface AppInfo {
  name: string;
  version: string;
  desktop: boolean; // true=Tauri 桌面环境，false=web 预览/降级
}

/** 是否运行在 Tauri 桌面环境（withGlobalTauri 时注入 __TAURI_INTERNALS__）。 */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** 拉取应用信息：Tauri 环境用 app API，否则用 package.json 兜底。 */
async function loadAppInfo(): Promise<AppInfo> {
  if (!isTauriEnv()) {
    return { name: pkg.name ?? 'lingfang-desktop', version: pkg.version ?? '0.0.0', desktop: false };
  }
  const [name, version] = await Promise.all([
    getName().catch(() => 'lingfang-desktop'),
    getVersion().catch(() => pkg.version ?? '0.0.0'),
  ]);
  return { name, version, desktop: true };
}

export interface AboutTabProps {
  /** 当前更新通道（与「更新」tab 共享）。 */
  updateChannel: UpdateChannel;
  /** 跳转到「更新」tab（检查更新 / 查看更新日志 / 切 Beta）。 */
  onGotoUpdate: () => void;
}

export function AboutTab({ updateChannel, onGotoUpdate }: AboutTabProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const isBeta = updateChannel === 'BETA';

  useEffect(() => {
    let cancelled = false;
    loadAppInfo().then((i) => { if (!cancelled) setInfo(i); }).catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-4">
      {/* ── 第一块：版本信息 ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <InfoIcon className="size-5 text-primary" />
            <CardTitle>版本信息</CardTitle>
            {!info?.desktop && info ? (
              <Badge variant="secondary">非桌面环境</Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!info?.desktop && info ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              当前为 web 预览，显示的是 package.json 兜底版本；在桌面客户端中以 Tauri 实际版本为准。
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">应用名</div>
              <div className="mt-1 truncate font-mono text-sm font-medium" title={info?.name ?? ''}>{info?.name ?? '加载中…'}</div>
            </div>
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">版本号</div>
              <div className="mt-1 truncate font-mono text-sm font-medium" title={info ? `v${info.version}` : ''}>{info ? `v${info.version}` : '加载中…'}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 第二块：版本通道（Beta / 正式版）──
          Beta 开关统一在「更新」tab，本页只展示当前通道 + 通道说明 + 跳转入口，避免两处开关重复。 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <RefreshCwIcon className="size-5 text-primary" />
            <div className="flex items-center gap-2">
              <CardTitle>版本通道</CardTitle>
              <Badge variant={isBeta ? 'default' : 'secondary'}>{isBeta ? 'Beta' : '正式版'}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 通道说明 */}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">正式版通道</div>
              <div className="mt-1 text-sm font-medium">稳定可靠，推荐大多数用户</div>
            </div>
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">Beta 通道</div>
              <div className="mt-1 text-sm font-medium">优先尝鲜新功能，可能不稳定</div>
            </div>
          </div>
          {/* 跳更新 tab：检查更新 / 查看更新日志 / 切换 Beta 开关都在「更新」tab */}
          <div className="flex justify-end">
            <Button variant="outline" onClick={onGotoUpdate}>
              检查更新 / 切换通道 <ArrowRightIcon className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
