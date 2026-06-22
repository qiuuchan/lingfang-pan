// 邀请码与团队设置 tab：从原 TeamManage.tsx 迁移邀请码生成/禁用 + 团队资料（公开加入开关/简介）。
// 后端：POST/GET/PATCH /api/teams/current/invitations、PATCH /api/teams/current/profile。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useTeamResource, runAction } from './shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import type { InvitationCode } from '@/lib/types';
import { formatTime } from '@/lib/types';

export function InvitationsTab() {
  const [invitations, reloadInvites, loadingInvites] = useTeamResource<{ invitations: InvitationCode[] }>(
    '/api/teams/current/invitations',
    (r) => r as { invitations: InvitationCode[] },
    { invitations: [] },
  );
  const [maxUses, setMaxUses] = useState('5');
  const [expiresAt, setExpiresAt] = useState('');
  const [newCode, setNewCode] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [generating, setGenerating] = useState(false);

  async function createInvitation() {
    setGenerating(true);
    try {
      // 日期输入框值为 YYYY-MM-DD；转为该日 UTC 0 点的 ISO 字符串发给后端。
      // 后端 team.service.ts:createInvitation 已校验合法未来日期，留空则不传（永不过期）。
      const body: { maxUses: number; expiresAt?: string } = { maxUses: Number(maxUses) || 1 };
      if (expiresAt) body.expiresAt = new Date(`${expiresAt}T00:00:00Z`).toISOString();
      const result = await api<{ invitation: InvitationCode & { code?: string } }>('/api/teams/current/invitations', {
        method: 'POST', body,
      });
      setNewCode(result.invitation.code || '');
      setCopiedCode(false);
      await reloadInvites();
      toast.success('邀请码已生成');
    } catch (e) {
      if ((e as { status?: number }).status !== 401) toast.error((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function copyNewCode() {
    if (!newCode) return;
    if (await copyText(newCode)) {
      setCopiedCode(true);
      toast.success('已复制完整邀请码');
      window.setTimeout(() => setCopiedCode(false), 1600);
    } else {
      toast.error('复制失败，请手动选取');
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>生成邀请码</CardTitle>
          <CardDescription>普通用户注册后凭有效邀请码加入团队。完整邀请码只在生成时显示一次。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex max-w-lg flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="invite-max-uses">最大使用次数</Label>
              <Input id="invite-max-uses" className="w-32" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="最大使用次数" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="invite-expires-at">过期时间（可选）</Label>
              <Input id="invite-expires-at" className="w-44" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
            <LoadingButton loading={generating} onClick={createInvitation}>生成</LoadingButton>
          </div>
          {newCode && (
            <div className="flex max-w-xl items-center gap-2 rounded-md border bg-muted/50 p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{newCode}</code>
              <Button type="button" variant="outline" size="sm" onClick={copyNewCode} aria-label="复制完整邀请码">
                {copiedCode ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">下方历史列表仅展示前缀，不能用于加入团队。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>邀请码历史</CardTitle>
          <LoadingButton variant="outline" loading={loadingInvites} onClick={reloadInvites}>刷新</LoadingButton>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>前缀（非完整邀请码）</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>使用次数</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.invitations.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-mono">{i.displayCodePrefix}</TableCell>
                  <TableCell>
                    <Badge variant={i.status === 'ACTIVE' ? 'default' : 'secondary'}>
                      {i.status === 'ACTIVE' ? '正常' : '已禁用'}
                    </Badge>
                  </TableCell>
                  <TableCell>{i.usedCount}/{i.maxUses}</TableCell>
                  <TableCell className="text-muted-foreground">{formatTime(i.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {i.status === 'ACTIVE' && (
                      <Button variant="outline" size="sm" onClick={async () => {
                        const ok = await runAction(
                          () => api(`/api/teams/current/invitations/${i.id}/disable`, { method: 'PATCH' }),
                          '邀请码已禁用',
                        );
                        if (ok) await reloadInvites();
                      }}>禁用</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {invitations.invitations.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无邀请码</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <TeamProfileSection />
    </div>
  );
}

/** 团队资料设置（公开加入开关 + 简介）。 */
function TeamProfileSection() {
  const [allowPublicJoin, setAllowPublicJoin] = useState<boolean | null>(null);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function loadProfile() {
    try {
      const r = await api<{ team: { allowPublicJoin: boolean; description: string } }>('/api/teams/current');
      setAllowPublicJoin(r.team.allowPublicJoin);
      setDescription(r.team.description || '');
    } catch (e) {
      if ((e as { status?: number }).status !== 401) toast.error((e as Error).message);
    }
  }

  // 首次加载团队资料（所有 hooks 在条件 return 之前调用，见 spec app-shell-and-state.md Hook 规则）
  useEffect(() => { void loadProfile(); }, []);

  async function save() {
    setSaving(true);
    const body: Record<string, unknown> = {};
    if (allowPublicJoin !== null) body.allowPublicJoin = allowPublicJoin;
    body.description = description;
    const ok = await runAction(
      () => api('/api/teams/current/profile', { method: 'PATCH', body }),
      '团队资料已更新',
    );
    setSaving(false);
    if (!ok) { /* toast 已由 runAction 处理 */ }
  }

  return (
    <Card>
      <CardHeader><CardTitle>团队资料</CardTitle><CardDescription>设置团队简介与是否允许公开加入。</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="allow-public"
            checked={allowPublicJoin ?? false}
            disabled={allowPublicJoin === null}
            onCheckedChange={(v) => setAllowPublicJoin(Boolean(v))}
          />
          <Label htmlFor="allow-public">开放公开加入（出现在「发现公开团队」列表，用户可一键加入）</Label>
        </div>
        <div className="space-y-1">
          <Label>团队简介</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} placeholder="公开团队发现页展示，帮助用户判断是否加入" />
        </div>
        <LoadingButton loading={saving} onClick={save} disabled={allowPublicJoin === null}>保存资料</LoadingButton>
      </CardContent>
    </Card>
  );
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return fallbackCopy(text);
  } catch {
    return fallbackCopy(text);
  }
}

function fallbackCopy(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}
