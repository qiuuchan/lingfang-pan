import { useState } from 'react';
import { toast } from 'sonner';
import { ShieldAlertIcon, TicketIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api } from '@/lib/api';
import type { CollabSessionResponse } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LoadingButton } from '@/components/loading-button';
import { Button } from '@/components/ui/button';

export function Onboarding() {
  const { session, applyCollabSession, refreshSession, resetSession } = useApp();
  const [code, setCode] = useState('');
  const [teamName, setTeamName] = useState(session.application?.teamName || '');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  async function redeem() {
    if (!code.trim()) return toast.error('请输入团队邀请码');
    setLoading(true);
    try {
      const r = await api<CollabSessionResponse>('/api/invitations/redeem', { method: 'POST', body: { code: code.trim() } });
      applyCollabSession(r);
      toast.success('已加入团队');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function submitApplication() {
    if (!teamName.trim()) return toast.error('请填写团队名称');
    setLoading(true);
    try {
      await api('/api/team-admin-applications', { method: 'POST', body: { teamName: teamName.trim(), reason: reason.trim() } });
      await refreshSession();
      toast.success('申请已提交');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (session.onboarding === 'PLATFORM_ADMIN_WEB_ONLY') {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 inline-flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"><ShieldAlertIcon className="size-5" /></div>
          <CardTitle>平台管理员请使用网页管理端</CardTitle>
          <CardDescription>本地客户端只面向普通用户和团队管理员。平台管理功能请在浏览器中打开管理端。</CardDescription>
        </CardHeader>
        <CardContent><Button variant="outline" onClick={resetSession}>退出登录</Button></CardContent>
      </Card>
    );
  }

  if (session.onboarding === 'PENDING_APPROVAL') {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader><CardTitle>团队管理员申请待审批</CardTitle><CardDescription>平台管理员审批通过后，你会获得团队管理员权限。</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <p className="rounded-md border bg-muted/50 p-3 text-sm">申请团队：{session.application?.teamName || '—'}</p>
          <div className="flex gap-2"><LoadingButton loading={loading} onClick={refreshSession}>刷新状态</LoadingButton><Button variant="outline" onClick={resetSession}>退出登录</Button></div>
        </CardContent>
      </Card>
    );
  }

  if (session.onboarding === 'APPLICATION_REJECTED') {
    // 修复 DESK-ONBOARD-01：CardDescription 此前文案承诺「或使用邀请码作为普通成员加入团队」，
    // 但分支只渲染「重新提交管理员申请」表单，无任何邀请码输入框。两者承诺与能力不符 → 形成死路。
    // 此处补上邀请码入口（与 NEEDS_INVITATION 分支共用 code state + redeem 函数，零新增后端依赖）。
    return (
      <Card className="w-full max-w-lg">
        <CardHeader><CardTitle>申请已驳回</CardTitle><CardDescription>{session.application?.reviewReason || '你可以重新提交申请，或使用邀请码作为普通成员加入团队。'}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {/* 重新提交团队管理员申请 */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">重新提交团队管理员申请</p>
            <Input placeholder="团队名称" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
            <Textarea placeholder="重新申请说明" value={reason} onChange={(e) => setReason(e.target.value)} />
            <LoadingButton loading={loading} onClick={submitApplication}>重新提交团队管理员申请</LoadingButton>
          </div>
          <div className="border-t pt-4 space-y-3">
            <p className="text-xs font-medium text-muted-foreground">或使用邀请码作为普通成员加入团队</p>
            <Input placeholder="团队邀请码，例如 LF-XXXXXXX" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && redeem()} />
            <LoadingButton variant="outline" loading={loading} onClick={redeem}>加入团队</LoadingButton>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <div className="mb-2 inline-flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"><TicketIcon className="size-5" /></div>
        <CardTitle>加入团队</CardTitle>
        <CardDescription>注册后必须输入有效团队邀请码，才能进入团队空间。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input placeholder="团队邀请码，例如 LF-XXXXXXX" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && redeem()} />
        <div className="flex gap-2"><LoadingButton loading={loading} onClick={redeem}>加入团队</LoadingButton><Button variant="outline" onClick={resetSession}>退出登录</Button></div>
      </CardContent>
    </Card>
  );
}