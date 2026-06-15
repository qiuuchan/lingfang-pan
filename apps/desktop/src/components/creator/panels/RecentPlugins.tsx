import { ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { LoadedPlugin } from '@/lib/types';

export function RecentPlugins({ plugins, onRun }: { plugins: LoadedPlugin[]; onRun: (plugin: LoadedPlugin) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">最近插件</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {plugins.length ? plugins.map((plugin) => (
          <Button key={plugin.id} variant="ghost" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left h-auto" onClick={() => onRun(plugin)}>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{plugin.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{plugin.description || plugin.id}</span>
            </span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        )) : <p className="py-2 text-center text-sm text-muted-foreground">还没有运行过的插件</p>}
      </CardContent>
    </Card>
  );
}