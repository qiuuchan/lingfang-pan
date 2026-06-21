// 平台角色管理视图（collab-admin web）。
// 列出平台级角色 + 创建/编辑/删除 + 权限码勾选面板（按 group 分组）。
// 内置角色（isSystem=true）锁定权限编辑、不可删除；可改显示名/描述。
// 后端：GET/POST /api/admin/roles、PATCH/DELETE /api/admin/roles/:id、GET /api/admin/roles/permissions。
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PlusIcon, PencilIcon, Trash2Icon, ShieldCheckIcon, LockIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section } from '@/components/shared';
import { Badge } from '@/components/ui/badge';
import type { PermissionEntry, Role } from '@/lib/types';
import { formatTime } from '@/lib/types';

export function RolesView() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<PermissionEntry[]>([]);
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    const [r, p] = await Promise.all([
      api<{ roles: Role[] }>('/api/admin/roles'),
      api<{ permissions: PermissionEntry[] }>('/api/admin/roles/permissions'),
    ]);
    setRoles(r.roles);
    setPermissions(p.permissions);
  };
  useLoad(load);

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
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await load();
          }}
        />
      )}
      {editing && (
        <RoleEditDialog
          role={editing}
          permissions={permissions}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/** 角色编辑/创建对话框：含名称、描述、权限码分组勾选面板。 */
function RoleEditDialog({
  role,
  permissions,
  onClose,
  onSaved,
}: {
  role?: Role | null;
  permissions: PermissionEntry[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isSystem = role?.isSystem ?? false;
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));

  // 权限按 group 分组（供勾选面板折叠展示）
  const groups = useMemo(() => {
    const map = new Map<string, PermissionEntry[]>();
    for (const p of permissions) {
      if (!map.has(p.group)) map.set(p.group, []);
      map.get(p.group)!.push(p);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [permissions]);

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleGroup(group: string, codes: string[]) {
    setSelected((prev) => {
      const allOn = codes.every((c) => prev.has(c));
      const next = new Set(prev);
      if (allOn) codes.forEach((c) => next.delete(c));
      else codes.forEach((c) => next.add(c));
      return next;
    });
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error('角色名不能为空');
      return;
    }
    const body = {
      name: name.trim(),
      description: description.trim(),
      // 系统角色不允许改权限（后端会拒绝），这里也不传 permissions 字段
      ...(isSystem ? {} : { permissions: [...selected] }),
    };
    const ok = role
      ? await run(() => api(`/api/admin/roles/${role.id}`, { method: 'PATCH', body }), '角色已更新')
      : await run(() => api('/api/admin/roles', { method: 'POST', body }), '角色已创建');
    if (ok) await onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <ShieldCheckIcon className="size-5" />
            {role ? `编辑角色：${role.name}` : '创建平台角色'}
          </DialogTitle>
          <DialogDescription>
            {isSystem ? '内置角色权限锁定不可修改，仅可调整名称与说明。' : '勾选该角色拥有的平台权限，用户被分配此角色后即获得这些权限。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>角色名</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="如：运营专员" />
          </div>
          <div className="space-y-2">
            <Label>说明</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} rows={2} placeholder="描述该角色的职责" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>权限分配{isSystem && <span className="ml-2 text-xs text-muted-foreground">（内置角色锁定）</span>}</Label>
              <span className="text-xs text-muted-foreground">已选 {selected.size} / {permissions.length}</span>
            </div>
            <div className={`rounded-md border p-3 ${isSystem ? 'pointer-events-none opacity-60' : ''}`}>
              <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                {groups.map(([group, items]) => {
                  const codes = items.map((i) => i.code);
                  const allOn = codes.every((c) => selected.has(c));
                  return (
                    <div key={group}>
                      <div className="mb-1.5 flex items-center gap-2">
                        <Checkbox
                          checked={allOn}
                          onCheckedChange={() => toggleGroup(group, codes)}
                        />
                        <span className="text-sm font-medium">{group}</span>
                      </div>
                      <div className="ml-6 space-y-1.5">
                        {items.map((p) => (
                          <label key={p.code} className="flex cursor-pointer items-start gap-2 text-sm">
                            <Checkbox
                              checked={selected.has(p.code)}
                              onCheckedChange={() => toggle(p.code)}
                              className="mt-0.5"
                            />
                            <span>
                              <span className="font-medium">{p.label}</span>
                              <span className="ml-2 text-xs text-muted-foreground">{p.description}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave}>{role ? '保存' : '创建'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
