import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LogOutIcon, UserRoundIcon } from 'lucide-react';
import { api, isEmail, type ApiError } from '@/lib/api';
import type { Session } from '@/lib/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { dragRegionProps } from '@/lib/window-drag';

// R6 用户设置居中弹窗：侧边栏底部账户信息点击 → 居中悬浮 Dialog（复用 ui/dialog）。
// 支持：修改用户名 / 修改邮箱 / 重置密码 / 退出登录。
//
// session/applySession/resetSession 由父组件（Sidebar，在 AppProvider 内）通过 props 注入，
// 避免本组件因渲染位置（portal/重建）拿不到 AppContext 导致「useApp 必须在 AppProvider 内使用」崩溃。
//
// 后端支持现状（apps/collab-api/src/modules/auth.controller.ts）：
// 仅有 GET /api/auth/me，尚无 PATCH /profile 或修改密码/邮箱的接口。
// 故本轮：用户名/邮箱/密码三项对接 PATCH /api/auth/me（约定 body 字段），
// 后端未实现时返回 404/405 → toast 报错并标注「待后端支持」；
// 退出登录走既有 resetSession（纯前端清 token，已可用）。

const ROLE_LABEL: Record<string, string> = {
  TEAM_ADMIN: '团队管理员',
  MEMBER: '成员',
};

export function AccountDialog({ open, onOpenChange, session, applySession, resetSession }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  applySession: (patch: Partial<Session>) => void;
  resetSession: () => void;
}) {
  const [displayName, setDisplayName] = useState(session.displayName || '');
  const [email, setEmail] = useState(session.email || '');
  const [password, setPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const roleLabel = session.role ? (ROLE_LABEL[session.role] || session.role) : '已登录';

  // 打开时同步当前 session 字段（避免上一次未保存的脏值残留）。
  useEffect(() => {
    if (open) {
      setDisplayName(session.displayName || '');
      setEmail(session.email || '');
      setPassword('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 修改用户名 + 邮箱：约定 PATCH /api/auth/me，后端返回更新后的 me 负载。
  // 后端未实现时报错，前端不抛 fatal，仅 toast 提示「待后端支持」。
  async function saveProfile() {
    const nextName = displayName.trim();
    const nextEmail = email.trim().toLowerCase();
    if (!nextName) {
      toast.error('昵称不能为空');
      return;
    }
    if (!isEmail(nextEmail)) {
      toast.error('邮箱格式不正确');
      return;
    }
    setSavingProfile(true);
    try {
      // 约定 body：后端补齐 PATCH /api/auth/me 时按 displayName/email 更新用户表。
      const result = await api<{ user?: { displayName?: string; email?: string } }>('/api/auth/me', {
        method: 'PATCH',
        body: { displayName: nextName, email: nextEmail },
      });
      // 乐观更新本地 session（后端若返回新值则优先用返回值）。
      applySession({
        displayName: result.user?.displayName ?? nextName,
        email: result.user?.email ?? nextEmail,
      });
      toast.success('账户信息已更新');
      onOpenChange(false);
    } catch (error) {
      // 修复 ACCT-01 / DESK-06：此前用 message.includes('404')||message.includes('405') 判定后端未实现，
      // 但 api() 抛的 Error.message 取 data.message||data.error||res.statusText（不含状态码数字），
      // 后端 NestJS 路由未注册时返回 {code:'http_error', message:'Cannot PATCH /api/auth/me'}，
      // includes 恒 false → 友好降级永不触发，裸英文错误直接泄露给用户。
      // 改为基于 err.status（api() 已透传）精确判定 404/405。
      const err = error as ApiError;
      const backendNotImplemented = err.status === 404 || err.status === 405;
      toast.error(backendNotImplemented ? '暂不支持修改账户信息' : err.message);
    } finally {
      setSavingProfile(false);
    }
  }

  // 重置密码：约定 PATCH /api/auth/me，body 带 password。
  // 后端未实现时报错标注待支持。前端要求新密码 ≥ 8 位（与注册一致）。
  async function savePassword() {
    if (password.length < 8) {
      toast.error('新密码至少 8 位');
      return;
    }
    setSavingPassword(true);
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { password } });
      toast.success('密码已重置');
      setPassword('');
      onOpenChange(false);
    } catch (error) {
      // 修复 ACCT-01 / DESK-06：与 saveProfile 同款，基于 err.status 精确判定后端未实现。
      const err = error as ApiError;
      const backendNotImplemented = err.status === 404 || err.status === 405;
      toast.error(backendNotImplemented ? '暂不支持修改密码' : err.message);
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader {...dragRegionProps}>
          <DialogTitle className="flex items-center gap-2" data-tauri-drag-region><UserRoundIcon className="size-4" />账户设置</DialogTitle>
          <DialogDescription>修改昵称、邮箱、密码或退出登录。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {/* 账户信息概览（只读） */}
          <div className="rounded-lg border bg-muted/40 p-3 text-xs">
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">团队</span><span className="break-all text-right font-mono">{session.tenantName || '未加入'}</span></div>
            <div className="mt-1 flex justify-between gap-3"><span className="text-muted-foreground">角色</span><span className="text-right font-mono">{roleLabel}</span></div>
            <div className="mt-1 flex justify-between gap-3"><span className="text-muted-foreground">用户 ID</span><span className="break-all text-right font-mono">{session.userId || '—'}</span></div>
          </div>

          {/* 修改昵称 + 邮箱 */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-name">昵称</Label>
            <Input id="account-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="显示名称" />
            <Label htmlFor="account-email">邮箱</Label>
            <Input id="account-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            <Button onClick={() => { void saveProfile(); }} disabled={savingProfile}>
              {savingProfile ? '保存中…' : '保存账户信息'}
            </Button>
          </div>

          {/* 重置密码 */}
          <div className="flex flex-col gap-2 border-t pt-3">
            <Label htmlFor="account-password">重置密码</Label>
            <Input id="account-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="新密码（至少 8 位）" />
            <Button variant="outline" onClick={() => { void savePassword(); }} disabled={savingPassword}>
              {savingPassword ? '重置中…' : '重置密码'}
            </Button>
          </div>

          {/* 退出登录 */}
          <div className="flex flex-col gap-2 border-t pt-3">
            <Button variant="ghost" className="w-full justify-center text-destructive hover:text-destructive" onClick={() => { resetSession(); onOpenChange(false); }}>
              <LogOutIcon className="size-4" />退出登录
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
