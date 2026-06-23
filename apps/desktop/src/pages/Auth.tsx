import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ServerIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api, isEmail, normalizeBackendUrl, testBackendUrl, type ApiError } from '@/lib/api';
import type { CollabSessionResponse, PlatformInfo } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { LoadingButton } from '@/components/loading-button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { dragRegionProps } from '@/lib/window-drag';

export function Auth() {
  const { applyCollabSession, backendUrl, saveBackendUrl } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [wantsTeamAdmin, setWantsTeamAdmin] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [reason, setReason] = useState('');
  const [backendUrlDraft, setBackendUrlDraft] = useState(backendUrl || '');
  const [showBackendSettings, setShowBackendSettings] = useState(!backendUrl);
  const [loading, setLoading] = useState(false);
  const [testingBackend, setTestingBackend] = useState(false);

  // 找回密码（Top5）：「忘记密码」对话框 + 「重置密码」对话框。
  // reset_token 从邮件链接的 URL query 解析（?reset_token=xxx），存在则自动打开重置密码对话框。
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  // 云同步平台信息：platform-info 取 platformName（登录页标题用平台名而非硬编码）。
  // 仅在 backendUrl 已配置时拉取（未配置时调用方本就要先设后端地址）。
  const [platformName, setPlatformName] = useState('');

  useEffect(() => {
    if (!backendUrl) return;
    // platform-info 公开端点（auth:false），失败静默（后端可能未实现该端点的旧版本）。
    api<PlatformInfo>('/api/platform-info', { auth: false, method: 'GET' })
      .then((info) => {
        // 云同步平台名：后端 platformName（缺省 '灵坊工作台'），用于登录页标题展示。
        setPlatformName((info.platformName || '').trim());
      })
      .catch(() => {
        /* 拉取失败不阻断登录（开发态后端可能未实现该端点的旧版本） */
      });
  }, [backendUrl]);

  useEffect(() => {
    // 从 URL 解析 reset_token（邮件重置链接形如 <base>/?reset_token=xxx）。
    try {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('reset_token');
      if (token) {
        setResetToken(token);
        setResetOpen(true);
        // 清掉 URL 上的 token，避免刷新/分享泄漏。
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch {
      /* webview 可能无 location API，忽略 */
    }
  }, []);

  async function onForgotPassword() {
    if (!isEmail(forgotEmail)) return toast.error('邮箱格式不正确');
    setForgotLoading(true);
    try {
      const result = await api<{ message?: string }>('/api/auth/forgot-password', {
        auth: false,
        method: 'POST',
        body: { email: forgotEmail.trim() },
      });
      toast.success(result.message ?? '若该邮箱已注册且邮件服务可用，将收到重置链接');
      setForgotOpen(false);
      setForgotEmail('');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setForgotLoading(false);
    }
  }

  async function onResetPassword() {
    if (newPassword.length < 8) return toast.error('新密码至少 8 位');
    if (!resetToken) return toast.error('重置链接无效');
    setResetLoading(true);
    try {
      await api('/api/auth/reset-password', { auth: false, method: 'POST', body: { token: resetToken, newPassword } });
      toast.success('密码已重置，请使用新密码登录');
      setResetOpen(false);
      setResetToken('');
      setNewPassword('');
      // 重置成功后切到登录态，预填邮箱（如用户记得）。
      setMode('login');
      if (forgotEmail) setEmail(forgotEmail);
      setPassword('');
    } catch (e) {
      const err = e as ApiError;
      toast.error(err.message);
    } finally {
      setResetLoading(false);
    }
  }

  async function loginCore(em: string, pw: string) {
    const r = await api<CollabSessionResponse>('/api/auth/login', {
      auth: false, method: 'POST', body: { email: em, password: pw },
    });
    if (!r.token) throw new Error('登录响应缺少 token');
    applyCollabSession(r);
  }

  async function onLogin() {
    if (!backendUrl) return toast.error('先在下方设置公司平台地址');
    if (!isEmail(email)) return toast.error('邮箱格式不正确');
    if (!password) return toast.error('输入密码');
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
    if (!backendUrl) return toast.error('先在下方设置公司平台地址');
    if (!isEmail(email)) return toast.error('邮箱格式不正确（如 name@example.com）');
    if (password.length < 8) return toast.error('密码至少 8 位');
    if (wantsTeamAdmin && !teamName.trim()) return toast.error('填写要申请管理的团队名称');
    setLoading(true);
    try {
      const r = await api<CollabSessionResponse>('/api/auth/register', {
        auth: false,
        method: 'POST',
        body: {
          email: email.trim(),
          password,
          displayName: name.trim() || email.trim(),
          wantsTeamAdmin,
          teamName: teamName.trim(),
          reason: reason.trim(),
        },
      });
      toast.success(wantsTeamAdmin ? '申请已提交，等待平台管理员审批' : '注册成功，请输入团队邀请码');
      applyCollabSession(r);
    } catch (e) {
      const err = e as ApiError;
      // 修复 DESK-AUTH-01：此前用正则 /已存在|duplicate|registered/ 匹配后端冲突消息，
      // 但 collab-api 在邮箱已存在时抛 conflict('该邮箱已注册')，其消息文本不含上述任一子串，
      // 正则不匹配 → 友好引导「该邮箱已注册，请直接登录」永不触发。
      // 改为基于 err.code（ApiError 已透传）精确判定，与 onLogin 的 err.code==='unauthorized' 模式一致。
      toast.error(err.code === 'conflict' ? '该邮箱已注册，请直接登录' : err.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveBackend() {
    const normalized = normalizeBackendUrl(backendUrlDraft);
    if (!normalized) return toast.error('服务地址需以 http:// 或 https:// 开头');
    setTestingBackend(true);
    try {
      await testBackendUrl(normalized);
      if (!saveBackendUrl(normalized)) return toast.error('公司平台地址格式不正确');
      setBackendUrlDraft(normalized);
      setShowBackendSettings(false);
      toast.success('公司平台地址已保存');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestingBackend(false);
    }
  }

  const submit = mode === 'login' ? onLogin : onRegister;

  return (
    <>
      <Card className="w-full max-w-lg animate-in fade-in zoom-in-95 duration-300">
        <CardHeader>
          {/* 云同步平台名：展示后端 platformName（与后台一致），缺省时 fallback 到「灵坊工作台」。 */}
          {platformName && (
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 font-semibold text-primary">
                {platformName.slice(0, 1)}
              </span>
              <span className="truncate font-medium">{platformName}</span>
            </div>
          )}
          <CardTitle>{mode === 'login' ? '登录本地客户端' : '注册新账号'}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoComplete="off" spellCheck={false} />
          <Input type="password" placeholder={mode === 'login' ? '密码' : '密码（≥8 位）'} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoComplete="off" />
          <div className={cn('grid transition-all duration-300 ease-out', mode === 'register' ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
            <div className="flex flex-col gap-3 overflow-hidden">
              <Input placeholder="昵称（可选）" value={name} onChange={(e) => setName(e.target.value)} />
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <Checkbox checked={wantsTeamAdmin} onCheckedChange={(v) => setWantsTeamAdmin(v === true)} />
                我是团队管理员，需要提交审批申请
              </label>
              {wantsTeamAdmin && (
                <div className="flex flex-col gap-3">
                  <Input placeholder="团队名称" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
                  <Textarea placeholder="申请说明（可选）" value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              )}
            </div>
          </div>
          <LoadingButton className="w-full" loading={loading} onClick={submit}>{mode === 'login' ? '登录' : '注册'}</LoadingButton>
          <div className="flex items-center justify-between">
            {mode === 'login' ? (
              <>
                <Button variant="link" className="h-auto p-0 text-sm" onClick={() => { setForgotEmail(email); setForgotOpen(true); }}>忘记密码？</Button>
                <p className="text-center text-sm text-muted-foreground">
                  <span>还没有账号？</span><Button variant="link" className="h-auto p-0" onClick={() => setMode('register')}>注册新账号</Button>
                </p>
              </>
            ) : (
              <p className="w-full text-center text-sm text-muted-foreground">
                <span>已有账号？</span><Button variant="link" className="h-auto p-0" onClick={() => setMode('login')}>去登录</Button>
              </p>
            )}
          </div>
          <div className="mt-2 border-t pt-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ServerIcon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">公司平台地址</span>
                  <span className="block truncate text-muted-foreground">{backendUrl || '未设置，登录和注册前需要先保存平台地址'}</span>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowBackendSettings((value) => !value)}
              >
                {showBackendSettings ? '收起' : backendUrl ? '修改' : '设置'}
              </Button>
            </div>
            <div className={cn('grid transition-all duration-300 ease-out', showBackendSettings ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
              <div className="flex flex-col gap-3 overflow-hidden">
                <Input
                  placeholder="例如 http://127.0.0.1:3000 或 https://api.example.com"
                  value={backendUrlDraft}
                  onChange={(e) => setBackendUrlDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveBackend()}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <LoadingButton loading={testingBackend} onClick={saveBackend}>测试并保存</LoadingButton>
                  <Button variant="outline" onClick={() => setBackendUrlDraft('http://127.0.0.1:3000')}>填入本机默认地址</Button>
                </div>
                <p className="text-xs text-muted-foreground">保存前会检测公司平台地址是否可用。</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 忘记密码对话框 */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent>
          <DialogHeader {...dragRegionProps}>
            <DialogTitle data-tauri-drag-region>找回密码</DialogTitle>
            <DialogDescription>输入注册邮箱，我们会发送密码重置链接到你的邮箱。</DialogDescription>
          </DialogHeader>
          <Input
            placeholder="注册邮箱"
            value={forgotEmail}
            onChange={(e) => setForgotEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onForgotPassword()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setForgotOpen(false)}>取消</Button>
            <LoadingButton loading={forgotLoading} onClick={onForgotPassword}>发送重置链接</LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重置密码对话框（从邮件链接的 reset_token 触发） */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader {...dragRegionProps}>
            <DialogTitle data-tauri-drag-region>设置新密码</DialogTitle>
            <DialogDescription>请输入你的新密码（至少 8 位）。重置后需使用新密码重新登录。</DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            placeholder="新密码（≥8 位）"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onResetPassword()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>取消</Button>
            <LoadingButton loading={resetLoading} onClick={onResetPassword}>重置密码</LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

