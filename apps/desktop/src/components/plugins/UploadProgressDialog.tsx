// UploadProgressDialog.tsx — 插件上传进度弹窗。
//
// 在插件发布到团队/市场时弹出，显示真实字节级上传进度：
// - 进度条（百分比 + 已传/总量 + 速度 MB/s）
// - 阶段提示：「正在读取插件文件…」→「正在上传…（XX%）」→「上传完成」/「上传失败」
// - 上传中不可关闭（避免误触中断），完成后自动关闭或手动关闭。
//
// 进度数据来源：submitStagedPlugin → uploadPlugin（Rust Channel UploadEvent）。
// 与 Settings.tsx 的下载进度条同款样式（inline bar，非 shadcn Progress 组件）。
import { Loader2Icon, CheckCircle2Icon, XCircleIcon, UploadIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/tickets';
import type { UploadProgress } from '@/lib/plugin-upload';

/** 上传阶段（决定弹窗内容和图标）。 */
export type UploadStage = 'reading' | 'uploading' | 'done' | 'error';

interface UploadProgressDialogProps {
  open: boolean;
  stage: UploadStage;
  progress: UploadProgress | null;
  pluginName: string;
  errorMessage?: string;
  onClose: () => void;
}

export function UploadProgressDialog({
  open,
  stage,
  progress,
  pluginName,
  errorMessage,
  onClose,
}: UploadProgressDialogProps) {
  const canClose = stage === 'done' || stage === 'error';
  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.uploaded / progress.total) * 100))
    : null;

  const titleText = stage === 'reading'
    ? '正在准备插件文件…'
    : stage === 'uploading'
    ? '正在上传插件…'
    : stage === 'done'
    ? '上传完成'
    : '上传失败';

  const statusText = stage === 'reading'
    ? `正在读取「${pluginName}」的源文件…`
    : stage === 'uploading'
    ? percent !== null
      ? `${percent}% · ${formatBytes(progress!.uploaded)} / ${formatBytes(progress!.total)}`
      : `${formatBytes(progress?.uploaded ?? 0)} 已上传`
    : stage === 'done'
    ? `「${pluginName}」已成功发布`
    : errorMessage ?? '上传过程中发生错误';

  const speedText = progress && progress.speed > 0 && stage === 'uploading'
    ? `${formatSpeed(progress.speed)}`
    : null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && canClose) onClose(); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={canClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {stage === 'reading' || stage === 'uploading' ? (
              <Loader2Icon className="size-5 animate-spin text-primary" />
            ) : stage === 'done' ? (
              <CheckCircle2Icon className="size-5 text-emerald-500" />
            ) : (
              <XCircleIcon className="size-5 text-destructive" />
            )}
            {titleText}
          </DialogTitle>
          <DialogDescription className="sr-only">插件上传进度</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* 阶段提示 */}
          <div className="flex items-center gap-2 text-sm">
            <UploadIcon className="size-4 text-muted-foreground" />
            <span className="text-muted-foreground">{statusText}</span>
          </div>

          {/* 进度条（reading 阶段显示不确定动画，uploading 阶段显示百分比） */}
          {(stage === 'uploading' || stage === 'reading') && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{stage === 'reading' ? '准备中…' : speedText ?? '上传中…'}</span>
                <span>
                  {percent !== null ? `${percent}%` : stage === 'reading' ? '…' : ''}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                {stage === 'reading' ? (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                ) : percent !== null ? (
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${percent}%` }}
                  />
                ) : (
                  <div className="h-full w-1/4 animate-pulse rounded-full bg-primary" />
                )}
              </div>
            </div>
          )}

          {/* 错误详情 */}
          {stage === 'error' && errorMessage && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <pre className="scrollbar-thin max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive">
                {errorMessage}
              </pre>
            </div>
          )}

          {/* 完成后提示 */}
          {stage === 'done' && (
            <p className="text-sm text-muted-foreground">
              插件已发布到团队空间，可在「团队插件」中查看。
            </p>
          )}
        </div>

        {canClose && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              {stage === 'done' ? '完成' : '关闭'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 速度格式化（bytes/sec → KB/s 或 MB/s）。 */
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}
