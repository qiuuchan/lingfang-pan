// 成员管理 tab：成员列表 + 角色分配（下拉选团队角色）+ 移除成员。
// 后端：GET /api/teams/current/members、POST /api/teams/current/roles/assign、DELETE /api/teams/current/members/:userId。
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useTeamResource, runAction } from './shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { Role, TeamMember } from '@/lib/types';

export function MembersTab() {
  const [members, reloadMembers, loadingMembers] = useTeamResource<{ members: TeamMember[] }>(
    '/api/teams/current/members',
    (r) => r as { members: TeamMember[] },
    { members: [] },
  );
  const [roles, reloadRoles] = useTeamResource<{ roles: Role[] }>(
    '/api/teams/current/roles',
    (r) => r as { roles: Role[] },
    { roles: [] },
  );

  const reload = useCallback(() => { void reloadMembers(); void reloadRoles(); }, [reloadMembers, reloadRoles]);

  async function assignRole(member: TeamMember, roleId: string) {
    const ok = await runAction(
      () => api('/api/teams/current/roles/assign', { method: 'POST', body: { userId: member.userId, roleId } }),
      '角色已分配',
    );
    if (ok) await reload();
  }

  async function removeMember(member: TeamMember) {
    if (!confirm(`确定移除成员「${member.user.displayName}」？`)) return;
    const ok = await runAction(
      () => api(`/api/teams/current/members/${member.userId}`, { method: 'DELETE' }),
      '成员已移除',
    );
    if (ok) await reload();
  }

  // 按角色 id 建立名称查找，用于下拉默认值映射（member 当前可能只有 role 枚举无 teamRoleId）
  const roleById = new Map(roles.roles.map((r) => [r.id, r]));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>成员管理</CardTitle>
          <p className="text-sm text-muted-foreground">共 {members.members.length} 名成员。可分配团队角色或移除成员。</p>
        </div>
        <LoadingButton variant="outline" loading={loadingMembers} onClick={reload}>刷新</LoadingButton>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>成员</TableHead>
              <TableHead>邮箱</TableHead>
              <TableHead>当前角色</TableHead>
              <TableHead>分配角色</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.members.map((m) => {
              const currentRole = roleById.size > 0
                ? roles.roles.find((r) => r.name === (m.role === 'TEAM_ADMIN' ? '系统团队管理员' : '系统成员'))
                : undefined;
              return (
                <TableRow key={m.userId}>
                  <TableCell className="font-medium">{m.user.displayName}</TableCell>
                  <TableCell className="text-muted-foreground">{m.user.email}</TableCell>
                  <TableCell>
                    <Badge variant={m.role === 'TEAM_ADMIN' ? 'default' : 'secondary'}>
                      {m.role === 'TEAM_ADMIN' ? '团队管理员' : '成员'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={currentRole?.id}
                      onValueChange={(roleId) => { if (roleId) assignRole(m, roleId); }}
                    >
                      <SelectTrigger className="w-40"><SelectValue placeholder="选择角色" /></SelectTrigger>
                      <SelectContent>
                        {roles.roles.map((r) => (
                          <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right">
                    {m.role !== 'TEAM_ADMIN' && (
                      <Button variant="ghost" size="sm" onClick={() => removeMember(m)}>移除</Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {members.members.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无成员</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
