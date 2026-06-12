import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { previewSrcDoc } from '@/lib/plugin-draft';
import type { DraftFile } from '@/lib/types';

export function PreviewPanel({ files, previewKey, onRefresh }: { files: DraftFile[]; previewKey: number; onRefresh: () => void }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">预览</CardTitle>
        <Button variant="ghost" size="icon-sm" disabled={!files.length} onClick={onRefresh}><RefreshCwIcon className="size-4" /></Button>
      </CardHeader>
      <CardContent>
        {files.length ? (
          <iframe key={previewKey} title="plugin-preview" sandbox="allow-scripts" srcDoc={previewSrcDoc(files)} className="h-[360px] w-full rounded-lg border bg-white" />
        ) : (
          <div className="flex h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">生成插件后显示预览。</div>
        )}
      </CardContent>
    </Card>
  );
}