// 作者中心：集中管理「我的插件」（GET /api/plugins/mine）。
// 复用 author-actions 的作者操作组件（编辑信息 / 改价 / 启停 / 提交上架 / 删除），
// 与「插件」页的 PluginList 共享同一套操作实现，避免重复。
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PackageIcon, RefreshCwIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, type ApiError } from '@/lib/api';
import { fmtYuan } from '@/lib/money';
import type { LoadedPlugin } from '@/lib/types';
import { Shimmer, StaggerContainer, StaggerItem } from '@/lib/motion';
import { useApp } from '@/App';
import {
  PluginDeleteDialog,
  PluginIcon,
  PluginMetaEditDialog,
  PluginPriceEditDialog,
  PluginStatusToggle,
  PluginSubmitDialog,
  readPluginIcon,
} from '@/components/plugins/author-actions';

// 审核状态 → 中文 + Badge variant（与 PluginList 保持一致的语义）。
const REVIEW_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
};

export function AuthorCenter() {
  const { setRunningPlugin, setView } = useApp();
  const [list, setList] = useState<LoadedPlugin[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await api<{ plugins: LoadedPlugin[] }>('/api/plugins/mine');
      setList(result.plugins);
      setError('');
    } catch (e) {
      setError((e as ApiError).message || '加载失败');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">作者中心</h1>
        <p className="text-sm text-muted-foreground">管理你创建的插件：编辑信息、定价、启停、提交上架与删除。</p>
      </div>
      <Card className="w-full">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <CardTitle>我的插件</CardTitle>
            <span className="text-xs text-muted-foreground">{list?.length ?? 0} 个</span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新"
            disabled={refreshing}
            onClick={() => void load()}
          >
            <RefreshCwIcon className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent>
          {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
          {list === null ? (
            // 加载骨架：4 行占位。
            <div className="flex flex-col divide-y rounded-lg border">
              {Array.from({ length: 4 }).map((_, i) => <Shimmer key={i} className="h-16 w-full rounded-none" />)}
            </div>
          ) : list.length ? (
            <StaggerContainer className="flex flex-col divide-y rounded-lg border" stagger={0.05}>
              {list.map((plugin) => (
                <StaggerItem key={plugin.id}>
                  <AuthorPluginRow plugin={plugin} onChanged={() => void load()} onOpen={() => { setRunningPlugin(plugin); setView('plugins'); }} />
                </StaggerItem>
              ))}
            </StaggerContainer>
          ) : (
            !error && (
              // 空态：引导去创建插件。
              <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
                <PackageIcon className="size-8 text-muted-foreground/50" />
                <span>还没有创建过插件</span>
                <Button variant="outline" size="sm" onClick={() => setView('home')}>去创建插件</Button>
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// 单个插件行：图标 + 名称 + 审核/价格/启停角标 + 作者操作区。
// 点击名称区进入「插件」页运行该插件（setRunningPlugin + 切 view）。
function AuthorPluginRow({ plugin, onChanged, onOpen }: { plugin: LoadedPlugin; onChanged: () => void; onOpen: () => void }) {
  const isDisabled = plugin.status === 'DISABLED';
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      <Button variant="ghost" className="flex min-w-0 flex-1 items-center justify-start gap-3 rounded-none px-0 text-left" onClick={onOpen}>
        <PluginIcon icon={readPluginIcon(plugin)} className="size-9 shrink-0 rounded-lg object-cover" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{plugin.name}</span>
            {plugin.reviewStatus && (
              <Badge variant={plugin.reviewStatus === 'APPROVED' ? 'secondary' : 'outline'} className="shrink-0 text-xs">
                {REVIEW_LABEL[plugin.reviewStatus] || plugin.reviewStatus}
              </Badge>
            )}
            {typeof plugin.priceCents === 'number' && (
              <Badge variant={plugin.priceCents > 0 ? 'default' : 'secondary'} className="shrink-0 text-xs">
                {fmtYuan(plugin.priceCents)}
              </Badge>
            )}
            {isDisabled && <Badge variant="destructive" className="shrink-0 text-xs">已禁用</Badge>}
          </div>
          <div className="truncate text-sm text-muted-foreground">{plugin.description || '—'}</div>
        </div>
      </Button>
      <div className="flex shrink-0 items-center gap-1">
        <PluginMetaEditDialog plugin={plugin} onSaved={onChanged} />
        <PluginPriceEditDialog plugin={plugin} onSaved={onChanged} />
        <PluginSubmitDialog plugin={plugin} onSubmitted={onChanged} />
        <PluginStatusToggle plugin={plugin} onToggled={onChanged} />
        <PluginDeleteDialog plugin={plugin} onDeleted={onChanged} />
        <span className="ml-1 text-xs text-muted-foreground">v{plugin.version}</span>
      </div>
    </div>
  );
}
