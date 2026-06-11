import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  ActivityIcon,
  BoxesIcon,
  CheckCircleIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  PlugIcon,
  ShieldCheckIcon,
  UsersIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, getToken, isPlatformAdminSession, setToken, type AdminSession, type DashboardData } from '@/lib/api';
import { cn, money } from '@/lib/utils';

type View = 'dashboard' | 'users' | 'platformAdmins' | 'teams' | 'plugins' | 'applications' | 'audit';
type UserStatus = 'ACTIVE' | 'DISABLED';
type PlatformRole = 'NONE' | 'PLATFORM_ADMIN';
type TeamStatus = 'ACTIVE' | 'SUSPENDED';
type PluginStatus = 'ENABLED' | 'DISABLED';
type ApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
type TeamRole = 'TEAM_ADMIN' | 'MEMBER';
type LedgerDirection = 'CREDIT' | 'DEBIT';

type User = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  platformRole: PlatformRole;
};

type TeamMember = {
  teamId: string;
  userId: string;
  role: TeamRole;
  status: string;
  joinedAt: string;
  user: User;
};

type Team = {
  id: string;
  name: string;
  slug: string;
  status: TeamStatus;
  balanceCents: number;
  memberCount?: number;
  members?: TeamMember[];
};

type Plugin = {
  id: string;
  name: string;
  description: string;
  status: PluginStatus;
  updatedAt?: string;
};

type Application = {
  id: string;
  teamName: string;
  reason: string;
  status: ApplicationStatus;
  reviewReason: string;
  createdAt?: string;
  reviewedAt?: string | null;
  user: User;
  reviewedBy?: User | null;
};

type AuditLog = {
  id: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: unknown;
  createdAt: string;
  actor?: User | null;
};

const nav = [
  { view: 'dashboard' as const, label: '仪表盘', icon: LayoutDashboardIcon },
  { view: 'users' as const, label: '用户管理', icon: UsersIcon },
  { view: 'platformAdmins' as const, label: '平台管理员', icon: ShieldCheckIcon },
  { view: 'teams' as const, label: '团队管理', icon: BoxesIcon },
  { view: 'plugins' as const, label: '插件管理', icon: PlugIcon },
  { view: 'applications' as const, label: '审批管理', icon: CheckCircleIcon },
  { view: 'audit' as const, label: '审计日志', icon: ActivityIcon },
];

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '正常',
  DISABLED: '已禁用',
  SUSPENDED: '已停用',
  ENABLED: '已启用',
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  NONE: '普通用户',
  PLATFORM_ADMIN: '平台管理员',
  TEAM_ADMIN: '团队管理员',
  MEMBER: '成员',
  CREDIT: '入账',
  DEBIT: '扣减',
};

const ACTION_LABEL: Record<string, string> = {
  'team_admin_application.approved': '通过团队管理员申请',
  'team_admin_application.created': '提交团队管理员申请',
  'team_admin_application.rejected': '驳回团队管理员申请',
  'admin.team_admin.assigned': '指定团队管理员',
  'admin.team_admin.revoked': '撤销团队管理员',
  'admin.team.balance_adjusted': '调整团队余额',
  'admin.team.created': '创建团队',
  'admin.team.updated': '更新团队信息',
  'admin.user.created': '创建用户',
  'admin.user.updated': '更新用户信息',
  'admin.user.disabled': '禁用用户',
  'admin.plugin.created': '登记平台插件',
  'admin.plugin.updated': '更新插件治理状态',
  'invitation.created': '创建邀请码',
  'invitation.disabled': '停用邀请码',
  'invitation.redeemed': '兑换邀请码',
  'team.member.removed': '移除团队成员',
};

const TARGET_LABEL: Record<string, string> = {
  User: '用户',
  Team: '团队',
  Plugin: '插件',
  TeamAdminApplication: '团队管理员申请',
  InvitationCode: '邀请码',
};

