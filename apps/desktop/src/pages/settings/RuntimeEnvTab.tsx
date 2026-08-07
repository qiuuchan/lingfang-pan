import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CpuIcon,
  Loader2Icon,
  RefreshCwIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/lib/api';
import {
  RUNTIME_LABEL,
  formatVersion,
  getRuntimeStatus,
  type RuntimeKind,
  type RuntimeStatusMap,
} from '@/lib/runtime-config';

const RUNTIME_ORDER: RuntimeKind[] = ['python', 'node', 'ffmpeg', 'chromium'];

export function RuntimeEnvTab() {
  const [statusMap, setStatusMap] = useState<RuntimeStatusMap | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatusMap(await getRuntimeStatus());
    } catch (error) {
      toast.error(errorMessage(error, '读取内置运行环境失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="pb-8">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <CpuIcon className="size-5 text-muted-foreground" />
              <CardTitle>内置运行环境</CardTitle>
            </div>
            <CardDescription>插件运行、创建、预览和依赖安装统一使用软件内置环境。</CardDescription>
          </div>
          <Button
            size="icon"
            variant="outline"
            title="刷新运行环境状态"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon className={loading ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        </CardHeader>
        <CardContent>
          {loading && !statusMap ? (
            <div className="flex h-28 items-center justify-center text-muted-foreground">
              <Loader2Icon className="size-5 animate-spin" />
            </div>
          ) : (
            <div className="divide-y">
              {RUNTIME_ORDER.map((kind) => {
                const status = statusMap?.[kind];
                const available = status?.available === true;
                return (
                  <div
                    key={kind}
                    className="flex min-h-20 flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {available ? (
                          <CheckCircle2Icon className="size-4 text-success" />
                        ) : (
                          <CircleAlertIcon className="size-4 text-destructive" />
                        )}
                        <span className="font-medium">{RUNTIME_LABEL[kind]}</span>
                        {status?.version && (
                          <span className="text-sm text-muted-foreground">
                            {formatVersion(RUNTIME_LABEL[kind], status.version)}
                          </span>
                        )}
                      </div>
                      <div className="break-all text-xs text-muted-foreground">
                        {status?.binaryPath ?? status?.error ?? '未读取到内置运行时信息'}
                      </div>
                    </div>
                    <Badge variant={available ? 'default' : 'destructive'}>
                      {available ? '内置可用' : '缺失'}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
