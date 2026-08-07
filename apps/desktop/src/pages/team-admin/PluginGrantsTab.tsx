// 插件授权 tab：列出团队可用插件，为每个插件按 user/role 设置 allow/deny。
// 后端：GET /api/plugin-registry/team、GET/POST/DELETE /api/teams/current/plugin-packages/:id/grants。
// 授权语义（后端 resolvePluginAccess）：deny 优先、user 级优先于 role 级、团队管理员默认放行。
import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { useTeamResource, runAction } from './shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  PluginGrantRow,
  PluginGrantSubject,
  PluginGrantEffect,
  Role,
  TeamMember,
} from '@/lib/types';
import type { RegistryCatalogItem } from '@/lib/plugin-registry';
import { PluginPolicyCard } from './PluginPolicyCard';

interface AvailablePlugins {
  items: RegistryCatalogItem[];
}
interface GrantsResp {
  grants: PluginGrantRow[];
}
interface RolesResp {
  roles: Role[];
}
interface MembersResp {
  members: TeamMember[];
}

export function PluginGrantsTab() {
  const [available, reloadAvailable, loadingAvailable] = useTeamResource<AvailablePlugins>(
    '/api/plugin-registry/team',
    (r) => r as AvailablePlugins,
    { items: [] }
  );
  const [members, reloadMembers] = useTeamResource<MembersResp>(
    '/api/teams/current/members',
    (r) => r as MembersResp,
    { members: [] }
  );
  const [roles, reloadRoles] = useTeamResource<RolesResp>(
    '/api/teams/current/roles',
    (r) => r as RolesResp,
    { roles: [] }
  );
  const [editingPlugin, setEditingPlugin] = useState<RegistryCatalogItem | null>(null);
  const [grants, setGrants] = useState<PluginGrantRow[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);

  const reload = useCallback(() => {
    void reloadAvailable();
    void reloadMembers();
    void reloadRoles();
  }, [reloadAvailable, reloadMembers, reloadRoles]);

  async function openGrants(plugin: RegistryCatalogItem) {
    setEditingPlugin(plugin);
    setGrantsLoading(true);
    try {
      const r = await api<GrantsResp>(
        `/api/teams/current/plugin-packages/${plugin.package.id}/grants`
      );
      setGrants(r.grants);
    } catch {
      setGrants([]);
    } finally {
      setGrantsLoading(false);
    }
  }

  async function reloadGrants() {
    if (!editingPlugin) return;
    const r = await api<GrantsResp>(
      `/api/teams/current/plugin-packages/${editingPlugin.package.id}/grants`
    );
    setGrants(r.grants);
  }

  return (
    <div className="flex flex-col gap-4">
      <PluginPolicyCard />
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>插件授权</CardTitle>
            <p className="text-sm text-muted-foreground">
              为团队内插件按用户或角色设置可用/禁用。deny 优先，无设置默认可用。
            </p>
          </div>
          <LoadingButton variant="outline" loading={loadingAvailable} onClick={reload}>
            刷新
          </LoadingButton>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>插件</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>授权规则数</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {available.items.map((p) => {
                const count = editingPlugin?.package.id === p.package.id ? grants.length : 0;
                return (
                  <TableRow key={p.package.id}>
                    <TableCell className="font-medium">{p.package.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">团队库</Badge>
                    </TableCell>
                    <TableCell>{count}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => openGrants(p)}>
                        管理授权
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {available.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    暂无可用插件
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>

        {editingPlugin && (
          <GrantsDialog
            plugin={editingPlugin}
            grants={grants}
            loading={grantsLoading}
            members={members.members}
            roles={roles.roles}
            onClose={() => setEditingPlugin(null)}
            onChanged={reloadGrants}
          />
        )}
      </Card>
    </div>
  );
}

function GrantsDialog({
  plugin,
  grants,
  loading,
  members,
  roles,
  onClose,
  onChanged,
}: {
  plugin: RegistryCatalogItem;
  grants: PluginGrantRow[];
  loading: boolean;
  members: TeamMember[];
  roles: Role[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [subjectKind, setSubjectKind] = useState<PluginGrantSubject>('USER');
  const [subjectId, setSubjectId] = useState('');
  const [effect, setEffect] = useState<PluginGrantEffect>('DENY');
  const [saving, setSaving] = useState(false);

  const subjectOptions =
    subjectKind === 'USER'
      ? members.map((m) => ({ id: m.userId, label: `${m.user.displayName} (${m.user.email})` }))
      : roles.map((r) => ({ id: r.id, label: r.name }));

  async function handleSet() {
    if (!subjectId) return;
    setSaving(true);
    const ok = await runAction(
      () =>
        api(`/api/teams/current/plugin-packages/${plugin.package.id}/grants`, {
          method: 'POST',
          body: { subjectKind, subjectId, effect },
        }),
      '授权已设置'
    );
    setSaving(false);
    if (ok) {
      setSubjectId('');
      await onChanged();
    }
  }

  async function handleRemove(grant: PluginGrantRow) {
    const ok = await runAction(
      () =>
        api(
          `/api/teams/current/plugin-packages/${plugin.package.id}/grants?subjectKind=${grant.subjectKind}&subjectId=${grant.subjectId}`,
          { method: 'DELETE' }
        ),
      '授权已移除'
    );
    if (ok) await onChanged();
  }

  function subjectLabel(grant: PluginGrantRow): string {
    if (grant.subjectKind === 'USER') {
      const m = members.find((x) => x.userId === grant.subjectId);
      return m ? `${m.user.displayName}` : grant.subjectId.slice(0, 8);
    }
    const r = roles.find((x) => x.id === grant.subjectId);
    return r ? r.name : grant.subjectId.slice(0, 8);
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
          <DialogTitle>插件授权：{plugin.package.name}</DialogTitle>
          <DialogDescription>
            为用户或角色设置 allow/deny。deny 优先，无规则默认可用。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* 新增授权规则 */}
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="text-sm font-medium">添加授权规则</div>
            <FieldGroup className="grid grid-cols-2 gap-2">
              <Field className="gap-1">
                <FieldLabel htmlFor="grant-subject-kind" className="text-xs text-muted-foreground">
                  主体类型
                </FieldLabel>
                <Select
                  value={subjectKind}
                  onValueChange={(v) => {
                    setSubjectKind(v as PluginGrantSubject);
                    setSubjectId('');
                  }}
                >
                  <SelectTrigger id="grant-subject-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="min-w-[12rem]">
                    <SelectItem value="USER">用户</SelectItem>
                    <SelectItem value="ROLE">角色</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field className="gap-1">
                <FieldLabel htmlFor="grant-effect" className="text-xs text-muted-foreground">
                  效果
                </FieldLabel>
                <Select value={effect} onValueChange={(v) => setEffect(v as PluginGrantEffect)}>
                  <SelectTrigger id="grant-effect" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="min-w-[12rem]">
                    <SelectItem value="DENY">禁用（拒绝）</SelectItem>
                    <SelectItem value="ALLOW">允许</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field className="col-span-2 gap-1">
                <FieldLabel htmlFor="grant-subject" className="text-xs text-muted-foreground">
                  {subjectKind === 'USER' ? '选择用户' : '选择角色'}
                </FieldLabel>
                <Select
                  value={subjectId}
                  onValueChange={(v) => {
                    if (v) setSubjectId(v);
                  }}
                >
                  <SelectTrigger id="grant-subject" className="w-full">
                    <SelectValue placeholder="选择…" />
                  </SelectTrigger>
                  <SelectContent className="min-w-[12rem]">
                    {subjectOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <LoadingButton
              className="self-start"
              loading={saving}
              onClick={handleSet}
              disabled={!subjectId}
            >
              添加规则
            </LoadingButton>
          </div>

          {/* 现有规则列表 */}
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium">现有规则（{grants.length}）</div>
            {loading ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : grants.length === 0 ? (
              <div className="text-sm text-muted-foreground">暂无规则，所有人默认可用</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>主体</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>效果</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grants.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell>{subjectLabel(g)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {g.subjectKind === 'USER' ? '用户' : '角色'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={g.effect === 'DENY' ? 'destructive' : 'default'}>
                          {g.effect === 'DENY' ? '禁用' : '允许'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => handleRemove(g)}>
                          移除
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
