import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SettingsIcon, ToggleLeftIcon, ToggleRightIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid, ActionBar } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { Plugin, PluginStatus } from '@/lib/types';
import { labelOf, formatTime } from '@/lib/types';

export function PluginsView() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const load = () => api<{ plugins: Plugin[] }>('/api/admin/plugins').then((r) => setPlugins(r.plugins));
  useLoad(load);
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(plugins);

  async function toggle(plugin: Plugin) {
    await run(
      () =>
        api(`/api/admin/plugins/${plugin.id}`, {
          method: 'PATCH',
          body: { status: plugin.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' },
        }).then(load),
      plugin.status === 'ENABLED' ? '插件已禁用' : '插件已启用',
    );
  }

  return (
    <Section title="插件管理" description="管理端只做平台治理，插件创建在本地客户端完成。">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>插件</TableHead>
            <TableHead>说明</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="w-[180px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.length ? (
            paginated.map((plugin) => (
              <TableRow key={plugin.id}>
                <TableCell className="font-medium">{plugin.name}</TableCell>
                <TableCell className="max-w-md truncate text-muted-foreground">
                  {plugin.description || '—'}
                </TableCell>
                <TableCell><StatusBadge value={plugin.status} /></TableCell>
                <TableCell>
                  <ActionBar>
                    <PluginEditDialog plugin={plugin} onRefresh={load}>
                      <Button variant="outline" size="sm">
                        <SettingsIcon className="mr-1 size-3.5" />
                        治理
                      </Button>
                    </PluginEditDialog>
                    <Button
                      variant={plugin.status === 'ENABLED' ? 'destructive' : 'outline'}
                      size="sm"
                      onClick={() => toggle(plugin)}
                    >
                      {plugin.status === 'ENABLED' ? (
                        <ToggleLeftIcon className="mr-1 size-3.5" />
                      ) : (
                        <ToggleRightIcon className="mr-1 size-3.5" />
                      )}
                      {plugin.status === 'ENABLED' ? '禁用' : '启用'}
                    </Button>
                  </ActionBar>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                暂无平台插件
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <Pagination
        totalItems={totalItems}
        pageSize={pageSize}
        currentPage={page}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </Section>
  );
}

function PluginEditDialog({
  plugin,
  children,
  onRefresh,
}: {
  plugin: Plugin;
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(plugin.description || '');
  const [status, setStatus] = useState<PluginStatus>(plugin.status);

  useEffect(() => {
    setDescription(plugin.description || '');
    setStatus(plugin.status);
  }, [plugin]);

  async function save() {
    // ADMIN-VIEW-04 修复：仅成功才关闭对话框，失败保留已编辑的描述/状态。
    if (!(await run(
      () =>
        api(`/api/admin/plugins/${plugin.id}`, {
          method: 'PATCH',
          body: { description, status },
        }).then(onRefresh),
      '插件治理信息已更新',
    ))) return;
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>插件治理</DialogTitle>
          <DialogDescription>{plugin.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <InfoGrid
            items={[
              ['插件 ID', plugin.id],
              ['插件名称', plugin.name],
              ['当前状态', labelOf(plugin.status)],
              ['更新时间', formatTime(plugin.updatedAt)],
            ]}
          />
          <div className="space-y-2">
            <Label>插件说明</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>治理状态</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as PluginStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ENABLED">已启用</SelectItem>
                <SelectItem value="DISABLED">已禁用</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save}>保存治理信息</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}