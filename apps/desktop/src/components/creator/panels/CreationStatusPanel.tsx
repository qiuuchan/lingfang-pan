import { CheckCircle2Icon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Info } from '../Info';
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
          <Info label="状态" value={status ? STATUS_LABEL[status] || status : '未开始'} />
          <Info label="文件" value={`${files.length} 个`} />
          <Info label="入口" value={manifest.entry} />
          <Info label="运行时" value={manifest.runtime_type} />
        </div>
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2 font-medium"><CheckCircle2Icon className="size-4 text-primary" />诊断</div>
          {diagnostics.length ? diagnostics.map((item, index) => (
            <p key={index} className={item.status === 'pass' ? 'text-emerald-600' : 'text-destructive'}>[{item.stage}] {item.status} — {item.message}</p>
          )) : <p className="text-muted-foreground">暂无诊断。</p>}
        </div>
      </CardContent>
    </Card>
  );
}