export default function App() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [view, setView] = useState<View>('dashboard');

  useEffect(() => {
    if (!getToken()) return;
    api<AdminSession>('/api/auth/me')
      .then((next) => {
        if (!isPlatformAdminSession(next)) throw new Error('当前账号不是平台管理员');
        setSession(next);
      })
      .catch((e) => {
        setToken(null);
        toast.error((e as Error).message);
      })
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">正在检查会话…</div>;
  if (!session) return <Login onAuthed={setSession} />;

  const currentTitle = nav.find((item) => item.view === view)?.label;

  return (
    <div className="flex min-h-screen bg-muted/30">
      <aside className="hidden w-64 shrink-0 border-r bg-background/95 p-4 md:block">
        <div className="mb-6 flex items-center gap-3 rounded-xl border bg-card px-3 py-3 shadow-sm">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheckIcon className="size-5" />
          </div>
          <div>
            <div className="font-semibold">协作平台管理端</div>
            <div className="text-xs text-muted-foreground">Platform Admin</div>
          </div>
        </div>
        <nav className="space-y-1">
          {nav.map(({ view: key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={cn(
                'flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                view === key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <header className="mb-6 flex flex-col justify-between gap-4 rounded-2xl border bg-background p-5 shadow-sm md:flex-row md:items-center">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{currentTitle}</h1>
            <p className="mt-1 text-sm text-muted-foreground">平台级治理入口：账号、团队、插件、审批和审计统一在这里处理。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge value={session.user.platformRole} />
            <span className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{session.user.email}</span>
            <Button variant="outline" onClick={() => { setToken(null); setSession(null); }}><LogOutIcon className="mr-1 size-4" />退出</Button>
          </div>
        </header>
        {view === 'dashboard' && <Dashboard />}
        {view === 'users' && <Users />}
        {view === 'platformAdmins' && <PlatformAdmins currentAdminId={session.user.id} />}
        {view === 'teams' && <Teams />}
        {view === 'plugins' && <Plugins />}
        {view === 'applications' && <Applications />}
        {view === 'audit' && <Audit />}
      </main>
    </div>
  );
}

function Login({ onAuthed }: { onAuthed: (s: AdminSession) => void }) {
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('ChangeMe123!');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    try {
      const result = await api<AdminSession>('/api/auth/login', { auth: false, method: 'POST', body: { email, password } });
      if (!result.token) throw new Error('登录响应缺少 token');
      if (!isPlatformAdminSession(result)) throw new Error('该账号不是平台管理员');
      setToken(result.token);
      onAuthed(result);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>平台管理员登录</CardTitle>
          <CardDescription>初始账号由后端 seed/bootstrap 创建。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input placeholder="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <Button className="w-full" disabled={loading} onClick={submit}>{loading ? '登录中…' : '登录管理端'}</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  useLoad(() => api<DashboardData>('/api/admin/dashboard').then(setData));
  const items = [
    ['用户总数', data?.users ?? 0, '全平台账号'],
    ['团队总数', data?.teams ?? 0, '活跃/停用团队'],
    ['待审批', data?.pendingApplications ?? 0, '团队管理员申请'],
    ['启用插件', data?.enabledPlugins ?? 0, '本地客户端可见'],
  ];
  return (
    <div className="grid gap-4 md:grid-cols-4">
      {items.map(([label, value, desc]) => (
        <Card key={label} className="overflow-hidden">
          <CardHeader>
            <CardDescription>{label}</CardDescription>
            <CardTitle className="text-3xl">{value}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{desc}</CardContent>
        </Card>
      ))}
    </div>
  );
}

function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('ChangeMe123!');
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<UserStatus>('ACTIVE');

  const regularUsers = useMemo(() => users.filter((user) => user.platformRole !== 'PLATFORM_ADMIN'), [users]);
  const load = () => api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users));
  useLoad(load);

  useEffect(() => {
    if (!selected) return;
    const next = users.find((user) => user.id === selected.id);
    if (next && next !== selected) selectUser(next);
  }, [users, selected?.id]);

  function selectUser(user: User) {
    setSelected(user);
    setEditName(user.displayName);
    setEditStatus(user.status);
  }

  async function create() {
    if (!email.trim()) return toast.error('请输入邮箱');
    await run(() => api('/api/admin/users', { method: 'POST', body: { email, password, displayName: displayName || email, platformRole: 'NONE' } }).then(load), '用户已创建');
    setEmail('');
    setDisplayName('');
  }

  async function save() {
    if (!selected) return;
    await run(() => api(`/api/admin/users/${selected.id}`, { method: 'PATCH', body: { displayName: editName, status: editStatus, platformRole: 'NONE' } }).then(load), '用户信息已更新');
  }

  async function promote(user: User) {
    if (!window.confirm(`确认将 ${user.email} 提升为平台管理员？`)) return;
    await run(() => api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { platformRole: 'PLATFORM_ADMIN' } }).then(load), '已提升为平台管理员');
    setSelected(null);
  }

  return (
    <Section title="用户管理" description="仅展示普通用户。平台管理员已拆分到独立页面。">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Panel title="创建普通用户" description="默认密码可在创建前调整，平台角色固定为普通用户。">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="邮箱"><Input placeholder="new@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label="显示名"><Input placeholder="默认使用邮箱" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
              <Field label="初始密码"><Input value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            </div>
            <div className="mt-3"><Button onClick={create}>创建用户</Button></div>
          </Panel>
          <DataTable
            empty="暂无普通用户"
            headers={['邮箱', '显示名', '状态', '平台角色', '操作']}
            rows={regularUsers.map((user) => [
              <span className="font-medium text-foreground">{user.email}</span>,
              user.displayName,
              <StatusBadge value={user.status} />,
              <StatusBadge value={user.platformRole} />,
              <ActionButtonGroup>
                <Button variant="outline" onClick={() => selectUser(user)}>详情/编辑</Button>
                <Button variant="ghost" onClick={() => promote(user)}>提升管理员</Button>
              </ActionButtonGroup>,
            ])}
          />
        </div>
        <DetailPanel title="用户详情" description="修改显示名、状态，或从这里确认账号当前状态。" empty={!selected && '请选择左侧用户'}>
          {selected && (
            <div className="space-y-4">
              <InfoGrid items={[['邮箱', selected.email], ['用户 ID', selected.id], ['当前角色', labelOf(selected.platformRole)]]} />
              <Field label="显示名"><Input value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
              <Field label="状态">
                <NativeSelect value={editStatus} onChange={(e) => setEditStatus(e.target.value as UserStatus)}>
                  <option value="ACTIVE">正常</option>
                  <option value="DISABLED">已禁用</option>
                </NativeSelect>
              </Field>
              <ActionButtonGroup>
                <Button onClick={save}>保存修改</Button>
                <Button variant={editStatus === 'ACTIVE' ? 'destructive' : 'outline'} onClick={() => setEditStatus(editStatus === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}>
                  {editStatus === 'ACTIVE' ? '标记禁用' : '标记恢复'}
                </Button>
              </ActionButtonGroup>
            </div>
          )}
        </DetailPanel>
      </div>
    </Section>
  );
}

function PlatformAdmins({ currentAdminId }: { currentAdminId: string }) {
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('ChangeMe123!');
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<UserStatus>('ACTIVE');

  const admins = useMemo(() => users.filter((user) => user.platformRole === 'PLATFORM_ADMIN'), [users]);
  const load = () => api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users));
  useLoad(load);

  useEffect(() => {
    if (!selected) return;
    const next = users.find((user) => user.id === selected.id);
    if (next && next.platformRole === 'PLATFORM_ADMIN' && next !== selected) selectAdmin(next);
    if (next && next.platformRole !== 'PLATFORM_ADMIN') setSelected(null);
  }, [users, selected?.id]);

  function selectAdmin(user: User) {
    setSelected(user);
    setEditName(user.displayName);
    setEditStatus(user.status);
  }

  async function create() {
    if (!email.trim()) return toast.error('请输入邮箱');
    await run(() => api('/api/admin/users', { method: 'POST', body: { email, password, displayName: displayName || email, platformRole: 'PLATFORM_ADMIN' } }).then(load), '平台管理员已创建');
    setEmail('');
    setDisplayName('');
  }

  async function save() {
    if (!selected) return;
    if (selected.id === currentAdminId && editStatus === 'DISABLED') return toast.error('不能禁用当前登录管理员');
    await run(() => api(`/api/admin/users/${selected.id}`, { method: 'PATCH', body: { displayName: editName, status: editStatus, platformRole: 'PLATFORM_ADMIN' } }).then(load), '平台管理员信息已更新');
  }

  async function demote(user: User) {
    if (user.id === currentAdminId) return toast.error('不能降级当前登录管理员');
    if (!window.confirm(`确认将 ${user.email} 降级为普通用户？`)) return;
    await run(() => api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { platformRole: 'NONE' } }).then(load), '已降级为普通用户');
    setSelected(null);
  }

  return (
    <Section title="平台管理员" description="平台管理员独立管理，避免混在普通用户列表中。">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Panel title="创建平台管理员" description="这里创建的账号会直接拥有平台级管理权限。">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="邮箱"><Input placeholder="admin@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label="显示名"><Input placeholder="默认使用邮箱" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
              <Field label="初始密码"><Input value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            </div>
            <div className="mt-3"><Button onClick={create}>创建平台管理员</Button></div>
          </Panel>
          <DataTable
            empty="暂无平台管理员"
            headers={['邮箱', '显示名', '状态', '操作']}
            rows={admins.map((user) => [
              <span className="font-medium text-foreground">{user.email}</span>,
              user.displayName,
              <StatusBadge value={user.status} />,
              <ActionButtonGroup>
                <Button variant="outline" onClick={() => selectAdmin(user)}>详情/编辑</Button>
                <Button variant="destructive" disabled={user.id === currentAdminId} onClick={() => demote(user)}>降级</Button>
              </ActionButtonGroup>,
            ])}
          />
        </div>
        <DetailPanel title="管理员详情" description="危险操作会阻止影响当前登录管理员。" empty={!selected && '请选择左侧平台管理员'}>
          {selected && (
            <div className="space-y-4">
              <InfoGrid items={[['邮箱', selected.email], ['管理员 ID', selected.id], ['是否当前登录', selected.id === currentAdminId ? '是' : '否']]} />
              <Field label="显示名"><Input value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
              <Field label="状态">
                <NativeSelect value={editStatus} onChange={(e) => setEditStatus(e.target.value as UserStatus)} disabled={selected.id === currentAdminId}>
                  <option value="ACTIVE">正常</option>
                  <option value="DISABLED">已禁用</option>
                </NativeSelect>
              </Field>
              <ActionButtonGroup>
                <Button onClick={save}>保存修改</Button>
                <Button variant="destructive" disabled={selected.id === currentAdminId} onClick={() => demote(selected)}>降级为普通用户</Button>
              </ActionButtonGroup>
            </div>
          )}
        </DetailPanel>
      </div>
    </Section>
  );
}

