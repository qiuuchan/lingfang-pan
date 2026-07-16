// 团队管理控制面板（桌面端顶级页面，仅团队管理员可见）。
// 这是团队管理线路的核心 UI，与平台管理（web collab-admin）形成两条干净分离的管理线路。
// Tab：概览 / 成员管理 / 角色与权限 / 插件授权 / 邀请码与团队设置。
// 后端：/api/teams/current/* （members/roles/plugins/grants/invitations/balance）。
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AnimatePresence, motion } from 'framer-motion';
import { BotIcon, BoxesIcon, CoinsIcon, DatabaseIcon, Globe2Icon, KeyRoundIcon, RefreshCwIcon, ShieldCheckIcon, SlidersHorizontalIcon, UsersIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/App';
import { isTeamManager } from '@/lib/permissions';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { LoadingButton } from '@/components/loading-button';
import { centsToYuan } from '@/lib/money';
import type { TeamInfo, TeamMember, TeamProfile } from '@/lib/types';
import { OverviewSkeleton, MembersTab, RolesTab, PluginGrantsTab, InvitationsTab, SharedStateTab, CloudAutomationTab } from './team-admin';

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
    <div className="flex h-full flex-col overflow-hidden bg-muted/10">
      <div className="flex items-center justify-between gap-4 border-b bg-background px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-semibold text-primary ring-1 ring-primary/15">
            {team?.name.trim().slice(0, 2).toUpperCase() || <UsersIcon className="size-5" />}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold">{team?.name || '正在加载团队'}</h2>
              {team && <Badge variant="secondary" className="shrink-0"><ShieldCheckIcon />管理面板</Badge>}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">集中管理成员、权限、插件能力与团队自动化</p>
          </div>
        </div>
        <LoadingButton variant="outline" size="sm" loading={loading} onClick={loadOverview}>
          {!loading && <RefreshCwIcon />}刷新概览
        </LoadingButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <Tabs value={tab} onValueChange={setTab} className="mx-auto max-w-6xl space-y-4">
          <div className="overflow-x-auto pb-1">
            <TabsList className="h-10 min-w-max justify-start rounded-xl border bg-background p-1 shadow-sm">
              <TabsTrigger className="h-8 flex-none px-3" value="overview"><BoxesIcon />概览</TabsTrigger>
              <TabsTrigger className="h-8 flex-none px-3" value="members"><UsersIcon />成员</TabsTrigger>
              <TabsTrigger className="h-8 flex-none px-3" value="roles"><ShieldCheckIcon />角色权限</TabsTrigger>
              <TabsTrigger className="h-8 flex-none px-3" value="grants"><SlidersHorizontalIcon />插件授权</TabsTrigger>
              <TabsTrigger className="h-8 flex-none px-3" value="shared-state"><DatabaseIcon />共享状态</TabsTrigger>
              <TabsTrigger className="h-8 flex-none px-3" value="cloud"><BotIcon />Cloud 自动化</TabsTrigger>
              <TabsTrigger className="h-8 flex-none px-3" value="invitations"><KeyRoundIcon />邀请与设置</TabsTrigger>
            </TabsList>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.16 }}
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
              {tab === 'shared-state' && (
                <TabsContent value="shared-state">
                  <SharedStateTab />
                </TabsContent>
              )}
              {tab === 'cloud' && <TabsContent value="cloud"><CloudAutomationTab /></TabsContent>}
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
  if (!team) return <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">团队信息加载失败，请刷新后重试。</div>;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <OverviewMetric icon={<Globe2Icon />} label="团队名称" value={team.name} description="当前管理空间" />
        <OverviewMetric icon={<CoinsIcon />} label="团队余额" value={centsToYuan(team.balanceCents)} description="插件市场共享账户" />
        <OverviewMetric icon={<UsersIcon />} label="团队成员" value={`${memberCount} 人`} description="包含管理员与普通成员" />
      </div>
      <TeamProfileCard profile={profile} onSaved={onProfileSaved} />
    </div>
  );
}

function OverviewMetric({ icon, label, value, description }: { icon: ReactNode; label: string; value: string; description: string }) {
  return (
    <Card className="relative gap-3 overflow-hidden border bg-card py-4 shadow-sm ring-0">
      <div className="absolute -right-8 -top-8 size-24 rounded-full bg-primary/5 blur-2xl" />
      <CardHeader className="relative flex-row items-center gap-3 px-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-4">{icon}</span>
        <div className="min-w-0">
          <CardDescription className="text-xs">{label}</CardDescription>
          <CardTitle className="truncate text-base" title={value}>{value}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="relative px-4 text-[11px] text-muted-foreground">{description}</CardContent>
    </Card>
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
    <Card className="border bg-card shadow-sm ring-0">
      <CardHeader className="border-b bg-muted/20 pb-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Globe2Icon className="size-4" /></span>
          <div>
            <CardTitle>团队公开资料</CardTitle>
            <CardDescription>维护团队简介以及用户是否可以公开加入。</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 p-3">
          <div>
            <Label htmlFor="overview-allow-public" className="text-sm font-medium">开放公开加入</Label>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">开启后，其他用户可以在团队发现页申请加入。</p>
          </div>
          <Checkbox className="mt-0.5" id="overview-allow-public" checked={allowPublicJoin} disabled={!profile} onCheckedChange={(value) => setAllowPublicJoin(Boolean(value))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="overview-team-description">团队简介</Label>
          <Textarea id="overview-team-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={500} placeholder="介绍团队方向、成员构成或协作目标" />
          <p className="text-right text-[11px] text-muted-foreground">{description.length} / 500</p>
        </div>
        <div className="flex justify-end">
          <LoadingButton loading={saving} onClick={() => { void save(); }} disabled={!profile}>保存团队资料</LoadingButton>
        </div>
      </CardContent>
    </Card>
  );
}
