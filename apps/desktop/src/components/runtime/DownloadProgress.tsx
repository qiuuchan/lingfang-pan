// DownloadProgress.tsx — 运行时下载进度条（task 07-03 Step 5/6）。
//
// 订阅 runtime-download-stage / runtime-download-progress event 后由父组件驱动：
// 父组件（RuntimeEnvTab / RuntimeSetupGate）把 stage + downloaded/total 透传进来，
// 本组件只负责按 stage 渲染不同的进度条形态（design B/A）。
//
// 进度形态：
// - downloading + total>0：满条 + 百分比。
// - downloading + total=null：不定宽条（36%）+ 已下载字节数。
// - verifying/extracting/activating：满条（接近完成）+ 阶段文案。
// - done/failed：满条 + 完成/失败文案（由 stage 决定）。
//
// 样式对齐 Settings.tsx 更新下载进度条（h-2 rounded-full bg-muted + bg-primary transition-[width]）。

import { Loader2Icon, CheckCircle2Icon, AlertCircleIcon } from 'lucide-react';
import {
  formatBytes,
  type DownloadStagePayload,
  type RuntimeKind,
} from '@/lib/runtime-config';
import { RUNTIME_LABEL } from '@/lib/runtime-config';

export interface DownloadProgressProps {
  kind: RuntimeKind;
  stage: DownloadStagePayload['stage'];
  downloaded: number;
  total: number | null;
}

const STAGE_TEXT: Record<DownloadStagePayload['stage'], string> = {
  downloading: '下载中',
  verifying: '校验中',
  extracting: '解压中',
  activating: '激活中',
  done: '已完成',
  failed: '下载失败',
};

export function DownloadProgress({ kind, stage, downloaded, total }: DownloadProgressProps) {
  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  // verifying/extracting/activating 视为接近完成（90%）；downloading 未知 total 用 36% 不定宽条；
  // 其余阶段用真实百分比或满条。
  const widthPercent =
    stage === 'verifying' || stage === 'extracting' || stage === 'activating'
      ? 90
      : stage === 'done'
        ? 100
        : percent !== null
          ? percent
          : 36;

  // 右侧数值：downloading 显示百分比或已下载字节；其余阶段显示对应文案。
  const rightText =
    stage === 'downloading'
      ? percent !== null
        ? `${percent}%`
        : formatBytes(downloaded)
      : STAGE_TEXT[stage];

  // 左侧文案：downloading 区分已知/未知总大小；其余阶段直接用 STAGE_TEXT。
  const leftText =
    stage === 'downloading'
      ? total !== null
        ? `${RUNTIME_LABEL[kind]} 下载中`
        : `${RUNTIME_LABEL[kind]} 下载中（未知总大小）`
      : `${RUNTIME_LABEL[kind]} ${STAGE_TEXT[stage]}`;

  const showSuccessIcon = stage === 'done';
  const showErrorIcon = stage === 'failed';
  const showSpinner =
    stage !== 'done' && stage !== 'failed';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {showSpinner ? <Loader2Icon className="size-3 animate-spin" /> : null}
          {showSuccessIcon ? <CheckCircle2Icon className="size-3 text-primary" /> : null}
          {showErrorIcon ? <AlertCircleIcon className="size-3 text-destructive" /> : null}
          {leftText}
        </span>
        <span className={showErrorIcon ? 'text-destructive' : undefined}>{rightText}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            showErrorIcon ? 'bg-destructive' : 'bg-primary'
          }`}
          style={{ width: `${widthPercent}%` }}
        />
      </div>
    </div>
  );
}