function Teams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<Team | null>(null);
  const [name, setName] = useState('');
  const [initialBalance, setInitialBalance] = useState('100');
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<TeamStatus>('ACTIVE');
  const [adminUserId, setAdminUserId] = useState('');
  const [balanceAmount, setBalanceAmount] = useState('100');
  const [balanceDirection, setBalanceDirection] = useState<LedgerDirection>('CREDIT');
  const [balanceReason, setBalanceReason] = useState('平台管理员调整');

  const load = () => Promise.all([
    api<{ teams: Team[] }>('/api/admin/teams').then((r) => setTeams(r.teams)),
    api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users)),
  ]);
  useLoad(load);

  useEffect(() => {
    if (!selected) return;
    const next = teams.find((team) => team.id === selected.id);
    if (next && next !== selected) selectTeam(next);
  }, [teams, selected?.id]);

  function selectTeam(team: Team) {
    setSelected(team);
    setEditName(team.name);
    setEditStatus(team.status);
    setAdminUserId('');
  }

  async function create() {
    if (!name.trim()) return toast.error('请输入团队名称');
    await run(
      () => api('/api/admin/teams', { method: 'POST', body: { name, balanceCents: yuanToCents(initialBalance) } }).then(load),
      '团队已创建',
    );
    setName('');
  }

  async function save() {
    if (!selected) return;
    await run(() => api(`/api/admin/teams/${selected.id}`, { method: 'PATCH', body: { name: editName, status: editStatus } }).then(load), '团队信息已更新');
  }

  async function assignAdmin() {
    if (!selected || !adminUserId) return toast.error('请选择用户');
    await run(() => api(`/api/admin/teams/${selected.id}/admins`, { method: 'POST', body: { userId: adminUserId } }).then(load), '团队管理员已指定');
    setAdminUserId('');
  }

  async function revokeAdmin(member: TeamMember) {
    if (!selected) return;
    if (!window.confirm(`确认撤销 ${member.user.email} 的团队管理员权限？`)) return;
    await run(() => api(`/api/admin/teams/${selected.id}/admins/${member.userId}`, { method: 'DELETE' }).then(load), '团队管理员已撤销');
  }

  async function adjustBalance() {
    if (!selected) return;
    await run(
      () => api(`/api/admin/teams/${selected.id}/balance-adjustments`, {
        method: 'POST',
        body: { amountCents: yuanToCents(balanceAmount), direction: balanceDirection, reason: balanceReason },
      }).then(load),
      '团队余额已调整',
    );
  }

  const activeUsers = users.filter((user) => user.status === 'ACTIVE');

  return (
    <Section title="团队管理" description="支持团队信息维护、余额调整和团队管理员分配。">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-4">
          <Panel title="创建团队" description="创建后可在详情里指定团队管理员和调整余额。">
            <div className="grid gap-3 md:grid-cols-[1fr_180px]">
              <Field label="团队名称"><Input placeholder="团队名称" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="初始余额（元）"><Input value={initialBalance} onChange={(e) => setInitialBalance(e.target.value)} /></Field>
            </div>
            <div className="mt-3"><Button onClick={create}>创建团队</Button></div>
          </Panel>
          <DataTable
            empty="暂无团队"
            headers={['团队', 'Slug', '状态', '余额', '成员', '团队管理员', '操作']}
            rows={teams.map((team) => [
              <span className="font-medium text-foreground">{team.name}</span>,
              <span className="font-mono text-xs">{team.slug}</span>,
              <StatusBadge value={team.status} />,
              <span className="font-medium text-foreground">{money(team.balanceCents)}</span>,
              String(team.memberCount ?? activeMembers(team).length),
              adminNames(team),
              <Button variant="outline" onClick={() => selectTeam(team)}>详情/编辑</Button>,
            ])}
          />
        </div>
        <DetailPanel title="团队详情" description="编辑团队状态、余额和管理员关系。" empty={!selected && '请选择左侧团队'}>
          {selected && (
            <div className="space-y-5">
              <InfoGrid items={[['团队 ID', selected.id], ['Slug', selected.slug], ['当前余额', money(selected.balanceCents)], ['活跃成员', String(selected.memberCount ?? activeMembers(selected).length)]]} />
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="团队名称"><Input value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
                <Field label="状态">
                  <NativeSelect value={editStatus} onChange={(e) => setEditStatus(e.target.value as TeamStatus)}>
                    <option value="ACTIVE">正常</option>
                    <option value="SUSPENDED">已停用</option>
                  </NativeSelect>
                </Field>
              </div>
              <Button onClick={save}>保存团队信息</Button>
              <Panel title="余额调整" description="入账/扣减都会写入余额流水和审计日志。">
                <div className="grid gap-3 md:grid-cols-[110px_1fr]">
                  <Field label="方向">
                    <NativeSelect value={balanceDirection} onChange={(e) => setBalanceDirection(e.target.value as LedgerDirection)}>
                      <option value="CREDIT">入账</option>
                      <option value="DEBIT">扣减</option>
                    </NativeSelect>
                  </Field>
                  <Field label="金额（元）"><Input value={balanceAmount} onChange={(e) => setBalanceAmount(e.target.value)} /></Field>
                </div>
                <Field label="原因"><Input value={balanceReason} onChange={(e) => setBalanceReason(e.target.value)} /></Field>
                <Button variant="outline" onClick={adjustBalance}>提交余额调整</Button>
              </Panel>
              <Panel title="团队管理员" description="指定或撤销团队管理员，不影响平台管理员权限。">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <NativeSelect value={adminUserId} onChange={(e) => setAdminUserId(e.target.value)}>
                    <option value="">选择用户</option>
                    {activeUsers.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
                  </NativeSelect>
                  <Button onClick={assignAdmin}>指定管理员</Button>
                </div>
                <div className="mt-3 space-y-2">
                  {teamAdmins(selected).length ? teamAdmins(selected).map((member) => (
                    <div key={member.userId} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{member.user.displayName}</div>
                        <div className="truncate text-xs text-muted-foreground">{member.user.email}</div>
                      </div>
                      <Button variant="destructive" onClick={() => revokeAdmin(member)}>撤销</Button>
                    </div>
                  )) : <div className="text-sm text-muted-foreground">暂无团队管理员</div>}
                </div>
              </Panel>
            </div>
          )}
        </DetailPanel>
      </div>
    </Section>
  );
}

