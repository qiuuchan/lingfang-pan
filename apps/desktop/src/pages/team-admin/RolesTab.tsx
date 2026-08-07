// 角色与权限 tab：团队角色 CRUD + 权限码两级勾选面板（模块 → 操作）。
// 内置角色（系统团队管理员/系统成员）权限/编码锁定、不可删；可创建自定义角色勾选 team.* 权限。
// 后端：GET/POST /api/teams/current/roles、PATCH/DELETE /api/teams/current/roles/:id、
//       GET /api/teams/current/roles/permissions、GET/PUT /api/teams/current/permission-groups。
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useTeamResource, runAction } from './shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PlusIcon, PencilIcon, Trash2Icon, LockIcon } from 'lucide-react';
import type { PermissionEntry, PermissionModule, PermissionGroup, Role } from '@/lib/types';

const ROLE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 把扁平权限码按模块折叠为两级结构（moduleKey → operations）。
 * 显示名优先用自定义分组覆盖，否则用权限自带 moduleLabel。
 */
function buildModules(
  permissions: PermissionEntry[],
  groupLabelOverride: Map<string, string>
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
  return [...map.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.moduleKey.localeCompare(b.moduleKey)
  );
}

export function RolesTab() {
  const [rolesState, reloadRoles, loadingRoles] = useTeamResource<{ roles: Role[] }>(
    '/api/teams/current/roles',
    (r) => r as { roles: Role[] },
    { roles: [] }
  );
  const [permsState, reloadPerms] = useTeamResource<{ permissions: PermissionEntry[] }>(
    '/api/teams/current/roles/permissions',
    (r) => r as { permissions: PermissionEntry[] },
    { permissions: [] }
  );
  const [groupsState] = useTeamResource<{ groups: PermissionGroup[] }>(
    '/api/teams/current/permission-groups',
    (r) => r as { groups: PermissionGroup[] },
    { groups: [] }
  );
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);

  async function reload() {
    await Promise.all([reloadRoles(), reloadPerms()]);
  }

  // 自定义分组显示名覆盖
  const groupLabelOverride = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groupsState.groups) {
      if (g.customized) map.set(g.groupKey, g.displayName);
    }
    return map;
  }, [groupsState.groups]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>角色与权限</CardTitle>
          <p className="text-sm text-muted-foreground">
            为本团队创建自定义角色并分配权限。内置角色权限锁定。
          </p>
        </div>
        <div className="flex gap-2">
          <LoadingButton variant="outline" loading={loadingRoles} onClick={reload}>
            刷新
          </LoadingButton>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon className="mr-1.5 size-4" />
            创建角色
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>角色名</TableHead>
              <TableHead>编码</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>权限数</TableHead>
              <TableHead>成员数</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rolesState.roles.map((role) => (
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
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setEditing(role)}
                      title="编辑"
                    >
                      <PencilIcon className="size-4" />
                    </Button>
                    {!role.isSystem && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="删除"
                        onClick={async () => {
                          if (!confirm(`确定删除角色「${role.name}」？`)) return;
                          const ok = await runAction(
                            () => api(`/api/teams/current/roles/${role.id}`, { method: 'DELETE' }),
                            '角色已删除'
                          );
                          if (ok) await reload();
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
      </CardContent>

      {creating && (
        <RoleEditDialog
          permissions={permsState.permissions}
          groupLabelOverride={groupLabelOverride}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await reload();
          }}
        />
      )}
      {editing && (
        <RoleEditDialog
          role={editing}
          permissions={permsState.permissions}
          groupLabelOverride={groupLabelOverride}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </Card>
  );
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
  const [saving, setSaving] = useState(false);

  // 权限按模块折叠（两级勾选树）
  const modules = useMemo(
    () => buildModules(permissions, groupLabelOverride),
    [permissions, groupLabelOverride]
  );

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
    if (!name.trim()) return;
    const trimmedCode = code.trim();
    if (trimmedCode && !ROLE_CODE_PATTERN.test(trimmedCode)) {
      return;
    }
    setSaving(true);
    const body = {
      name: name.trim(),
      ...(isSystem ? {} : { code: trimmedCode || undefined, permissions: [...selected] }),
    };
    const ok = role
      ? await runAction(
          () => api(`/api/teams/current/roles/${role.id}`, { method: 'PATCH', body }),
          '角色已更新'
        )
      : await runAction(
          () => api('/api/teams/current/roles', { method: 'POST', body }),
          '角色已创建'
        );
    setSaving(false);
    if (ok) await onSaved();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            {role ? `编辑角色：${role.name}` : '创建团队角色'}
          </DialogTitle>
          <DialogDescription>
            {isSystem
              ? '内置角色权限/编码锁定不可修改，仅可调整名称与说明。'
              : '勾选该角色拥有的团队权限。'}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="grid grid-cols-2 gap-4 py-2">
          <Field>
            <FieldLabel htmlFor="role-name">角色名</FieldLabel>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder="如：开发者"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="role-code">
              编码
              {isSystem && <span className="ml-1 text-xs text-muted-foreground">（内置锁定）</span>}
            </FieldLabel>
            <Input
              id="role-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={64}
              placeholder="如：developer"
              disabled={isSystem}
            />
            <FieldDescription className="text-xs">
              小写字母/数字开头，可含下划线、连字符。同 scope 下唯一。
            </FieldDescription>
          </Field>
          <Field className="col-span-2">
            <FieldLabel htmlFor="role-description">说明</FieldLabel>
            <Textarea
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={255}
              rows={2}
            />
          </Field>
          <Field className="col-span-2">
            <div className="flex items-center justify-between">
              <FieldLabel>
                权限分配
                {isSystem && (
                  <span className="ml-2 text-xs text-muted-foreground">（内置锁定）</span>
                )}
              </FieldLabel>
              <span className="text-xs text-muted-foreground">
                已选 {selected.size} / {permissions.length}
              </span>
            </div>
            <div
              className={`rounded-md border p-3 ${isSystem ? 'pointer-events-none opacity-60' : ''}`}
            >
              <div className="flex max-h-72 flex-col gap-3 overflow-y-auto pr-1">
                {modules.map((m) => {
                  const codes = m.operations.map((op) => op.code);
                  const allOn = codes.every((c) => selected.has(c));
                  return (
                    <div key={m.moduleKey}>
                      <div className="mb-1.5 flex items-center gap-2">
                        <Checkbox checked={allOn} onCheckedChange={() => toggleModule(codes)} />
                        <span className="text-sm font-medium">{m.moduleLabel}</span>
                        <span className="text-xs text-muted-foreground">{m.moduleKey}</span>
                      </div>
                      <div className="ml-6 flex flex-col gap-1.5">
                        {m.operations.map((p) => (
                          <label
                            key={p.code}
                            className="flex cursor-pointer items-start gap-2 text-sm"
                          >
                            <Checkbox
                              checked={selected.has(p.code)}
                              onCheckedChange={() => toggle(p.code)}
                              className="mt-0.5"
                            />
                            <span>
                              <span className="font-medium">{p.label}</span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                {p.description}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <LoadingButton loading={saving} onClick={handleSave}>
            {role ? '保存' : '创建'}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
