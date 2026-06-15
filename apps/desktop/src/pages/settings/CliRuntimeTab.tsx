// CliRuntimeTab.tsx — 设置页 Tab1：CLI 与运行时管理。
//
// 职责：
// - 渲染 5 行（3 CLI：claude/codex/opencode；2 运行时：nodejs/python），每行展示
//   名称 / 版本 / binary_path / 状态 Badge；未装时给「自动安装」按钮（弹确认 Dialog 后再装）。
// - 探测与安装的副作用上提到 Settings 顶层（design B13）：本组件纯展示 + 把用户意图
//   回调出去（onProbeAll / onInstall），不自己 tauriInvoke，避免 keepMounted 时切 Tab 丢 state。
//
// 数据来源（全部 Rust serde 命名，与 HTTP DTO camelCase 不同，见 lib/cli-types.ts 注释）：
// - cliResults：code_assistant_list_tools 全量（含 available/version/binary_path）。
// - runtimeResults：probe_script_runtime(nodejs/python) 各一次，可能为 null（探测失败置空）。
//
// 安装二次确认（design B17）：winget 是高权限操作，装前弹 Dialog 说明「可能需管理员权限」。
// 仅 Windows 支持自动安装，macOS/Linux 由 Rust 侧返回 Unsupported，本组件按 status 提示。

import { useState } from 'react';
import { TerminalIcon, CpuIcon, RefreshCwIcon, Loader2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import { CLI_TOOL_META, RUNTIME_META } from '@/lib/install-cli';
import { dragRegionProps } from '@/lib/window-drag';
import type {
  CliToolId,
  InstallTarget,
  ProbeResult,
  RuntimeInstallTarget,
  ToolAvailability,
} from '@/lib/cli-types';

export interface CliRuntimeTabProps {
  /** 3 CLI 探测结果（list_tools 全量），null 表示尚未探测（检测中态）。 */
  cliResults: ToolAvailability[] | null;
  /** 2 运行时探测结果，null 表示尚未探测。每项可为 null（探测抛错兜底）。 */
  runtimeResults: Partial<Record<RuntimeInstallTarget, ProbeResult | null>> | null;
  /** 是否正在重新探测全部。 */
  probing: boolean;
  /** 各安装目标是否正在安装中。 */
  installing: Partial<Record<InstallTarget, boolean>>;
  /** 重新探测全部（按钮触发）。 */
  onProbeAll: () => void;
  /** 安装某目标（确认 Dialog 通过后触发）。 */
  onInstall: (target: InstallTarget) => void;
}

/** CLI 工具展示顺序（固定 claude → codex → opencode）。 */
const CLI_ORDER: CliToolId[] = ['claude', 'codex', 'opencode'];

/** 运行时展示顺序（固定 nodejs → python）。 */
const RUNTIME_ORDER: RuntimeInstallTarget[] = ['nodejs', 'python'];

export function CliRuntimeTab({
  cliResults,
  runtimeResults,
  probing,
  installing,
  onProbeAll,
  onInstall,
}: CliRuntimeTabProps) {
  // 待确认安装的目标（点击「自动安装」→ 置 target → 弹 Dialog；确认后调 onInstall 并清空）。
  const [pendingInstall, setPendingInstall] = useState<InstallTarget | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部操作区：重新检测全部 */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          自动检测本机已安装的 CLI 工具与脚本运行环境，未安装时可一键自动安装（仅 Windows）。
        </div>
        <LoadingButton variant="outline" size="sm" loading={probing} onClick={onProbeAll}>
          <RefreshCwIcon />重新检测全部
        </LoadingButton>
      </div>

      {/* CLI 工具区 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TerminalIcon className="size-4 text-primary" />
            <CardTitle>CLI 工具</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {CLI_ORDER.map((toolId) => {
            const meta = CLI_TOOL_META[toolId];
            // cliResults 为 null 时整体检测中；否则按 tool 字段匹配（Rust 返回的 tool 即 CliToolId）。
            const result = cliResults?.find((r) => r.tool === toolId) ?? null;
            const isInstalling = installing[toolId] === true;
            const available = result?.available ?? false;
            return (
              <RuntimeRow
                key={toolId}
                label={meta.label}
                wingetId={meta.wingetId}
                version={result?.version ?? null}
                binaryPath={result?.binary_path ?? null}
                available={available}
                probing={cliResults === null}
                installing={isInstalling}
                onInstall={() => setPendingInstall(toolId)}
              />
            );
          })}
        </CardContent>
      </Card>

      {/* 运行时区 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CpuIcon className="size-4 text-primary" />
            <CardTitle>脚本运行环境</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {RUNTIME_ORDER.map((rtId) => {
            const meta = RUNTIME_META[rtId];
            const result = runtimeResults?.[rtId] ?? undefined;
            const isInstalling = installing[rtId] === true;
            const available = result?.available ?? false;
            return (
              <RuntimeRow
                key={rtId}
                label={meta.label}
                wingetId={meta.wingetId}
                version={result?.version ?? null}
                binaryPath={result?.binary_path ?? null}
                available={available}
                // 运行时探测结果可能为 null（探测失败）且 runtimeResults 已加载 → 检测中态隐藏，
                // 显示未装即可（available=false）。仅当 runtimeResults===null（未发起探测）时显示检测中。
                probing={runtimeResults === null}
                installing={isInstalling}
                onInstall={() => setPendingInstall(rtId)}
              />
            );
          })}
        </CardContent>
      </Card>

      {/* 安装二次确认 Dialog（design B17） */}
      <InstallConfirmDialog
        target={pendingInstall}
        onCancel={() => setPendingInstall(null)}
        onConfirm={() => {
          const target = pendingInstall;
          setPendingInstall(null);
          if (target) onInstall(target);
        }}
      />
    </div>
  );
}

