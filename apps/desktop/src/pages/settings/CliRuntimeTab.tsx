// CliRuntimeTab.tsx — 设置页 Tab1：软件内置脚本运行环境状态。
//
// 职责：
// - 渲染 2 行（nodejs/python），每行只展示
//   名称 / 版本 / 内置状态 Badge。
// - 探测副作用上提到 Settings 顶层（design B13）：本组件纯展示 + 把用户意图
//   回调出去（onProbeAll），不自己 tauriInvoke，避免 keepMounted 时切 Tab 丢 state。
//
// 数据来源（全部 Rust serde 命名，与 HTTP DTO camelCase 不同，见 lib/cli-types.ts 注释）：
// - runtimeResults：probe_script_runtime(nodejs/python) 各一次，可能为 null（探测失败置空）。
//
// 运行时只能来自应用包内的 runtimes/ 目录；不再引导安装或使用系统 Node/Python。

import { CpuIcon, RefreshCwIcon, Loader2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import type { ProbeResult, RuntimeTarget } from '@/lib/cli-types';

export interface CliRuntimeTabProps {
  /** 2 运行时探测结果，null 表示尚未探测。每项可为 null（探测抛错兜底）。 */
  runtimeResults: Partial<Record<RuntimeTarget, ProbeResult | null>> | null;
  /** 是否正在重新探测全部。 */
  probing: boolean;
  /** 重新探测全部（按钮触发）。 */
  onProbeAll: () => void;
}

/** 运行时展示顺序（固定 nodejs → python）。 */
const RUNTIME_ORDER: RuntimeTarget[] = ['nodejs', 'python'];
const RUNTIME_LABELS: Record<RuntimeTarget, string> = {
  nodejs: 'Node.js',
  python: 'Python',
};

export function CliRuntimeTab({
  runtimeResults,
  probing,
  onProbeAll,
}: CliRuntimeTabProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* 顶部操作区：重新检测全部 */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          插件运行和开发命令只使用应用包内置的 Node.js 与 Python。
        </div>
        <LoadingButton variant="outline" size="sm" loading={probing} onClick={onProbeAll}>
          <RefreshCwIcon />重新检测全部
        </LoadingButton>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CpuIcon className="size-4 text-primary" />
            <CardTitle>脚本运行环境</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {RUNTIME_ORDER.map((rtId) => {
            const result = runtimeResults?.[rtId] ?? undefined;
            const available = result?.available ?? false;
            return (
              <RuntimeRow
                key={rtId}
                label={RUNTIME_LABELS[rtId]}
                version={result?.version ?? null}
                available={available}
                // 运行时探测结果可能为 null（探测失败）且 runtimeResults 已加载 → 检测中态隐藏，
                // 显示未装即可（available=false）。仅当 runtimeResults===null（未发起探测）时显示检测中。
                probing={runtimeResults === null}
              />
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function formatRuntimeVersion(label: string, version: string | null): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  const withoutLabel = trimmed.toLowerCase().startsWith(label.toLowerCase())
    ? trimmed.slice(label.length).trim()
    : trimmed;
  const normalized = withoutLabel.replace(/^v/i, '');
  return normalized || version.trim();
}

/** 单行展示：名称 + 版本 + 状态 Badge。 */
function RuntimeRow({
  label,
  version,
  available,
  probing,
}: {
  label: string;
  version: string | null;
  available: boolean;
  probing: boolean;
}) {
  const displayVersion = formatRuntimeVersion(label, version);
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-3">
      {/* 名称 + 版本（左） */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          {displayVersion ? (
            <span className="font-mono text-xs text-muted-foreground">{displayVersion}</span>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">仅使用软件内的运行时</div>
      </div>

      {/* 状态 Badge（右） */}
      <div className="flex shrink-0 items-center gap-2">
        {probing ? (
          <Badge variant="secondary">
            <Loader2Icon className="size-3 animate-spin" />检测中
          </Badge>
        ) : available ? (
          <Badge variant="default">软件内置</Badge>
        ) : (
          <Badge variant="secondary">未识别</Badge>
        )}
      </div>
    </div>
  );
}