function Plugins() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [selected, setSelected] = useState<Plugin | null>(null);
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<PluginStatus>('ENABLED');
  const load = () => api<{ plugins: Plugin[] }>('/api/admin/plugins').then((r) => setPlugins(r.plugins));
  useLoad(load);

  useEffect(() => {
    if (!selected) return;
    const next = plugins.find((plugin) => plugin.id === selected.id);
    if (next && next !== selected) selectPlugin(next);
  }, [plugins, selected?.id]);

  function selectPlugin(plugin: Plugin) {
    setSelected(plugin);
    setDescription(plugin.description || '');
    setStatus(plugin.status);
  }

  async function save() {
    if (!selected) return;
    await run(() => api(`/api/admin/plugins/${selected.id}`, { method: 'PATCH', body: { description, status } }).then(load), '插件治理信息已更新');
  }

  async function toggle(plugin: Plugin) {
    await run(
      () => api(`/api/admin/plugins/${plugin.id}`, { method: 'PATCH', body: { status: plugin.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' } }).then(load),
      plugin.status === 'ENABLED' ? '插件已禁用' : '插件已启用',
    );
  }

  return (
    <Section title="插件管理" description="管理端只做平台治理；插件创建、草稿和 Agent 生成都属于本地客户端。">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Panel title="插件来源边界" description="这里不会提供新增插件入口。未来如需同步本地 Agent 产物，应走独立的发布/登记流程。" />
          <DataTable
            empty="暂无平台插件"
            headers={['插件', '说明', '状态', '操作']}
            rows={plugins.map((plugin) => [
              <span className="font-medium text-foreground">{plugin.name}</span>,
              <span className="line-clamp-2 max-w-md text-muted-foreground">{plugin.description || '—'}</span>,
              <StatusBadge value={plugin.status} />,
              <ActionButtonGroup>
                <Button variant="outline" onClick={() => selectPlugin(plugin)}>治理</Button>
                <Button variant={plugin.status === 'ENABLED' ? 'destructive' : 'outline'} onClick={() => toggle(plugin)}>{plugin.status === 'ENABLED' ? '禁用' : '启用'}</Button>
              </ActionButtonGroup>,
            ])}
          />
        </div>
        <DetailPanel title="插件治理" description="可维护说明和启用状态，不创建新插件。" empty={!selected && '请选择左侧插件'}>
          {selected && (
            <div className="space-y-4">
              <InfoGrid items={[['插件 ID', selected.id], ['插件名称', selected.name], ['当前状态', labelOf(selected.status)], ['更新时间', formatTime(selected.updatedAt)]]} />
              <Field label="插件说明"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
              <Field label="治理状态">
                <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as PluginStatus)}>
                  <option value="ENABLED">已启用</option>
                  <option value="DISABLED">已禁用</option>
                </NativeSelect>
              </Field>
              <Button onClick={save}>保存治理信息</Button>
            </div>
          )}
        </DetailPanel>
      </div>
    </Section>
  );
}