/** 单行展示：名称 + 版本 + 路径 + 状态 Badge + 未装时安装按钮。 */
function RuntimeRow({
  label,
  wingetId,
  version,
  binaryPath,
  available,
  probing,
  installing,
  onInstall,
}: {
  label: string;
  wingetId: string;
  version: string | null;
  binaryPath: string | null;
  available: boolean;
  probing: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
      {/* 名称 + 版本 + 路径（左） */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          {version ? (
            <span className="font-mono text-xs text-muted-foreground">v{version}</span>
          ) : null}
        </div>
        {binaryPath ? (
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={binaryPath}>
            {binaryPath}
          </div>
        ) : null}
      </div>

      {/* 状态 Badge（右） */}
      <div className="flex shrink-0 items-center gap-2">
        {probing ? (
          <Badge variant="secondary">
            <Loader2Icon className="size-3 animate-spin" />检测中
          </Badge>
        ) : available ? (
          <Badge variant="default">已安装</Badge>
        ) : (
          <Badge variant="secondary">未安装</Badge>
        )}

        {!available && !probing ? (
          <LoadingButton size="sm" loading={installing} onClick={onInstall}>
            自动安装
          </LoadingButton>
        ) : null}
      </div>
    </div>
  );
}

/** winget 安装二次确认 Dialog。target=null 时不渲染（受控）。 */
function InstallConfirmDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: InstallTarget | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // 根据 target 类型取展示元数据（CLI 或运行时）。
  const meta = target
    ? CLI_TOOL_META[target as CliToolId] ?? RUNTIME_META[target as RuntimeInstallTarget]
    : null;
  const open = target !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader {...dragRegionProps}>
          <DialogTitle data-tauri-drag-region>确认安装 {meta?.label ?? '组件'}</DialogTitle>
          <DialogDescription>
            将通过系统包管理器安装 <span className="font-mono">{meta?.wingetId}</span>。
            安装可能需要管理员权限确认。
            仅 Windows 支持自动安装，macOS/Linux 请手动安装。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button onClick={onConfirm}>确认安装</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
