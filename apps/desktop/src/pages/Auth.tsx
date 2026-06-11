import { useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { api, isEmail, type ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { LoadingButton } from '@/components/loading-button';

export function Auth() {
  const { applySession } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  async function loginCore(em: string, pw: string) {
    const r = await api<{ token: string; user_id: string; display_name?: string; is_platform_admin?: boolean }>('/auth/login', {
      auth: false, method: 'POST', body: { email: em, password: pw },
    });
    applySession({ token: r.token, userId: r.user_id, displayName: r.display_name ?? null, isPlatformAdmin: !!r.is_platform_admin });
  }

  async function onLogin() {
    if (!isEmail(email)) return toast.error('请输入有效的邮箱地址');
    if (!password) return toast.error('请输入密码');
    setLoading(true);
    try {
      await loginCore(email.trim(), password);
    } catch (e) {
      const err = e as ApiError;
      toast.error(err.code === 'unauthorized' ? '邮箱或密码错误' : err.message);
    } finally {
      setLoading(false);
    }
  }

  async function onRegister() {
    if (!isEmail(email)) return toast.error('请输入有效的邮箱地址（如 name@example.com）');
    if (password.length < 8) return toast.error('密码至少 8 位');
    setLoading(true);
    try {
      await api('/auth/register', {
        auth: false, method: 'POST',
        body: { email: email.trim(), password, display_name: name.trim() || email.trim() },
      });
      toast.success('注册成功，正在登录…');
      await loginCore(email.trim(), password);
    } catch (e) {
      const err = e as ApiError;
      toast.error(/已存在|duplicate/.test(err.message) ? '该邮箱已注册，请直接登录' : err.message);
    } finally {
      setLoading(false);
    }
  }

  const submit = mode === 'login' ? onLogin : onRegister;

  return (
    <Card className="w-full max-w-sm animate-in fade-in zoom-in-95 duration-300">
      <CardHeader>
        <CardTitle key={mode} className="animate-in fade-in slide-in-from-top-2 duration-300">
          {mode === 'login' ? '登录' : '注册新账号'}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input
          placeholder="邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <Input
          type="password"
          placeholder={mode === 'login' ? '密码' : '密码（≥8 位）'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {/* 昵称字段仅注册可见：用 grid 行高过渡做平滑展开/收起 */}
        <div className={cn('grid transition-all duration-300 ease-out', mode === 'register' ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
          <div className="overflow-hidden">
            <Input
              placeholder="昵称（可选）"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </div>
        <LoadingButton className="w-full" loading={loading} onClick={submit}>
          {mode === 'login' ? '登录' : '注册'}
        </LoadingButton>
        <p className="text-center text-sm text-muted-foreground">
          {mode === 'login' ? (
            <>还没有账号？<button className="text-primary hover:underline" onClick={() => setMode('register')}>注册新账号</button></>
          ) : (
            <>已有账号？<button className="text-primary hover:underline" onClick={() => setMode('login')}>去登录</button></>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
