// 独立全屏登录页（非悬浮 Dialog）。
// 深色背景 + 左上角 logo + 居中表单卡 + 「← 返回首页」。
// 登录成功 onAuthed → App.tsx 切到后台；onBack 回落地页。
import { useState } from 'react';
import { toast } from 'sonner';
import { api, isPlatformAdminSession, setToken, type AdminSession } from '@/lib/api';

interface LoginPageProps {
  onAuthed: (s: AdminSession) => void;
  onBack: () => void;
}

export function LoginPage({ onAuthed, onBack }: LoginPageProps) {
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
    <div className="landing-scope lf-noise">
      <div className="lf-grid-bg" />
      <div className="lf-glow" />
      <div className="lf-content">
        {/* 顶栏：logo + 返回首页 */}
        <header className="lf-page-topbar">
          <button onClick={onBack} className="lf-back-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            返回首页
          </button>
          <div className="flex items-center gap-2">
            <span
              className="lf-mono inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-bold"
              style={{ borderColor: 'var(--lf-accent)', color: 'var(--lf-accent)' }}
            >
              L
            </span>
            <span className="text-sm font-semibold tracking-tight">LingFang</span>
          </div>
        </header>

        {/* 居中表单卡 */}
        <div className="lf-login-wrap">
          <div className="lf-login-card">
            <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>
              平台管理员登录
            </h1>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
              初始账号由后端 seed/bootstrap 创建。
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--lf-fg-muted)' }}>
                  邮箱
                </label>
                <input
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--lf-accent)]"
                  style={{
                    backgroundColor: 'var(--lf-bg-elevated)',
                    borderColor: 'var(--lf-border-bright)',
                    color: 'var(--lf-fg)',
                  }}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--lf-fg-muted)' }}>
                  密码
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--lf-accent)]"
                  style={{
                    backgroundColor: 'var(--lf-bg-elevated)',
                    borderColor: 'var(--lf-border-bright)',
                    color: 'var(--lf-fg)',
                  }}
                />
              </div>
            </div>

            <button
              onClick={submit}
              disabled={loading}
              className="lf-btn-primary mt-6 w-full justify-center text-base"
            >
              {loading ? '登录中…' : '登录管理端'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
