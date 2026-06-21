import { lazy, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LogOutIcon, UserRoundIcon } from 'lucide-react';
import { api, isEmail, type ApiError } from '@/lib/api';
import type { AccountSettingsTab, Session, SettingsTab } from '@/lib/types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AccountSettingsNav } from '@/components/AccountSettingsNav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dragRegionProps } from '@/lib/window-drag';
import { ListSkeleton } from '@/lib/motion';

const TeamHome = lazy(() => import('@/pages/TeamHome').then((m) => ({ default: m.TeamHome })));
const TeamManage = lazy(() => import('@/pages/TeamManage').then((m) => ({ default: m.TeamManage })));
const Wallet = lazy(() => import('@/pages/Wallet').then((m) => ({ default: m.Wallet })));
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })));

const ROLE_LABEL: Record<string, string> = {
  TEAM_ADMIN: '团队管理员',
  MEMBER: '成员',
};

export function AccountDialog({
  applySession,
  onOpenChange,
  onSettingsTabChange,
  onTabChange,
  open,
  resetSession,
  session,
  settingsTab,
  tab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  applySession: (patch: Partial<Session>) => void;
  resetSession: () => void;
  tab: AccountSettingsTab;
  onTabChange: (tab: AccountSettingsTab) => void;
  settingsTab: SettingsTab;
  onSettingsTabChange: (tab: SettingsTab) => void;
}) {
  const rootTab = tab === 'team-manage' ? 'team' : tab;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] max-h-[86vh] w-[94vw] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="border-b px-5 py-4" {...dragRegionProps}>
          <DialogTitle className="flex items-center gap-2" data-tauri-drag-region>
            <UserRoundIcon className="size-4" />账户设置
          </DialogTitle>
          <DialogDescription>账户、团队、钱包和应用设置集中在这里。</DialogDescription>
        </DialogHeader>
        <Tabs value={rootTab} orientation="vertical" onValueChange={(value) => onTabChange(value as AccountSettingsTab)} className="min-h-0 flex-1 flex-row gap-0">
          <AccountSettingsNav value={rootTab} />
          <ScrollArea className="min-w-0 flex-1">
            <div className="p-5">
              <Suspense fallback={<ListSkeleton rows={6} />}>
                <TabsContent value="account" keepMounted>
                  <AccountPanel
                    applySession={applySession}
                    onClose={() => onOpenChange(false)}
                    resetSession={resetSession}
                    session={session}
                  />
                </TabsContent>
                <TabsContent value="team" keepMounted>
                  <TeamPanel
                    isTeamAdmin={session.role === 'TEAM_ADMIN'}
                    tab={tab}
                    onTabChange={onTabChange}
                  />
                </TabsContent>
                <TabsContent value="wallet" keepMounted>
                  <Wallet />
                </TabsContent>
                <TabsContent value="settings" keepMounted>
                  <Settings value={settingsTab} onValueChange={(value) => onSettingsTabChange(value as SettingsTab)} />
                </TabsContent>
              </Suspense>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function TeamPanel({
  isTeamAdmin,
  onTabChange,
  tab,
}: {
  isTeamAdmin: boolean;
  onTabChange: (tab: AccountSettingsTab) => void;
  tab: AccountSettingsTab;
}) {
  if (!isTeamAdmin) {
    return tab === 'team-manage' ? <PermissionPanel /> : <TeamHome />;
  }

  const teamTab = tab === 'team-manage' ? 'manage' : 'overview';

  return (
    <Tabs
      value={teamTab}
      onValueChange={(value) => onTabChange(value === 'manage' ? 'team-manage' : 'team')}
      className="flex flex-col gap-4"
    >
      <TabsList className="inline-flex w-fit max-w-full gap-1">
        <TabsTrigger value="overview" className="px-3">团队概览</TabsTrigger>
        <TabsTrigger value="manage" className="px-3">团队管理</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" keepMounted className="mt-0 focus-visible:outline-none">
        <TeamHome />
      </TabsContent>
      <TabsContent value="manage" keepMounted className="mt-0 focus-visible:outline-none">
        <TeamManage />
      </TabsContent>
    </Tabs>
  );
}