function Applications() {
  const [items, setItems] = useState<Application[]>([]);
  const [selected, setSelected] = useState<Application | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const load = () => api<{ applications: Application[] }>('/api/admin/team-admin-applications').then((r) => setItems(r.applications));
  useLoad(load);

  useEffect(() => {
    if (!selected) return;
    const next = items.find((item) => item.id === selected.id);
    if (next && next !== selected) selectApplication(next);
  }, [items, selected?.id]);

  function selectApplication(application: Application) {
    setSelected(application);
    setRejectReason(application.reviewReason || '');
  }

  async function approve(application: Application) {
    await run(() => api(`/api/admin/team-admin-applications/${application.id}/approve`, { method: 'POST' }).then(load), '申请已通过');
  }

  async function reject(application: Application) {
    const reason = selected?.id === application.id ? rejectReason.trim() : window.prompt('请输入驳回原因', application.reviewReason || '')?.trim();
    if (reason === undefined) return;
    if (!reason) return toast.error('请输入驳回原因');
    await run(() => api(`/api/admin/team-admin-applications/${application.id}/reject`, { method: 'POST', body: { reason } }).then(load), '申请已驳回');
  }

  return (
    <Section title="审批管理" description="待审批可通过或驳回；已通过只保留保守驳回，不自动删除团队和成员关系。">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <DataTable
          empty="暂无申请"
          headers={['申请人', '团队', '状态', '理由', '操作']}
          rows={items.map((application) => [
            <span className="font-medium text-foreground">{application.user.email}</span>,
            application.teamName,
            <StatusBadge value={application.status} />,
            <span className="line-clamp-2 max-w-md text-muted-foreground">{application.reason || '—'}</span>,
            <ApplicationActions application={application} onSelect={selectApplication} onApprove={approve} onReject={reject} />,
          ])}
        />
        <DetailPanel title="申请详情" description="查看完整申请信息，并填写驳回原因。" empty={!selected && '请选择左侧申请'}>
          {selected && (
            <div className="space-y-4">
              <InfoGrid
                items={[
                  ['申请人', `${selected.user.displayName}（${selected.user.email}）`],
                  ['团队名称', selected.teamName],
                  ['状态', labelOf(selected.status)],
                  ['提交时间', formatTime(selected.createdAt)],
                  ['处理时间', formatTime(selected.reviewedAt)],
                  ['处理人', selected.reviewedBy?.email || '—'],
                ]}
              />
              <Field label="申请理由"><Textarea value={selected.reason || '—'} readOnly /></Field>
              <Field label="驳回原因"><Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="驳回时必填" /></Field>
              <ActionButtonGroup>
                {selected.status === 'PENDING' && <Button onClick={() => approve(selected)}>通过</Button>}
                {selected.status !== 'REJECTED' && <Button variant="destructive" onClick={() => reject(selected)}>驳回</Button>}
              </ActionButtonGroup>
            </div>
          )}
        </DetailPanel>
      </div>
    </Section>
  );
}

