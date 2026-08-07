// PluginManifestDialog.tsx — 插件 manifest.json 详情弹窗（体验完善需求 1）。
//
// 职责：所有插件（本地 / 团队 / 市场 / 内置）都能以统一 shadcn Dialog 展示自身的基础信息。
// 数据来源：从插件 files 中解析 manifest.json（parseManifest），或直接用已解析的 LoadedPlugin 字段。
//
// 展示分两部分：
// 1. 关键字段网格（id / title / name / version / runtime_type / entry / visibility / capabilities / 描述），
//    每项用 Badge / 等宽字体呈现，一眼可读。
// 2. 原始 manifest.json（格式化高亮，ScrollArea 限高），便于排查/核对完整契约。
//
// 容错：插件无 files（市场付费插件脱敏）时只展示 LoadedPlugin 已有字段，原始 JSON 区隐藏。

import { useEffect, useState } from 'react';
import { FileJsonIcon, ShieldCheckIcon, ShieldAlertIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { parseManifest } from '@/lib/plugin-draft';
import {
  verifyPluginSignature,
  checkPluginRecall,
  type PluginSignatureStatus,
  type PluginRecallInfo,
} from '@/lib/plugin-status';
import type { DraftFile } from '@/lib/types';

// 运行时类型 → 中文展示（与 plugin-status RUNTIME_DISPLAY 对齐，独立维护避免循环依赖）。
const RUNTIME_LABEL: Record<string, string> = {
  client: '网页（软件内 iframe）',
  nodejs: 'Node.js（独立进程）',
  python: 'Python（独立进程 / venv）',
  cloud: '云端运行时',
};

/** manifest 详情弹窗。open / onOpenChange 受控；pluginName 用于标题；files 提供则解析完整 manifest。 */
export function PluginManifestDialog({
  open,
  onOpenChange,
  pluginName,
  files,
  // 兜底字段：插件无 files 时从 LoadedPlugin 直接取（市场付费插件脱敏无 files）。
  fallback,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginName: string;
  files?: DraftFile[];
  fallback?: {
    id?: string;
    name?: string;
    version?: string;
    runtime_type?: string;
    entry?: string;
    description?: string;
  };
}) {
  // 有 files 时解析完整 manifest（含 title / capabilities / visibility）；无则只用 fallback。
  const manifest = files?.length ? parseManifest(files) : null;
  const id = manifest?.id || fallback?.id || '—';
  const title = manifest?.title || pluginName;
  const name = manifest?.name || fallback?.name || '—';
  const version = manifest?.version || fallback?.version || '—';
  const runtimeType = manifest?.runtime_type || fallback?.runtime_type || 'client';
  const entry = manifest?.entry || fallback?.entry || '—';
  const description = manifest?.description || fallback?.description || '';
  const capabilities = manifest?.capabilities ?? [];
  const visibility = manifest?.visibility;

  // 原始 manifest.json 文本（仅 files 含 manifest.json 时展示）。
  const rawManifest = files?.find((file) => file.path === 'manifest.json')?.content;
  const rawPretty = rawManifest ? safePretty(rawManifest) : null;

  // Task 14：签名校验 + 版本召回状态（仅本地插件有意义；非本地/无目录的查询静默失败）。
  const [sig, setSig] = useState<PluginSignatureStatus | null>(null);
  const [recall, setRecall] = useState<PluginRecallInfo | null>(null);
  useEffect(() => {
    if (!open || !id || id === '—') return;
    let cancelled = false;
    void verifyPluginSignature(id)
      .then((s) => {
        if (!cancelled) setSig(s);
      })
      .catch(() => {
        if (!cancelled) setSig(null);
      });
    const ver = version !== '—' ? version : '';
    if (ver)
      void checkPluginRecall(id, ver)
        .then((r) => {
          if (!cancelled) setRecall(r);
        })
        .catch(() => {
          if (!cancelled) setRecall(null);
        });
    return () => {
      cancelled = true;
    };
  }, [open, id, version]);

  // 关键字段网格项：label + value，统一渲染。
  const fields: Array<{ label: string; value: React.ReactNode }> = [
    { label: '插件 ID', value: <code className="font-mono text-xs">{id}</code> },
    { label: '展示名', value: <span className="font-medium">{title}</span> },
    { label: '程序标识符', value: <code className="font-mono text-xs">{name}</code> },
    { label: '版本', value: <Badge variant="secondary">v{version}</Badge> },
    {
      label: '运行时',
      value: <Badge variant="outline">{RUNTIME_LABEL[runtimeType] ?? runtimeType}</Badge>,
    },
    { label: '入口文件', value: <code className="font-mono text-xs">{entry}</code> },
  ];
  if (visibility) {
    fields.push({
      label: '可见范围',
      value: <Badge variant="outline">{visibilityLabel(visibility)}</Badge>,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJsonIcon className="size-4" />
            {pluginName} · 插件信息
          </DialogTitle>
          <DialogDescription>
            该插件的 manifest.json 基础信息。{rawPretty ? '下方为完整原始声明。' : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* 关键字段网格：2 列，每项 label + value。 */}
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
            {fields.map((field) => (
              <div key={field.label} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{field.label}</span>
                <span className="text-sm">{field.value}</span>
              </div>
            ))}
          </div>

          {/* 描述（独立整行，可能较长）。 */}
          {description && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">描述</span>
              <p className="text-sm leading-relaxed">{description}</p>
            </div>
          )}

          {/* 能力声明（capabilities，Badge 列表）。 */}
          {capabilities.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">能力声明（capabilities）</span>
              <div className="flex flex-wrap gap-1.5">
                {capabilities.map((cap, index) => (
                  <Badge
                    key={`${cap.kind}-${index}`}
                    variant="secondary"
                    className="font-mono text-xs"
                  >
                    {cap.kind}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Task 14：安全与版本状态（签名校验 + 召回）。非本地插件查询失败时本区隐藏。 */}
          {(sig || recall) && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">安全与版本状态</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {sig && (
                  <Badge
                    variant="outline"
                    className={
                      sig.verified
                        ? 'border-success/40 text-success'
                        : sig.signed
                          ? 'border-rose-500/40 text-rose-600 dark:text-rose-400'
                          : 'text-muted-foreground'
                    }
                    title={sig.reason}
                  >
                    {sig.verified ? (
                      <ShieldCheckIcon className="mr-1 size-3" />
                    ) : (
                      <ShieldAlertIcon className="mr-1 size-3" />
                    )}
                    {sig.verified ? '签名已验证' : sig.signed ? '签名无效' : '未签名'}
                  </Badge>
                )}
                {recall?.recalled && (
                  <Badge variant="destructive" title={recall.reason || '该版本已被平台召回'}>
                    <ShieldAlertIcon className="mr-1 size-3" />
                    版本已召回（v{recall.version}）
                  </Badge>
                )}
              </div>
              {sig && !sig.verified && (
                <span className="text-[11px] text-muted-foreground">{sig.reason}</span>
              )}
              {recall?.recalled && recall.reason && (
                <span className="text-[11px] text-destructive">{recall.reason}</span>
              )}
            </div>
          )}

          {/* 原始 manifest.json（格式化，ScrollArea 限高滚动）。 */}
          {rawPretty && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">原始 manifest.json</span>
              <ScrollArea className="h-48 rounded-lg border bg-[#0d1117]">
                <pre className="p-3 font-mono text-xs leading-relaxed text-[#e6edf3] whitespace-pre-wrap break-words">
                  {rawPretty}
                </pre>
              </ScrollArea>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** visibility → 中文标签。 */
function visibilityLabel(visibility: string): string {
  switch (visibility) {
    case 'tenant':
    case 'TEAM':
      return '团队';
    case 'private':
    case 'PRIVATE':
      return '仅自己';
    case 'public':
    case 'PUBLIC':
      return '公开（市场）';
    default:
      return visibility;
  }
}

/** 安全格式化 JSON：解析失败时返回原文（避免崩溃）。 */
function safePretty(raw: string): string | null {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
