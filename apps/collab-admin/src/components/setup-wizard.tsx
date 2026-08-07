// 首次启动安装向导（独立全屏页，深色落地页风格，与 LoginPage 同款）。
//
// 触发条件：App.tsx 启动时调 GET /api/setup/status，needsSetup=true（DB 无 PLATFORM_ADMIN）时渲染本组件。
// 表单：管理员邮箱 / 密码 / 确认密码 / 显示名 / 平台名称。
// 提交：POST /api/setup。成功后调 onDone(email)，App.tsx 关闭向导 + 转登录页（预填邮箱）。
//
// 安全约束（与后端 setup.controller 对齐）：
//  - 该端点仅未初始化时可用，完成后后端自动返回 403 setup_already_done。
//  - 前端不依赖 403 判定（status 端点已是门禁），仅展示后端返回的 message。
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface SetupWizardProps {
  /** 安装成功后调用：App.tsx 关闭向导 + 转登录页（预填邮箱）。 */
  onDone: (email: string) => void;
}

export function SetupWizard({ onDone }: SetupWizardProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [platformName, setPlatformName] = useState('');
  const [loading, setLoading] = useState(false);

  function submit() {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) return toast.error('请输入管理员邮箱');
    if (password.length < 8) return toast.error('密码至少 8 位');
    if (password !== confirmPassword) return toast.error('两次输入的密码不一致');

    setLoading(true);
    api<{ ok: boolean }>('/api/setup', {
      auth: false,
      method: 'POST',
      body: {
        email: normalizedEmail,
        password,
        displayName: displayName.trim() || undefined,
        platformName: platformName.trim() || undefined,
      },
    })
      .then(() => {
        toast.success('平台初始化完成，请使用刚创建的账号登录');
        onDone(normalizedEmail.toLowerCase());
      })
      .catch((e) => {
        toast.error((e as Error).message);
      })
      .finally(() => setLoading(false));
  }

  return (
    <div className="landing-scope lf-noise">
      <div className="lf-grid-bg" />
      <div className="lf-glow" />
      <div className="lf-content">
        {/* 顶栏：logo */}
        <header className="lf-page-topbar">
          <div />
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
          <div className="lf-login-card" style={{ maxWidth: '28rem' }}>
            <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>
              平台初始化
            </h1>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
              创建首个平台管理员账号并设置平台名称。完成后可登录管理端继续配置。
            </p>

            <div className="mt-6 space-y-4">
              <Field label="管理员邮箱">
                <TextInput
                  value={email}
                  onChange={setEmail}
                  onSubmit={submit}
                  autoComplete="username"
                />
              </Field>
              <Field label="密码（至少 8 位）">
                <TextInput
                  type="password"
                  value={password}
                  onChange={setPassword}
                  onSubmit={submit}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="确认密码">
                <TextInput
                  type="password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  onSubmit={submit}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="显示名称（可选）">
                <TextInput value={displayName} onChange={setDisplayName} onSubmit={submit} />
              </Field>
              <Field label="平台名称（可选）">
                <TextInput value={platformName} onChange={setPlatformName} onSubmit={submit} />
              </Field>
            </div>

            <button
              onClick={submit}
              disabled={loading}
              className="lf-btn-primary mt-6 w-full justify-center text-base"
            >
              {loading ? '初始化中…' : '完成初始化'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 表单字段容器：标签 + 输入框，复用落地页深色变量。 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--lf-fg-muted)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** 深色风格文本输入框：内联样式与 LoginPage 的输入框完全一致（落地页 CSS 变量），
 *  不新增 CSS 类，保持改动最小化。Enter 键提交表单。 */
function TextInput({
  value,
  onChange,
  onSubmit,
  type = 'text',
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <input
      type={type}
      autoComplete={autoComplete}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
      className="w-full rounded-lg border px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--lf-accent)]"
      style={{
        backgroundColor: 'var(--lf-bg-elevated)',
        borderColor: 'var(--lf-border-bright)',
        color: 'var(--lf-fg)',
      }}
    />
  );
}
