// 首次启动安装向导（桌面端，Card 风格，与 Auth.tsx 同款布局）。
//
// 触发条件：App.tsx 在 backendUrl 已配置且无 token 时，先查 GET /api/setup/status，
// needsSetup=true（DB 无 PLATFORM_ADMIN）则渲染本组件替代 Auth。
// 表单：管理员邮箱 / 密码 / 确认密码 / 显示名 / 平台名称。
// 提交：POST /api/setup。成功后调 onDone，App.tsx 关闭向导转登录（Auth）。
//
// 与 admin 端 setup-wizard.tsx 同后端契约，前端风格各自跟随宿主（桌面 Card / admin 落地页深色）。
import { useState } from 'react';
import { toast } from 'sonner';
import { api, isEmail } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup } from '@/components/ui/field';
import { LoadingButton } from '@/components/loading-button';

interface SetupWizardProps {
  /** 安装成功后调用：App.tsx 关闭向导 + 转登录（Auth）。 */
  onDone: () => void;
}

export function SetupWizard({ onDone }: SetupWizardProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [platformName, setPlatformName] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!isEmail(email)) return toast.error('邮箱格式不正确');
    if (password.length < 8) return toast.error('密码至少 8 位');
    if (password !== confirmPassword) return toast.error('两次输入的密码不一致');

    setLoading(true);
    try {
      await api('/api/setup', {
        auth: false,
        method: 'POST',
        body: {
          email: email.trim(),
          password,
          displayName: displayName.trim() || undefined,
          platformName: platformName.trim() || undefined,
        },
      });
      toast.success('平台初始化完成，请使用刚创建的账号登录');
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-lg animate-in fade-in zoom-in-95 duration-300">
      <CardHeader>
        <CardTitle>平台初始化</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          当前平台尚未初始化。创建首个平台管理员账号并设置平台名称，完成后即可登录。
        </p>
        <FieldGroup className="gap-3">
          <Field>
            <Input placeholder="管理员邮箱" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
          <Field>
            <Input type="password" placeholder="密码（≥8 位）" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
          <Field>
            <Input type="password" placeholder="确认密码" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
          <Field>
            <Input placeholder="显示名称（可选）" value={displayName} onChange={(e) => setDisplayName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
          <Field>
            <Input placeholder="平台名称（可选）" value={platformName} onChange={(e) => setPlatformName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
        </FieldGroup>
        <LoadingButton className="w-full" loading={loading} onClick={submit}>完成初始化</LoadingButton>
      </CardContent>
    </Card>
  );
}
