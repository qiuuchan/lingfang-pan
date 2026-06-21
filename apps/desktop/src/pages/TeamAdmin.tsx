// 团队管理控制面板（桌面端顶级页面，仅团队管理员可见）。
// 这是团队管理线路的核心 UI，与平台管理（web collab-admin）形成两条干净分离的管理线路。
// 5 个 tab：概览 / 成员管理 / 角色与权限 / 插件授权 / 邀请码与团队设置。
// 后端：/api/teams/current/* （members/roles/plugins/grants/invitations/balance）。
import { lazy, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useApp } from '@/App';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import { centsToYuan } from '@/lib/money';
import type { Role, TeamInfo, TeamMember, PermissionEntry } from '@/lib/types';
import { OverviewSkeleton, MembersTab, RolesTab, PluginGrantsTab, InvitationsTab } from './team-admin';

export function TeamAdmin() {
  const { session } = useApp();
  const [tab, setTab] = useState('overview');
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [loading, setLoading] = useState(false);

  async function loadOverview() {
    setLoading(true);
    try {
      const [teamRes, membersRes] = await Promise.all([
        api<{ team: TeamInfo }>('/api/teams/current'),
        api<{ members: TeamMember[] }>('/api/teams/current/members'),
      ]);
      setTeam(teamRes.team);
      setMemberCount(membersRes.members.length);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadOverview(); }, []);

  // 非团队管理员兜底（理论上 Sidebar 已过滤，防御纵深）
  if (session.role !== 'TEAM_ADMIN') {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        仅团队管理员可访问团队管理面板
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">团队管理</h1>
          <p className="text-sm text-muted-foreground">
            {team ? `${team.name} · 管理团队成员、角色权限与插件授权` : '加载中…'}
          </p>
        </div>
        <LoadingButton variant="outline" loading={loading} onClick={loadOverview}>刷新</LoadingButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <Tabs value={tab} onValueChange={setTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="members">成员管理</TabsTrigger>
            <TabsTrigger value="roles">角色与权限</TabsTrigger>
            <TabsTrigger value="grants">插件授权</TabsTrigger>
            <TabsTrigger value="invitations">邀请码与设置</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewCard team={team} memberCount={memberCount} loading={loading} />
          </TabsContent>
          <TabsContent value="members">
            <MembersTab />
          </TabsContent>
          <TabsContent value="roles">
            <RolesTab />
          </TabsContent>
          <TabsContent value="grants">
            <PluginGrantsTab />
          </TabsContent>
          <TabsContent value="invitations">
            <InvitationsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function OverviewCard({ team, memberCount, loading }: { team: TeamInfo | null; memberCount: number; loading: boolean }) {
  if (loading && !team) return <OverviewSkeleton />;
  if (!team) return <div className="text-muted-foreground">团队信息加载失败</div>;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader className="pb-2"><CardDescription>团队名称</CardDescription><CardTitle className="text-base">{team.name}</CardTitle></CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardDescription>团队余额</CardDescription><CardTitle className="text-base">{centsToYuan(team.balanceCents)} 元</CardTitle></CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardDescription>成员数</CardDescription><CardTitle className="text-base">{memberCount}</CardTitle></CardHeader>
      </Card>
    </div>
  );
}
