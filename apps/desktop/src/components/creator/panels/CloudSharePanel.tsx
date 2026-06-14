import { CloudUploadIcon, PlayIcon, StoreIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import type { LoadedPlugin } from '@/lib/types';

// 审核状态码 → 用户可见文案（PENDING/APPROVED/REJECTED/DRAFT 是后端返回的英文码，展示时转中文）。
const REVIEW_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '审核中',
  APPROVED: '已通过',
  REJECTED: '未通过',
};

export function CloudSharePanel({
  cloudPlugin,
  disabled,
  submitting,
  uploading,
  onRun,
  onSubmitMarketplace,
  onUpload,
}: {
  cloudPlugin: LoadedPlugin | null;
  disabled: boolean;
  submitting: boolean;
  uploading: boolean;
  onRun: () => void;
  onSubmitMarketplace: () => void;
  onUpload: () => void;
}) {
  const reviewStatus = cloudPlugin?.reviewStatus;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><CloudUploadIcon className="size-4" />团队共享</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <LoadingButton className="w-full" loading={uploading} disabled={disabled} onClick={onUpload}>上传到团队共享</LoadingButton>
        {cloudPlugin ? (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between gap-2"><span className="font-medium">{cloudPlugin.name}</span><Badge variant="secondary">{(reviewStatus && REVIEW_STATUS_LABEL[reviewStatus]) || '草稿'}</Badge></div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{cloudPlugin.id}</p>
            {cloudPlugin.reviewReason && <p className="mt-1 text-xs text-destructive">未通过原因：{cloudPlugin.reviewReason}</p>}
          </div>
        ) : <p className="text-sm text-muted-foreground">上传后，团队成员可在插件页运行。</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={!cloudPlugin} onClick={onRun}><PlayIcon className="size-4" />运行</Button>
          <LoadingButton variant="outline" loading={submitting} disabled={!cloudPlugin || reviewStatus === 'PENDING' || reviewStatus === 'APPROVED'} onClick={onSubmitMarketplace}><StoreIcon className="size-4" />发布到插件市场</LoadingButton>
        </div>
      </CardContent>
    </Card>
  );
}