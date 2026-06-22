// 平台角色管理视图（collab-admin web）。
// 列出平台级角色 + 创建/编辑/删除 + 权限码两级勾选面板（模块 → 操作）。
// 内置角色（isSystem=true）锁定权限编辑、不可删除；可改显示名/描述。
// 后端：GET/POST /api/admin/roles、PATCH/DELETE /api/admin/roles/:id、GET /api/admin/roles/permissions、
//       GET/PUT /api/admin/permission-groups、DELETE /api/admin/permission-groups/:groupKey。
//
// 角色编辑对话框 + 权限勾选面板已抽公共组件（role-edit-dialog.tsx / role-permission-checklist.tsx），
// 团队详情「角色」tab（teams-view）复用同一套组件，避免平台/团队角色面板逻辑近乎重复。
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PlusIcon, PencilIcon, Trash2Icon, LockIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section } from '@/components/shared';
import { Badge } from '@/components/ui/badge';
import type { PermissionEntry, PermissionGroup, Role } from '@/lib/types';
import { formatTime } from '@/lib/types';
import { RoleEditDialog } from '@/components/role-edit-dialog';

export function RolesView() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<PermissionEntry[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    const [r, p, g] = await Promise.all([
      api<{ roles: Role[] }>('/api/admin/roles'),
      api<{ permissions: PermissionEntry[] }>('/api/admin/roles/permissions'),
      api<{ groups: PermissionGroup[] }>('/api/admin/permission-groups').catch(() => ({ groups: [] })),
    ]);
    setRoles(r.roles);
    setPermissions(p.permissions);
    setGroups(g.groups);
  };
  useLoad(load);

  // 自定义分组显示名覆盖：groupKey → displayName
  const groupLabelOverride = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      if (g.customized) map.set(g.groupKey, g.displayName);
    }
    return map;
  }, [groups]);

  return (
    <div className="space-y-8">
      <Section title="角色管理" description="管理平台级自定义角色与权限分配。内置角色权限锁定，可创建自定义角色按需勾选权限。">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm text-muted-foreground">{roles.length} 个角色</div>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon className="mr-1.5 size-4" />
            创建角色
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>角色名</TableHead>
              <TableHead>编码</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>权限数</TableHead>
              <TableHead>成员数</TableHead>
              <TableHead>说明</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-1.5">
                    {role.isSystem && <LockIcon className="size-3.5 text-muted-foreground" />}
                    {role.name}
                  </div>
                </TableCell>
                <TableCell>
                  {role.code ? (
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{role.code}</code>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {role.isSystem ? (
                    <Badge variant="default">内置</Badge>
                  ) : (
                    <Badge variant="secondary">自定义</Badge>
                  )}
                </TableCell>
                <TableCell>{role.permissions.length}</TableCell>
                <TableCell>{role.memberCount}</TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">{role.description || '—'}</TableCell>
                <TableCell className="text-muted-foreground">{formatTime(role.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setEditing(role)} title="编辑">
                      <PencilIcon className="size-4" />
                    </Button>
                    {!role.isSystem && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="删除"
                        onClick={async () => {
                          if (!confirm(`确定删除角色「${role.name}」？`)) return;
                          await run(
                            () => api(`/api/admin/roles/${role.id}`, { method: 'DELETE' }).then(load),
                            '角色已删除',
                          );
                        }}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      {creating && (
        <RoleEditDialog
          permissions={permissions}
          groupLabelOverride={groupLabelOverride}
          title="创建平台角色"
          description="勾选该角色拥有的平台权限，用户被分配此角色后即获得这些权限。"
          onClose={() => setCreating(false)}
          onSubmit={async (body) => {
            const ok = await run(() => api('/api/admin/roles', { method: 'POST', body }), '角色已创建');
            if (ok) await load();
            return ok;
          }}
        />
      )}
      {editing && (
        <RoleEditDialog
          role={editing}
          permissions={permissions}
          groupLabelOverride={groupLabelOverride}
          title={`编辑角色：${editing.name}`}
          description="勾选该角色拥有的平台权限，用户被分配此角色后即获得这些权限。"
          onClose={() => setEditing(null)}
          onSubmit={async (body) => {
            const ok = await run(() => api(`/api/admin/roles/${editing.id}`, { method: 'PATCH', body }), '角色已更新');
            if (ok) await load();
            return ok;
          }}
        />
      )}
    </div>
  );
}
