// 团队管理控制面板（桌面端顶级页面，仅团队管理员可见）。
// 这是团队管理线路的核心 UI，与平台管理（web collab-admin）形成两条干净分离的管理线路。
// 5 个 tab：概览 / 成员管理 / 角色与权限 / 插件授权 / 邀请码与团队设置。
// 后端：/api/teams/current/* （members/roles/plugins/grants/invitations/balance）。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '@/lib/api';
import { useApp } from '@/App';
import { isTeamManager } from '@/lib/permissions';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { LoadingButton } from '@/components/loading-button';
import { centsToYuan } from '@/lib/money';
import type { TeamInfo, TeamMember, TeamProfile } from '@/lib/types';
import { OverviewSkeleton, MembersTab, RolesTab, PluginGrantsTab, InvitationsTab } from './team-admin';

export function TeamAdmin() {
  const { session } = useApp();
  const [tab, setTab] = useState('overview');
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [profile, setProfile] = useState<TeamProfile | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [loading, setLoading] = useState(false);

  async function loadOverview() {
    setLoading(true);
    try {
      const [teamRes, membersRes, profileRes] = await Promise.all([
        api<{ team: TeamInfo }>('/api/teams/current'),
        api<{ members: TeamMember[] }>('/api/teams/current/members'),
        api<{ team: TeamProfile }>('/api/teams/current/profile'),
      ]);
      setTeam(teamRes.team);
      setProfile(profileRes.team);
      setMemberCount(membersRes.members.length);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadOverview(); }, []);

  // RBAC：基于权限码而非旧枚举判定（自定义团队管理角色也能进入）。
  if (!isTeamManager(session.permissions)) {
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

          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {tab === 'overview' && (
                <TabsContent value="overview">
                  <OverviewCard team={team} profile={profile} memberCount={memberCount} loading={loading} onProfileSaved={setProfile} />
                </TabsContent>
              )}
              {tab === 'members' && (
                <TabsContent value="members">
                  <MembersTab />
                </TabsContent>
              )}
              {tab === 'roles' && (
                <TabsContent value="roles">
                  <RolesTab />
                </TabsContent>
              )}
              {tab === 'grants' && (
                <TabsContent value="grants">
                  <PluginGrantsTab />
                </TabsContent>
              )}
              {tab === 'invitations' && (
                <TabsContent value="invitations">
                  <InvitationsTab />
                </TabsContent>
              )}
            </motion.div>
          </AnimatePresence>
        </Tabs>
      </div>
    </div>
  );
}

function OverviewCard({
  team,
  profile,
  memberCount,
  loading,
  onProfileSaved,
}: {
  team: TeamInfo | null;
  profile: TeamProfile | null;
  memberCount: number;
  loading: boolean;
  onProfileSaved: (profile: TeamProfile) => void;
}) {
  if (loading && !team) return <OverviewSkeleton />;
  if (!team) return <div className="text-muted-foreground">团队信息加载失败</div>;
  return (
    <div className="space-y-4">
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
      <TeamProfileCard profile={profile} onSaved={onProfileSaved} />
    </div>
  );
}

function TeamProfileCard({ profile, onSaved }: { profile: TeamProfile | null; onSaved: (profile: TeamProfile) => void }) {
  const [allowPublicJoin, setAllowPublicJoin] = useState(false);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAllowPublicJoin(profile?.allowPublicJoin ?? false);
    setDescription(profile?.description ?? '');
  }, [profile]);

  async function save() {
    setSaving(true);
    try {
      const result = await api<{ team: TeamProfile }>('/api/teams/current/profile', {
        method: 'PATCH',
        body: { allowPublicJoin, description },
      });
      onSaved(result.team);
      toast.success('团队资料已更新');
    } catch (error) {
      if ((error as { status?: number }).status !== 401) toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>团队资料</CardTitle>
        <CardDescription>团队简介与公开加入设置。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Checkbox id="overview-allow-public" checked={allowPublicJoin} disabled={!profile} onCheckedChange={(value) => setAllowPublicJoin(Boolean(value))} />
          <Label htmlFor="overview-allow-public">开放公开加入</Label>
        </div>
        <div className="space-y-1">
          <Label htmlFor="overview-team-description">团队简介</Label>
          <Textarea id="overview-team-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={500} placeholder="公开团队发现页展示，帮助用户判断是否加入" />
        </div>
        <LoadingButton loading={saving} onClick={() => { void save(); }} disabled={!profile}>保存资料</LoadingButton>
      </CardContent>
    </Card>
  );
}