function Audit() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  useLoad(() => api<{ logs: AuditLog[] }>('/api/admin/audit-logs').then((r) => setLogs(r.logs)));
  return (
    <Section title="审计日志" description="主表格展示中文动作和对象，原始动作码保留在详情里。">
      <DataTable
        empty="暂无审计日志"
        headers={['动作', '对象', '操作者', '时间', '详情']}
        rows={logs.map((log) => [
          actionLabel(log.action),
          targetLabel(log.targetType),
          log.actor?.email || '系统',
          formatTime(log.createdAt),
          <details className="max-w-md">
            <summary className="cursor-pointer text-primary">查看</summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">{JSON.stringify({ action: log.action, targetId: log.targetId, metadata: localizeMetadata(log.metadata) }, null, 2)}</pre>
          </details>,
        ])}
      />
    </Section>
  );
}

function ApplicationActions({
  application,
  onSelect,
  onApprove,
  onReject,
}: {
  application: Application;
  onSelect: (application: Application) => void;
  onApprove: (application: Application) => void;
  onReject: (application: Application) => void;
}) {
  return (
    <ActionButtonGroup>
      <Button variant="outline" onClick={() => onSelect(application)}>详情</Button>
      {application.status === 'PENDING' && <Button onClick={() => onApprove(application)}>通过</Button>}
      {application.status !== 'REJECTED' && <Button variant="destructive" onClick={() => onReject(application)}>驳回</Button>}
    </ActionButtonGroup>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <div className="mb-3">
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      {children}
    </div>
  );
}

