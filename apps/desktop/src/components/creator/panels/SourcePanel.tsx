import { Code2Icon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DraftFile } from '@/lib/types';

export function SourcePanel({ files, activeFile, activeContent, onActiveFileChange }: { files: DraftFile[]; activeFile: string; activeContent: string; onActiveFileChange: (value: string) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Code2Icon className="size-4" />源码</CardTitle>
      </CardHeader>
      <CardContent>
        {files.length ? (
          <>
            <Tabs value={activeFile} onValueChange={onActiveFileChange}>
              <TabsList className="max-w-full overflow-x-auto overflow-y-hidden scrollbar-thin">{files.map((file) => <TabsTrigger key={file.path} value={file.path}>{file.path}</TabsTrigger>)}</TabsList>
            </Tabs>
            <pre className="scrollbar-thin mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{activeContent}</pre>
          </>
        ) : <p className="text-sm text-muted-foreground">暂无源码。</p>}
      </CardContent>
    </Card>
  );
}