// ProfilePanel.tsx — 个人资料面板（项 14）：昵称/邮箱/改密/退出登录。
//
// 从原 AccountDialog 的 AccountPanel 抽出（AccountDialog 聚合体已删）。由 ProfileDialog
// （PanelDialog 包裹）承载，从 AvatarMenu「个人资料」项打开。逻辑零改动，仅迁移位置。
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Building2Icon,
  KeyRoundIcon,
  LogOutIcon,
  MailIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from 'lucide-react';
import { api, isEmail, type ApiError } from '@/lib/api';
import type { Session } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingButton } from '@/components/loading-button';

const ROLE_LABEL: Record<string, string> = {
  TEAM_ADMIN: '团队管理员',
  MEMBER: '成员',
};

export function ProfilePanel({
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
    <div className="mx-auto flex max-w-lg flex-col gap-4">
      <AccountSummary session={session} />
      <ProfileForm
        displayName={displayName}
        email={email}
        saving={savingProfile}
        onDisplayNameChange={setDisplayName}
        onEmailChange={setEmail}
        onSave={() => {
          void saveProfile({ applySession, displayName, email, onClose, setSavingProfile });
        }}
      />
      <PasswordForm
        password={password}
        saving={savingPassword}
        onPasswordChange={setPassword}
        onSave={() => {
          void savePassword({ onClose, password, setPassword, setSavingPassword });
        }}
      />
      <div className="flex items-center justify-between gap-4 rounded-xl border border-destructive/15 bg-destructive/5 p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">退出当前账户</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            本机登录状态将被清除，不会删除你的账户数据。
          </p>
        </div>
        <Button
          variant="destructive"
          className="shrink-0"
          onClick={() => {
            resetSession();
            onClose();
          }}
        >
          <LogOutIcon />
          退出登录
        </Button>
      </div>
    </div>
  );
}

function AccountSummary({ session }: { session: Session }) {
  const roleLabel = session.role ? ROLE_LABEL[session.role] || session.role : '已登录';
  const displayName = session.displayName || session.email || '灵坊用户';
  const initials = displayName.trim().slice(0, 2).toUpperCase();
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center gap-4 border-b bg-muted/30 p-5">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary ring-1 ring-primary/15">
          {initials || <UserRoundIcon className="size-6" />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{displayName}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <MailIcon className="size-3.5 shrink-0" />
            <span className="truncate">{session.email || '尚未设置邮箱'}</span>
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-sm">
          <ShieldCheckIcon className="size-3.5 text-primary" />
          {roleLabel}
        </span>
      </div>
      <div className="grid gap-px bg-border sm:grid-cols-2">
        <SummaryItem
          icon={<Building2Icon />}
          label="当前团队"
          value={session.tenantName || '暂未加入团队'}
        />
        <SummaryItem icon={<UserRoundIcon />} label="用户 ID" value={session.userId || '-'} mono />
      </div>
    </div>
  );
}

function SummaryItem({
  icon,
  label,
  value,
  mono = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 bg-card px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className={`truncate text-xs font-medium ${mono ? 'font-mono' : ''}`} title={value}>
          {value}
        </p>
      </div>
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
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <SectionHeading
        icon={<UserRoundIcon />}
        title="基本资料"
        description="这些信息会展示在你的团队空间中。"
      />
      <div className="mt-4 grid gap-3">
        <FieldGroup className="gap-3">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="account-name">昵称</FieldLabel>
            <Input
              id="account-name"
              className="h-9"
              value={displayName}
              onChange={(event) => onDisplayNameChange(event.target.value)}
              placeholder="显示名称"
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="account-email">邮箱</FieldLabel>
            <Input
              id="account-email"
              className="h-9"
              type="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              placeholder="name@example.com"
            />
          </Field>
        </FieldGroup>
        <LoadingButton className="mt-1 justify-self-end" loading={saving} onClick={onSave}>
          {saving ? '保存中…' : '保存基本资料'}
        </LoadingButton>
      </div>
    </section>
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
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <SectionHeading
        icon={<KeyRoundIcon />}
        title="登录密码"
        description="建议使用至少 8 位且不易猜测的新密码。"
      />
      <div className="mt-4 grid gap-3">
        <Field className="gap-1.5">
          <FieldLabel htmlFor="account-password">新密码</FieldLabel>
          <Input
            id="account-password"
            className="h-9"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="输入至少 8 位新密码"
          />
        </Field>
        <LoadingButton
          variant="outline"
          className="justify-self-end"
          loading={saving}
          onClick={onSave}
        >
          {saving ? '重置中…' : '更新密码'}
        </LoadingButton>
      </div>
    </section>
  );
}

function SectionHeading({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-4">
        {icon}
      </span>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
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
    applySession({
      displayName: result.user?.displayName ?? nextName,
      email: result.user?.email ?? nextEmail,
    });
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
