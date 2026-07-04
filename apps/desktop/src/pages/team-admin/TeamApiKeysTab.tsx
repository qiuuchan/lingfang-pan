// AI 接入密钥 tab：团队管理员轮换/吊销团队共享 Platform API Key。
// 插件与 Agent 不读取此 Key；它只用于外部兼容 /api/relay/v1 的接入场景。
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckIcon, CopyIcon, KeyRoundIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { formatTime, type PlatformApiKeyCreated, type PlatformApiKeyPublic } from '@/lib/types';
import { useTeamResource, runAction } from './shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingButton } from '@/components/loading-button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function scopeLabel(scope: string): string {
  if (scope === '*') return '全部能力';
  if (scope === 'chat') return '对话';
  if (scope === 'image') return '生图';
  if (scope === 'action') return '动作';
  if (scope === 'tier:fast') return '快速';
  if (scope === 'tier:premium') return '高级';
  return scope;
}

export function TeamApiKeysTab() {
  const [state, reload, loading] = useTeamResource<{ apiKeys: PlatformApiKeyPublic[] }>(
    '/api/teams/current/api-keys',
    (raw) => raw as { apiKeys: PlatformApiKeyPublic[] },
    { apiKeys: [] },
  );
  const [rotating, setRotating] = useState(false);
  const [created, setCreated] = useState<PlatformApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const activeKey = state.apiKeys.find((key) => key.status === 'ACTIVE') ?? null;

  async function rotateKey() {
    const message = activeKey
      ? `轮换后当前 Key「${activeKey.keyPrefix}…」会立即失效，确认继续？`
      : '生成新的团队共享 API Key？';
    if (!window.confirm(message)) return;
    setRotating(true);
    try {
      const result = await api<PlatformApiKeyCreated>('/api/teams/current/api-keys', {
        method: 'POST',
        body: { name: '团队共享 Key', scopes: ['*'] },
      });
      setCreated(result);
      setCopied(false);
      await reload();
      toast.success('团队共享 API Key 已轮换');
    } catch (error) {
      if ((error as { status?: number }).status !== 401) toast.error((error as Error).message);
    } finally {
      setRotating(false);
    }
  }

  async function revokeKey(key: PlatformApiKeyPublic) {
    if (!window.confirm(`吊销 API Key「${key.keyPrefix}…」？吊销后立即失效。`)) return;
    setRevokingId(key.id);
    const ok = await runAction(
      () => api(`/api/teams/current/api-keys/${key.id}`, { method: 'DELETE' }),
      'API Key 已吊销',
    );
    setRevokingId(null);
    if (ok) await reload();
  }

  async function copyCreatedKey() {
    if (!created?.plaintextKey) return;
    if (await copyText(created.plaintextKey)) {
      setCopied(true);
      toast.success('已复制 API Key');
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error('复制失败，请手动选取');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div className="flex items-center gap-2">
            <KeyRoundIcon className="size-5 text-primary" />
            <div>
              <CardTitle>AI 接入密钥</CardTitle>
              <CardDescription>团队共享 Key 仅用于外部 relay 接入；插件和 Agent 走平台 SDK 能力。</CardDescription>
            </div>
          </div>
          <div className="flex gap-2">
            <LoadingButton variant="outline" loading={loading} onClick={reload}>刷新</LoadingButton>
            <LoadingButton loading={rotating} onClick={rotateKey}>
              <RefreshCwIcon className="size-4" />
              {activeKey ? '轮换密钥' : '生成密钥'}
            </LoadingButton>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {created ? (
            <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
              <div className="text-sm font-medium">新密钥明文仅显示一次</div>
              <div className="flex gap-2">
                <Input readOnly value={created.plaintextKey} className="font-mono text-xs" />
                <Button type="button" variant="outline" size="icon" onClick={copyCreatedKey} aria-label="复制 API Key">
                  {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">关闭或刷新后无法再次查看明文；历史列表只保留前缀。</p>
            </div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key 前缀</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>能力</TableHead>
                <TableHead>最近使用</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.apiKeys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-mono text-xs">{key.keyPrefix}…</TableCell>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <Badge key={scope} variant="secondary" className="text-xs">{scopeLabel(scope)}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatTime(key.lastUsedAt)}</TableCell>
                  <TableCell>
                    {key.status === 'ACTIVE' ? <Badge variant="default">启用</Badge> : <Badge variant="secondary">已吊销</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    {key.status === 'ACTIVE' ? (
                      <LoadingButton
                        variant="outline"
                        size="sm"
                        loading={revokingId === key.id}
                        onClick={() => { void revokeKey(key); }}
                      >
                        <Trash2Icon className="size-4" />
                        吊销
                      </LoadingButton>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {state.apiKeys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">暂无团队共享 API Key</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
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
