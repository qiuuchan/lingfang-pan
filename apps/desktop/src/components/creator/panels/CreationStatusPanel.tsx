import { CheckCircle2Icon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Info } from '../Info';
import { cn } from '@/lib/utils';
import { STATUS_LABEL, parseManifest } from '@/lib/plugin-draft';
import type { DraftFile } from '@/lib/types';

export function CreationStatusPanel({ status, files, diagnostics }: { status?: string; files: DraftFile[]; diagnostics: { stage: string; status: string; message: string }[] }) {
  const manifest = parseManifest(files);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">创建状态</CardTitle>
        <CardDescription>{files.length ? `${manifest.name} v${manifest.version}` : '还没有插件草稿'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Info label="状态" value={status ? STATUS_LABEL[status] || status : '未开始'} truncate />
          <Info label="文件" value={`${files.length} 个`} truncate />
          <Info label="入口" value={manifest.entry} />
          <Info label="运行环境" value={manifest.runtime_type} truncate />
        </div>
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2 font-medium"><CheckCircle2Icon className="size-4 text-primary" />检查结果</div>
          {diagnostics.length ? diagnostics.map((item, index) => (
            <div
              key={index}
              className={cn(
                'flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs',
                item.status === 'pass' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30' : 'border-destructive/30 bg-destructive/5 text-destructive'
              )}
            >
              <span className="shrink-0 font-medium">[{item.stage}]</span>
              <span className="break-words">{item.status} — {item.message}</span>
            </div>
          )) : (
            <div className="rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">暂无检查结果。</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}