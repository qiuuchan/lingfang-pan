import { useEffect, useState, type FormEvent } from 'react';
import { LockIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { AsyncResource } from '@/components/ui/async-resource';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSheet } from '@/components/ui/detail-sheet';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableCellAction,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { InfoGrid, Section } from '@/components/shared';
import { adminCoreApi } from '@/components/admin-core/api';
import { LazyRoleEditor } from '@/components/admin-core/lazy-role-editor';
import { usePageCorrection } from '@/components/admin-core/pagination';
import type { RoleSummary } from '@/components/admin-core/types';
import { useAsyncResource } from '@/lib/async-resource';
import { api } from '@/lib/api';
import { run } from '@/lib/helpers';
import { formatTime } from '@/lib/types';

type RoleEditorState = { role?: RoleSummary } | null;

export function RolesView() {
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<RoleSummary | null>(null);
  const [editor, setEditor] = useState<RoleEditorState>(null);
  const [detailVersion, setDetailVersion] = useState(0);

  const roles = useAsyncResource(
    (signal) => adminCoreApi.roles({ page, pageSize, q: query || undefined }, signal),
    [page, pageSize, query],
    { isEmpty: (data) => data.items.length === 0 },
  );

  usePageCorrection(roles.data, page, pageSize, setPage);

  useEffect(() => {
    if (!selected || !roles.data) return;
    const latest = roles.data.items.find((role) => role.id === selected.id);
    if (latest) setSelected(latest);
  }, [roles.data, selected?.id]);

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  }

  function refreshRole(roleId?: string) {
    roles.reload();
    if (roleId && selected?.id === roleId) setDetailVersion((current) => current + 1);
  }

  async function deleteRole(role: RoleSummary) {
    if (!window.confirm(`确认删除角色「${role.name}」？`)) return;
    const ok = await run(
      () => api(`/api/admin/roles/${role.id}`, { method: 'DELETE' }),
      '角色已删除',
    );
    if (!ok) return;
    if (selected?.id === role.id) setSelected(null);
    roles.reload();
  }

  return (
    <Section
      title="角色管理"
      description="平台角色与权限分配。"
      actions={(
        <Button type="button" onClick={() => setEditor({})}>
          <PlusIcon className="size-4" />
          创建角色
        </Button>
      )}
    >
      <div className="space-y-4">
        <form className="flex max-w-md gap-2" onSubmit={applySearch}>
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="搜索角色名或编码"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline">
            <SearchIcon className="size-4" />
            搜索
          </Button>
        </form>

        <AsyncResource
          status={roles.status}
          error={roles.error}
          retry={roles.reload}
          emptyFallback={<div className="py-12 text-center text-sm text-muted-foreground">暂无符合条件的平台角色</div>}
        >
          {roles.data ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>角色</TableHead>
                    <TableHead className="hidden sm:table-cell">编码</TableHead>
                    <TableHead className="hidden md:table-cell">类型</TableHead>
                    <TableHead className="hidden md:table-cell">权限</TableHead>
                    <TableHead className="hidden lg:table-cell">成员</TableHead>
                    <TableHead className="hidden lg:table-cell">创建时间</TableHead>
                    <TableHead className="w-24 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roles.data.items.map((role) => (
                    <TableRow key={role.id}>
                      <TableCell>
                        <TableCellAction
                          aria-label={`查看角色详情：${role.name}`}
                          aria-haspopup="dialog"
                          onClick={() => setSelected(role)}
                        >
                          <span className="flex items-center gap-1.5">
                            {role.isSystem ? <LockIcon className="size-3.5 text-muted-foreground" /> : null}
                            <span className="min-w-0">
                              <span className="block truncate">{role.name}</span>
                              <span className="mt-0.5 block truncate font-mono text-xs font-normal text-muted-foreground sm:hidden">
                                {role.code || '无编码'} · 权限 {role.permissionCount}
                              </span>
                            </span>
                          </span>
                        </TableCellAction>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{role.code ? <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{role.code}</code> : '—'}</TableCell>
                      <TableCell className="hidden md:table-cell"><Badge variant={role.isSystem ? 'default' : 'secondary'}>{role.isSystem ? '内置' : '自定义'}</Badge></TableCell>
                      <TableCell className="hidden md:table-cell">{role.permissionCount}</TableCell>
                      <TableCell className="hidden lg:table-cell">{role.memberCount}</TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">{formatTime(role.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button type="button" variant="ghost" size="icon" aria-label={`编辑角色：${role.name}`} onClick={() => setEditor({ role })}>
                          <PencilIcon className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                totalItems={roles.data.total}
                pageSize={pageSize}
                currentPage={page}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </>
          ) : null}
        </AsyncResource>
      </div>

      <RoleDetailSheet
        role={selected}
        refreshKey={detailVersion}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        onEdit={(role) => setEditor({ role })}
        onDelete={(role) => void deleteRole(role)}
      />

      {editor ? (
        <LazyRoleEditor
          scope="platform"
          roleId={editor.role?.id}
          title={editor.role ? `编辑平台角色：${editor.role.name}` : '创建平台角色'}
          onClose={() => setEditor(null)}
          onSubmit={async (body) => {
            const path = editor.role ? `/api/admin/roles/${editor.role.id}` : '/api/admin/roles';
            const result = await api(path, { method: editor.role ? 'PATCH' : 'POST', body });
            refreshRole(editor.role?.id);
            return result;
          }}
        />
      ) : null}
    </Section>
  );
}

function RoleDetailSheet({
  role,
  refreshKey,
  onOpenChange,
  onEdit,
  onDelete,
}: {
  role: RoleSummary | null;
  refreshKey: number;
  onOpenChange: (open: boolean) => void;
  onEdit: (role: RoleSummary) => void;
  onDelete: (role: RoleSummary) => void;
}) {
  const roleId = role?.id ?? '';
  const detail = useAsyncResource(
    (signal) => adminCoreApi.roleDetail(roleId, signal),
    [roleId, refreshKey],
    { enabled: !!roleId },
  );
  const actionableRole = detail.data?.id === roleId ? role : null;

  return (
    <DetailSheet
      open={!!role}
      onOpenChange={onOpenChange}
      title={role?.name || ''}
      description={role?.code || '平台角色'}
      footer={actionableRole ? (
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={() => onEdit(actionableRole)}>
            <PencilIcon className="size-4" />
            编辑角色
          </Button>
          {!actionableRole.isSystem ? (
            <Button type="button" variant="destructive" className="flex-1" onClick={() => onDelete(actionableRole)}>
              <Trash2Icon className="size-4" />
              删除角色
            </Button>
          ) : null}
        </div>
      ) : null}
    >
      <AsyncResource status={detail.status} error={detail.error} retry={detail.reload}>
        {detail.data ? (
          <div className="space-y-4">
            <InfoGrid items={[
              ['角色 ID', detail.data.id],
              ['名称', detail.data.name],
              ['编码', detail.data.code || '—'],
              ['类型', detail.data.isSystem ? '内置角色' : '自定义角色'],
              ['成员', String(detail.data.memberCount)],
              ['权限', String(detail.data.permissions.length)],
              ['创建时间', formatTime(detail.data.createdAt)],
            ]} />
            {detail.data.description ? <p className="rounded-lg border px-3 py-3 text-sm">{detail.data.description}</p> : null}
            <div className="flex flex-wrap gap-2">
              {detail.data.permissions.map((permission) => (
                <Badge key={permission} variant="secondary">{permission}</Badge>
              ))}
            </div>
          </div>
        ) : null}
      </AsyncResource>
    </DetailSheet>
  );
}
