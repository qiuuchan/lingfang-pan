// 平台角色管理视图（collab-admin web）。
// 列出平台级角色 + 创建/编辑/删除 + 权限码两级勾选面板（模块 → 操作）。
// 内置角色（isSystem=true）锁定权限编辑、不可删除；可改显示名/描述。
// 后端：GET/POST /api/admin/roles、PATCH/DELETE /api/admin/roles/:id、GET /api/admin/roles/permissions、
//       GET/PUT /api/admin/permission-groups、DELETE /api/admin/permission-groups/:groupKey。
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
import type { PermissionEntry, PermissionModule, PermissionGroup, Role } from '@/lib/types';
import { formatTime } from '@/lib/types';

const ROLE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
          groupLabelOverride={groupLabelOverride}
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

/**
 * 把扁平权限码按模块折叠为两级结构（moduleKey → operations）。
 * 显示名优先用自定义分组覆盖，否则用权限自带 moduleLabel。
 */
function buildModules(
  permissions: PermissionEntry[],
  groupLabelOverride: Map<string, string>,
): PermissionModule[] {
  const map = new Map<string, PermissionModule>();
  for (const p of permissions) {
    let m = map.get(p.moduleKey);
    if (!m) {
      m = {
        moduleKey: p.moduleKey,
        moduleLabel: groupLabelOverride.get(p.moduleKey) ?? p.moduleLabel,
        scope: p.scope,
        sortOrder: p.moduleOrder,
        operations: [],
      };
      map.set(p.moduleKey, m);
    }
    m.operations.push(p);
  }
  return [...map.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.moduleKey.localeCompare(b.moduleKey));
}

/** 角色编辑/创建对话框：含名称、编码、描述、权限码两级勾选面板（模块父级 → 操作子项）。 */
function RoleEditDialog({
  role,
  permissions,
  groupLabelOverride,
  onClose,
  onSaved,
}: {
  role?: Role | null;
  permissions: PermissionEntry[];
  groupLabelOverride: Map<string, string>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isSystem = role?.isSystem ?? false;
  const [name, setName] = useState(role?.name ?? '');
  const [code, setCode] = useState(role?.code ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));

  // 权限按模块折叠（两级勾选树）
  const modules = useMemo(() => buildModules(permissions, groupLabelOverride), [permissions, groupLabelOverride]);

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleModule(codes: string[]) {
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
    const trimmedCode = code.trim();
    if (trimmedCode && !ROLE_CODE_PATTERN.test(trimmedCode)) {
      toast.error('编码只能包含小写字母、数字、下划线、连字符，须以字母或数字开头');
      return;
    }
    const body = {
      name: name.trim(),
      // 系统角色不允许改权限/编码（后端会拒绝），这里也不传 code/permissions 字段
      ...(isSystem ? {} : { code: trimmedCode || undefined, permissions: [...selected] }),
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
            {isSystem ? '内置角色权限/编码锁定不可修改，仅可调整名称与说明。' : '勾选该角色拥有的平台权限，用户被分配此角色后即获得这些权限。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>角色名</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="如：运营专员" />
            </div>
            <div className="space-y-2">
              <Label>编码{isSystem && <span className="ml-1 text-xs text-muted-foreground">（内置锁定）</span>}</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={64}
                placeholder="如：operator"
                disabled={isSystem}
              />
              <p className="text-xs text-muted-foreground">小写字母/数字开头，可含下划线、连字符。同 scope 下唯一。</p>
            </div>
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
                {modules.map((m) => {
                  const codes = m.operations.map((op) => op.code);
                  const allOn = codes.every((c) => selected.has(c));
                  return (
                    <div key={m.moduleKey}>
                      <div className="mb-1.5 flex items-center gap-2">
                        <Checkbox
                          checked={allOn}
                          onCheckedChange={() => toggleModule(codes)}
                        />
                        <span className="text-sm font-medium">{m.moduleLabel}</span>
                        <span className="text-xs text-muted-foreground">{m.moduleKey}</span>
                      </div>
                      <div className="ml-6 space-y-1.5">
                        {m.operations.map((p) => (
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
