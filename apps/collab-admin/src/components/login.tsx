import { useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, isPlatformAdminSession, setToken, type AdminSession } from '@/lib/api';

export function Login({ onAuthed }: { onAuthed: (s: AdminSession) => void }) {
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('ChangeMe123!');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    try {
      const result = await api<AdminSession>('/api/auth/login', {
        auth: false,
        method: 'POST',
        body: { email, password },
      });
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
          <Input
            placeholder="密码"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <Button className="w-full" disabled={loading} onClick={submit}>
            {loading ? '登录中…' : '登录管理端'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}