function DetailPanel({ title, description, empty, children }: { title: string; description: string; empty?: false | string; children: ReactNode }) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <div className="mb-4">
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      {empty ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{empty}</div> : children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}

function NativeSelect({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />;
}

function ActionButtonGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: ReactNode[][]; empty?: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-background">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/60 text-muted-foreground">
          <tr>{headers.map((header) => <th key={header} className="px-4 py-3 text-left font-medium">{header}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {rows.length ? rows.map((row, index) => (
            <tr key={index} className="hover:bg-muted/30">
              {row.map((cell, cellIndex) => <td key={cellIndex} className="px-4 py-3 align-middle text-foreground">{cell}</td>)}
            </tr>
          )) : (
            <tr><td colSpan={headers.length} className="px-4 py-8 text-center text-muted-foreground">{empty || '暂无数据'}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const tone = value === 'ACTIVE' || value === 'ENABLED' || value === 'APPROVED'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : value === 'PENDING'
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : value === 'PLATFORM_ADMIN' || value === 'TEAM_ADMIN'
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : value === 'NONE' || value === 'MEMBER'
          ? 'border-slate-200 bg-slate-50 text-slate-700'
          : 'border-red-200 bg-red-50 text-red-700';
  return <span className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium', tone)}>{labelOf(value)}</span>;
}

function InfoGrid({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <div className="grid gap-2 rounded-xl border bg-muted/20 p-3 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="grid gap-1 sm:grid-cols-[96px_1fr]">
          <div className="text-muted-foreground">{label}</div>
          <div className="min-w-0 break-all text-foreground">{value || '—'}</div>
        </div>
      ))}
    </div>
  );
}

function labelOf(value?: string | null) {
  if (!value) return '—';
  return STATUS_LABEL[value] || value;
}

function actionLabel(value: string) {
  return ACTION_LABEL[value] || value;
}

function targetLabel(value: string) {
  return TARGET_LABEL[value] || value;
}

function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN');
}

function yuanToCents(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('金额格式不正确');
  return Math.round(amount * 100);
}

function activeMembers(team: Team) {
  return (team.members || []).filter((member) => member.status === 'ACTIVE');
}

function teamAdmins(team: Team) {
  return activeMembers(team).filter((member) => member.role === 'TEAM_ADMIN');
}

function adminNames(team: Team) {
  const names = teamAdmins(team).map((member) => member.user.displayName || member.user.email);
  return names.length ? names.join('、') : '—';
}

function localizeMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === 'string' ? labelOf(value) : value]));
}

function useLoad(effect: () => Promise<unknown>) {
  useEffect(() => { effect().catch((e) => toast.error((e as Error).message)); }, []);
}

async function run(fn: () => Promise<unknown>, success = '操作成功') {
  try {
    await fn();
    toast.success(success);
  } catch (e) {
    toast.error((e as Error).message);
  }
}