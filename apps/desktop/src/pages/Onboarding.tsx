import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ShieldAlertIcon, TicketIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api } from '@/lib/api';
import { INVITATION_CODE_PLACEHOLDER, validateInvitationCodeInput } from '@/lib/invitations';
import type { CollabSessionResponse, PublicTeam } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldGroup } from '@/components/ui/field';
import { LoadingButton } from '@/components/loading-button';
import { Button } from '@/components/ui/button';

export function Onboarding() {
  const { session, applyCollabSession, refreshSession, resetSession } = useApp();
  const [code, setCode] = useState('');
  const [teamName, setTeamName] = useState(session.application?.teamName || '');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  // 公开团队发现（Top1「注册即孤儿」解法）：列出 allowPublicJoin=true 的团队，用户可一键直接加入。
  const [publicTeams, setPublicTeams] = useState<PublicTeam[]>([]);
  const [joiningTeamId, setJoiningTeamId] = useState<string | null>(null);

  async function loadPublicTeams() {
    try {
      // 公开端点无需鉴权，但需配置 backendUrl（api() 会校验）。
      const r = await api<{ teams: PublicTeam[] }>('/api/teams/public', {
        method: 'GET',
        auth: false,
      });
      setPublicTeams(r.teams || []);
    } catch {
      // 静默失败：发现页是辅助入口，加载失败不影响邀请码主流程。
    }
  }

  useEffect(() => {
    void loadPublicTeams();
  }, []);

  async function joinPublicTeam(teamId: string) {
    setJoiningTeamId(teamId);
    setLoading(true);
    try {
      const r = await api<CollabSessionResponse>(`/api/teams/${teamId}/join`, { method: 'POST' });
      applyCollabSession(r);
      toast.success('已加入团队');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
      setJoiningTeamId(null);
    }
  }

  async function redeem() {
    const validationError = validateInvitationCodeInput(code);
    if (validationError) return toast.error(validationError);
    setLoading(true);
    try {
      const r = await api<CollabSessionResponse>('/api/invitations/redeem', {
        method: 'POST',
        body: { code: code.trim() },
      });
      applyCollabSession(r);
      toast.success('已加入团队');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function submitApplication() {
    if (!teamName.trim()) return toast.error('填写团队名称');
    setLoading(true);
    try {
      await api('/api/team-admin-applications', {
        method: 'POST',
        body: { teamName: teamName.trim(), reason: reason.trim() },
      });
      await refreshSession();
      toast.success('申请已提交');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // 公开团队发现卡片（重复渲染段，统一抽出避免分支重复）：邀请码输入下方展示。
  const discoveryCard = (
    <div className="flex flex-col gap-3 border-t pt-4">
      <p className="text-xs font-medium text-muted-foreground">或直接加入一个公开团队</p>
      {publicTeams.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          当前没有可加入的公开团队，可向团队管理员索要邀请码。
        </p>
      ) : (
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {publicTeams.map((t) => (
            <div
              key={t.id}
              className="flex items-start justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.name}</p>
                {t.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {t.description}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">{t.memberCount} 位成员</p>
              </div>
              <LoadingButton
                size="sm"
                variant="outline"
                loading={loading && joiningTeamId === t.id}
                disabled={loading && joiningTeamId !== t.id}
                onClick={() => joinPublicTeam(t.id)}
              >
                加入
              </LoadingButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (session.onboarding === 'PLATFORM_ADMIN_WEB_ONLY') {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 inline-flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldAlertIcon className="size-5" />
          </div>
          <CardTitle>平台管理员请使用网页管理端</CardTitle>
          <CardDescription>
            本地客户端只面向普通用户和团队管理员。平台管理功能请在浏览器中打开管理端。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={resetSession}>
            退出登录
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (session.onboarding === 'PENDING_APPROVAL') {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>团队管理员申请待审批</CardTitle>
          <CardDescription>平台管理员审批通过后，你会获得团队管理员权限。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="rounded-md border bg-muted/50 p-3 text-sm">
            申请团队：{session.application?.teamName || '—'}
          </p>
          <div className="flex gap-2">
            <LoadingButton loading={loading} onClick={refreshSession}>
              刷新状态
            </LoadingButton>
            <Button variant="outline" onClick={resetSession}>
              退出登录
            </Button>
          </div>
          {discoveryCard}
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
        <CardHeader>
          <CardTitle>申请未通过</CardTitle>
          <CardDescription>
            {session.application?.reviewReason ||
              '你可以重新提交申请，或使用邀请码作为普通成员加入团队。'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 重新提交团队管理员申请 */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium text-muted-foreground">重新提交团队管理员申请</p>
            <FieldGroup className="gap-3">
              <Field>
                <Input
                  placeholder="团队名称"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                />
              </Field>
              <Field>
                <Textarea
                  placeholder="重新申请说明"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </FieldGroup>
            <LoadingButton className="self-start" loading={loading} onClick={submitApplication}>
              重新提交团队管理员申请
            </LoadingButton>
          </div>
          <div className="flex flex-col gap-3 border-t pt-4">
            <p className="text-xs font-medium text-muted-foreground">
              或使用邀请码作为普通成员加入团队
            </p>
            <Field>
              <Input
                placeholder={INVITATION_CODE_PLACEHOLDER}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && redeem()}
              />
            </Field>
            <LoadingButton
              variant="outline"
              className="self-start"
              loading={loading}
              onClick={redeem}
            >
              加入团队
            </LoadingButton>
          </div>
          {discoveryCard}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <div className="mb-2 inline-flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <TicketIcon className="size-5" />
        </div>
        <CardTitle>加入团队</CardTitle>
        <CardDescription>注册后可通过邀请码加入，或直接加入下方公开团队。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field>
          <Input
            placeholder={INVITATION_CODE_PLACEHOLDER}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && redeem()}
          />
        </Field>
        <div className="flex gap-2">
          <LoadingButton loading={loading} onClick={redeem}>
            加入团队
          </LoadingButton>
          <Button variant="outline" onClick={resetSession}>
            退出登录
          </Button>
        </div>
        {discoveryCard}
      </CardContent>
    </Card>
  );
}
