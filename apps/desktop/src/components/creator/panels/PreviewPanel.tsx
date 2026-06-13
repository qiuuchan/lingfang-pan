import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { parseManifest, previewSrcDoc } from '@/lib/plugin-draft';
import type { ScriptRuntime } from '@/lib/plugin-script';
import type { DraftFile } from '@/lib/types';
import { ScriptPreviewPanel } from './ScriptPreviewPanel';

// 按 runtime_type 分派预览：
// - client（含默认）：走现有 iframe srcDoc 预览（HTML/iframe 运行时）。
// - nodejs/python：走 ScriptPreviewPanel 终端预览（R3 本地脚本执行）。
// cloud 不在桌面壳本地预览范围（云端执行），此处无文件时退回空态。
function isScriptRuntime(runtime: string): runtime is ScriptRuntime {
  return runtime === 'nodejs' || runtime === 'python';
}

export function PreviewPanel({ files, previewKey, onRefresh }: { files: DraftFile[]; previewKey: number; onRefresh: () => void }) {
  const runtime = parseManifest(files).runtime_type;
  if (isScriptRuntime(runtime)) {
    return <ScriptPreviewPanel files={files} runtime={runtime} previewKey={previewKey} onRefresh={onRefresh} />;
  }
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
