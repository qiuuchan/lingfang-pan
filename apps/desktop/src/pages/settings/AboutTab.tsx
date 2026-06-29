// AboutTab.tsx —— 设置页「关于」tab。
//
// 两块内容（按需求拆分）：
//  1. 版本信息：应用名 / 版本号 / Tauri 内核 / 应用标识。来源 @tauri-apps/api/app，
//     非 Tauri 环境（web 预览）降级为 package.json 版本 + 提示。
//  2. 版本通道：当前通道（Beta/正式版）Badge + Beta 开关 + 通道说明 + 跳更新 tab。
//
// channel state 由 Settings 顶层持有并传入（与「更新」tab 共享同一份，避免两处 localStorage
// 读写不同步）。toggleBeta 也由 Settings 提供，本 tab 仅触发回调。
import { useEffect, useState } from 'react';
import { getVersion, getName, getTauriVersion, getIdentifier } from '@tauri-apps/api/app';
import { InfoIcon, RefreshCwIcon, ArrowRightIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { UpdateChannel } from '@/lib/updater';
// 兜底版本（非 Tauri 环境展示）：构建时由 vite 注入（define 或直接读 package.json 字段）。
// 这里用静态字面量，与 tauri.conf.json 保持一致；改版时同步更新。
import pkg from '../../../package.json';

interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  identifier: string;
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
    return { name: pkg.name ?? 'lingfang-desktop', version: pkg.version ?? '0.0.0', tauriVersion: '-', identifier: '-', desktop: false };
  }
  const [name, version, tauriVersion, identifier] = await Promise.all([
    getName().catch(() => 'lingfang-desktop'),
    getVersion().catch(() => pkg.version ?? '0.0.0'),
    getTauriVersion().catch(() => '-'),
    getIdentifier().catch(() => '-'),
  ]);
  return { name, version, tauriVersion, identifier, desktop: true };
}

export interface AboutTabProps {
  /** 当前更新通道（与「更新」tab 共享）。 */
  updateChannel: UpdateChannel;
  /** 切换 Beta 通道（复用 Settings 顶层逻辑，含 localStorage 持久化 + toast）。 */
  onToggleBeta: (enabled: boolean) => void;
  /** 跳转到「更新」tab（检查更新 / 查看更新日志）。 */
  onGotoUpdate: () => void;
}

/** 版本信息网格的单项：标签 + 值。 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-sm font-medium" title={value}>{value}</div>
    </div>
  );
}

export function AboutTab({ updateChannel, onToggleBeta, onGotoUpdate }: AboutTabProps) {
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
            <InfoRow label="应用名" value={info?.name ?? '加载中…'} />
            <InfoRow label="版本号" value={info ? `v${info.version}` : '加载中…'} />
            <InfoRow label="Tauri 内核" value={info?.tauriVersion ?? '-'} />
            <InfoRow label="应用标识" value={info?.identifier ?? '-'} />
          </div>
        </CardContent>
      </Card>

      {/* ── 第二块：版本通道（Beta / 正式版）── */}
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
          {/* Beta 开关：与「更新」tab 共享同一 channel state。 */}
          <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
            <Checkbox checked={isBeta} onCheckedChange={(checked) => onToggleBeta(Boolean(checked))} />
            <div className="leading-tight">
              <div className="font-medium">启用 beta 更新</div>
              <div className="text-xs text-muted-foreground">默认关闭，开启后优先检查测试版</div>
            </div>
          </div>
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
          {/* 跳更新 tab */}
          <div className="flex justify-end">
            <Button variant="outline" onClick={onGotoUpdate}>
              检查更新 <ArrowRightIcon className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
