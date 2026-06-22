// 独立全屏登录页（非悬浮 Dialog）。
// 深色背景 + 左上角 logo + 居中表单卡 + 「← 返回首页」。
// 登录成功 onAuthed → App.tsx 切到后台；onBack 回落地页。
// 忘记密码：调管理端专用找回密码入口，弹窗收集邮箱。
// 组C 极验：后端配置了 geetestCaptchaId 时，管理端登录/找回密码表单集成「点击验证」极验组件。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, isPlatformAdminSession, setToken, type AdminSession } from '@/lib/api';
import { useGeetest } from '@/lib/geetest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface LoginPageProps {
  // 组D 安装向导完成后传入预填邮箱（刚创建的管理员账号），便于直接登录。
  onAuthed: (s: AdminSession) => void;
  onBack: () => void;
  initialEmail?: string;
}

interface PlatformInfo {
  platformName: string;
  logoUrl: string;
  geetestCaptchaId: string;
  geetestScenes: string;
}

export function LoginPage({ onAuthed, onBack, initialEmail }: LoginPageProps) {
  const [email, setEmail] = useState(initialEmail || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // 忘记密码弹窗（调管理端专用找回密码入口）。
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);

  // 组C 极验 + 组D 云同步平台信息：platform-info 取 geetestCaptchaId（公开端点，后端配置了才显验证码）+
  // platformName（云同步展示平台名，登录页顶栏与标题用平台名而非硬编码）+ geetestScenes（场景开关）。
  const [captchaId, setCaptchaId] = useState('');
  const [platformName, setPlatformName] = useState('');
  const [captchaScenes, setCaptchaScenes] = useState<Set<string>>(new Set());
  const loginCaptchaEnabled = !!captchaId && captchaScenes.has('admin_login');
  const forgotCaptchaEnabled = !!captchaId && captchaScenes.has('admin_forgot');
  const loginCaptcha = useGeetest(loginCaptchaEnabled ? captchaId : '');
  const forgotCaptcha = useGeetest(forgotOpen && forgotCaptchaEnabled ? captchaId : '');

  useEffect(() => {
    // platform-info 公开端点（auth:false），失败静默（未配置极验时 captchaId 保持空，不显验证码）。
    api<PlatformInfo>('/api/platform-info', { auth: false, method: 'GET' })
      .then((info) => {
        setCaptchaId(info.geetestCaptchaId ?? '');
        // 云同步平台名：后端 platformName（缺省 'LingFang'），用于顶栏与登录页标题展示。
        setPlatformName((info.platformName || '').trim());
        // 场景开关：解析逗号分隔串为 Set，管理端登录/找回密码分别判定是否强制验证码。
        setCaptchaScenes(new Set((info.geetestScenes ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)));
      })
      .catch(() => {
        /* 拉取失败不阻断登录 */
      });
  }, []);

  /** 当前管理端场景是否启用验证码。 */
  const sceneEnabled = (scene: 'admin_login' | 'admin_forgot') => (scene === 'admin_login' ? loginCaptchaEnabled : forgotCaptchaEnabled);

  async function submit() {
    if (sceneEnabled('admin_login') && !loginCaptcha.validateResult) return toast.error('请先完成验证码');
    setLoading(true);
    try {
      const result = await api<AdminSession>('/api/auth/admin/login', {
        auth: false,
        method: 'POST',
        body: { email, password, captcha: loginCaptcha.validateResult ?? undefined },
      });
      if (!result.token) throw new Error('登录失败，请稍后重试');
      if (!isPlatformAdminSession(result)) throw new Error('该账号不是平台管理员');
      setToken(result.token);
      loginCaptcha.reset();
      onAuthed(result);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function onForgotPassword() {
    if (!forgotEmail.trim()) return toast.error('请输入邮箱');
    if (sceneEnabled('admin_forgot') && !forgotCaptcha.validateResult) return toast.error('请先完成验证码');
    setForgotLoading(true);
    try {
      const result = await api<{ message?: string }>('/api/auth/admin/forgot-password', {
        auth: false,
        method: 'POST',
        body: { email: forgotEmail.trim(), captcha: forgotCaptcha.validateResult ?? undefined },
      });
      toast.success(result.message ?? '若该邮箱已注册且邮件服务可用，将收到重置链接');
      setForgotOpen(false);
      setForgotEmail('');
      forgotCaptcha.reset();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setForgotLoading(false);
    }
  }

  // 打开忘记密码弹窗时预填当前登录邮箱（便于直接发送）。
  useEffect(() => {
    if (forgotOpen) setForgotEmail(email);
  }, [forgotOpen, email]);

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
              className="lf-display inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-bold"
              style={{ borderColor: 'var(--lf-accent)', color: 'var(--lf-accent)' }}
            >
              灵
            </span>
            {/* 云同步平台名：后端 platformName（缺省 'LingFang'），与后台保持一致。 */}
            <span className="lf-display text-sm font-semibold tracking-tight">{platformName || 'LingFang'}</span>
          </div>
        </header>

        {/* 居中表单卡 */}
        <div className="lf-login-wrap">
          <div className="lf-login-card">
            <h1 className="lf-display text-xl font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>
              {platformName ? `${platformName} · 登录管理后台` : '登录管理后台'}
            </h1>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
              初始账号在系统部署时创建。
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
                  autoComplete="off"
                  spellCheck={false}
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
                  autoComplete="new-password"
                  className="w-full rounded-lg border px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--lf-accent)]"
                  style={{
                    backgroundColor: 'var(--lf-bg-elevated)',
                    borderColor: 'var(--lf-border-bright)',
                    color: 'var(--lf-fg)',
                  }}
                />
              </div>
              {/* 组C 极验：管理端登录场景启用时渲染「点击验证」组件。
                  场景未启用 / captchaId 为空则不渲染。 */}
              {sceneEnabled('admin_login') && (
                <div className="flex flex-col gap-1">
                  <div ref={loginCaptcha.containerRef} />
                  {!loginCaptcha.ready && <p className="text-xs" style={{ color: 'var(--lf-fg-muted)' }}>验证码组件加载中…</p>}
                  {loginCaptcha.ready && !loginCaptcha.validateResult && <p className="text-xs" style={{ color: 'var(--lf-fg-muted)' }}>请点击完成上方验证</p>}
                  {loginCaptcha.validateResult && <p className="text-xs" style={{ color: 'var(--lf-accent)' }}>验证已通过</p>}
                </div>
              )}
            </div>

            <button
              onClick={submit}
              disabled={loading}
              className="lf-btn-primary mt-6 w-full justify-center text-base"
            >
              {loading ? '登录中…' : '登录管理端'}
            </button>

            {/* 忘记密码入口：调管理端专用端点发重置邮件 */}
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => setForgotOpen(true)}
                className="text-xs transition-colors hover:underline"
                style={{ color: 'var(--lf-fg-muted)' }}
              >
                忘记密码？
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 忘记密码对话框 */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>找回密码</DialogTitle>
            <DialogDescription>输入注册邮箱，我们会发送密码重置链接到你的邮箱。</DialogDescription>
          </DialogHeader>
          <input
            type="text"
            placeholder="注册邮箱"
            value={forgotEmail}
            onChange={(e) => setForgotEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onForgotPassword()}
            className="w-full rounded-lg border px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--lf-accent)]"
            style={{
              backgroundColor: 'var(--lf-bg-elevated)',
              borderColor: 'var(--lf-border-bright)',
              color: 'var(--lf-fg)',
            }}
          />
          <div className="mt-3">
            {sceneEnabled('admin_forgot') && (
              <div className="flex flex-col gap-1">
                <div ref={forgotCaptcha.containerRef} />
                {!forgotCaptcha.ready && <p className="text-xs" style={{ color: 'var(--lf-fg-muted)' }}>验证码组件加载中…</p>}
                {forgotCaptcha.ready && !forgotCaptcha.validateResult && <p className="text-xs" style={{ color: 'var(--lf-fg-muted)' }}>请点击完成上方验证</p>}
                {forgotCaptcha.validateResult && <p className="text-xs" style={{ color: 'var(--lf-accent)' }}>验证已通过</p>}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForgotOpen(false)}>取消</Button>
            <Button onClick={onForgotPassword} disabled={forgotLoading}>
              {forgotLoading ? '发送中…' : '发送重置链接'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