function AccountPanel({
  applySession,
  onClose,
  resetSession,
  session,
}: {
  applySession: (patch: Partial<Session>) => void;
  onClose: () => void;
  resetSession: () => void;
  session: Session;
}) {
  const [displayName, setDisplayName] = useState(session.displayName || '');
  const [email, setEmail] = useState(session.email || '');
  const [password, setPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    setDisplayName(session.displayName || '');
    setEmail(session.email || '');
    setPassword('');
  }, [session.displayName, session.email]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <AccountSummary session={session} />
      <ProfileForm
        displayName={displayName}
        email={email}
        saving={savingProfile}
        onDisplayNameChange={setDisplayName}
        onEmailChange={setEmail}
        onSave={() => { void saveProfile({ applySession, displayName, email, onClose, setSavingProfile }); }}
      />
      <PasswordForm
        password={password}
        saving={savingPassword}
        onPasswordChange={setPassword}
        onSave={() => { void savePassword({ onClose, password, setPassword, setSavingPassword }); }}
      />
      <Button variant="ghost" className="w-full justify-center text-destructive hover:text-destructive" onClick={() => { resetSession(); onClose(); }}>
        <LogOutIcon className="size-4" />退出登录
      </Button>
    </div>
  );
}

function AccountSummary({ session }: { session: Session }) {
  const roleLabel = session.role ? (ROLE_LABEL[session.role] || session.role) : '已登录';
  return (
    <div className="rounded-lg border bg-muted/40 p-3 text-xs">
      <div className="flex justify-between gap-3"><span className="text-muted-foreground">团队</span><span className="break-all text-right font-mono">{session.tenantName || '未加入'}</span></div>
      <div className="mt-1 flex justify-between gap-3"><span className="text-muted-foreground">角色</span><span className="text-right font-mono">{roleLabel}</span></div>
      <div className="mt-1 flex justify-between gap-3"><span className="text-muted-foreground">用户 ID</span><span className="break-all text-right font-mono">{session.userId || '-'}</span></div>
    </div>
  );
}

function ProfileForm({
  displayName,
  email,
  saving,
  onDisplayNameChange,
  onEmailChange,
  onSave,
}: {
  displayName: string;
  email: string;
  saving: boolean;
  onDisplayNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="account-name">昵称</Label>
      <Input id="account-name" value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} placeholder="显示名称" />
      <Label htmlFor="account-email">邮箱</Label>
      <Input id="account-email" type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} placeholder="name@example.com" />
      <Button onClick={onSave} disabled={saving}>{saving ? '保存中...' : '保存账户信息'}</Button>
    </div>
  );
}

function PasswordForm({
  password,
  saving,
  onPasswordChange,
  onSave,
}: {
  password: string;
  saving: boolean;
  onPasswordChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <Label htmlFor="account-password">重置密码</Label>
      <Input id="account-password" type="password" value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder="新密码（至少 8 位）" />
      <Button variant="outline" onClick={onSave} disabled={saving}>{saving ? '重置中...' : '重置密码'}</Button>
    </div>
  );
}

function PermissionPanel() {
  return (
    <div className="mx-auto max-w-xl rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
      <div className="font-medium text-foreground">需要团队管理员权限</div>
      <p className="mt-1">团队管理页只对团队管理员开放。</p>
    </div>
  );
}

async function saveProfile({
  applySession,
  displayName,
  email,
  onClose,
  setSavingProfile,
}: {
  applySession: (patch: Partial<Session>) => void;
  displayName: string;
  email: string;
  onClose: () => void;
  setSavingProfile: (saving: boolean) => void;
}) {
  const nextName = displayName.trim();
  const nextEmail = email.trim().toLowerCase();
  if (!nextName) return toast.error('昵称不能为空');
  if (!isEmail(nextEmail)) return toast.error('邮箱格式不正确');
  setSavingProfile(true);
  try {
    const result = await api<{ user?: { displayName?: string; email?: string } }>('/api/auth/me', {
      method: 'PATCH',
      body: { displayName: nextName, email: nextEmail },
    });
    applySession({ displayName: result.user?.displayName ?? nextName, email: result.user?.email ?? nextEmail });
    toast.success('账户信息已更新');
    onClose();
  } catch (error) {
    const err = error as ApiError;
    toast.error(err.status === 404 || err.status === 405 ? '暂不支持修改账户信息' : err.message);
  } finally {
    setSavingProfile(false);
  }
}

async function savePassword({
  onClose,
  password,
  setPassword,
  setSavingPassword,
}: {
  onClose: () => void;
  password: string;
  setPassword: (password: string) => void;
  setSavingPassword: (saving: boolean) => void;
}) {
  if (password.length < 8) return toast.error('新密码至少 8 位');
  setSavingPassword(true);
  try {
    await api('/api/auth/me', { method: 'PATCH', body: { password } });
    toast.success('密码已重置');
    setPassword('');
    onClose();
  } catch (error) {
    const err = error as ApiError;
    toast.error(err.status === 404 || err.status === 405 ? '暂不支持修改密码' : err.message);
  } finally {
    setSavingPassword(false);
  }
}
