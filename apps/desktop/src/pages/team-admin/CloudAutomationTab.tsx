import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Schedule = {
  id: string;
  workflow_release_id: string;
  status: string;
  generation: number;
  next_run_at: string | null;
  sync_state: string;
  trigger: { kind: string };
};
type Deployment = {
  id: string;
  deployment_key: string;
  endpoint_host: string;
  status: string;
  secret_version: number;
};
type Routing = {
  stable_deployment_id: string;
  candidate_deployment_id: string | null;
  candidate_percent: number;
  generation: number;
};

export function CloudAutomationTab() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [releaseId, setReleaseId] = useState('');
  const [packageId, setPackageId] = useState('');
  const [sha, setSha] = useState('');
  const [actionId, setActionId] = useState('default');
  const [surfaceSha, setSurfaceSha] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [routing, setRouting] = useState<Routing | null>(null);
  const [stableId, setStableId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [candidatePercent, setCandidatePercent] = useState(0);
  const loadSchedules = async () =>
    setSchedules((await api<{ schedules: Schedule[] }>('/api/automation-schedules')).schedules);
  const loadDeployments = async () => {
    const [deploymentResult, routeResult] = await Promise.all([
      api<{ deployments: Deployment[] }>(
        `/api/cloud-actions/${encodeURIComponent(releaseId)}/${encodeURIComponent(actionId)}/deployments`
      ),
      api<{ routing: Routing | null }>(
        `/api/cloud-actions/${encodeURIComponent(releaseId)}/${encodeURIComponent(actionId)}/routing?action_contract_version=1.0.0&action_surface_sha256=${encodeURIComponent(surfaceSha)}&environment=PRODUCTION`
      ),
    ]);
    setDeployments(deploymentResult.deployments);
    setRouting(routeResult.routing);
    setStableId(routeResult.routing?.stable_deployment_id ?? '');
    setCandidateId(routeResult.routing?.candidate_deployment_id ?? '');
    setCandidatePercent(routeResult.routing?.candidate_percent ?? 0);
  };
  useEffect(() => {
    loadSchedules().catch((e) => toast.error((e as Error).message));
  }, []);
  async function act(path: string, body?: unknown) {
    setBusy(true);
    try {
      const result = await api<{ endpoint_secret?: string }>(path, {
        method: 'POST',
        ...(body ? { body } : {}),
      });
      if (result.endpoint_secret) setSecret(result.endpoint_secret);
      await Promise.all([loadSchedules(), releaseId ? loadDeployments() : Promise.resolve()]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function lifecycle(item: Schedule, action: 'pause' | 'resume') {
    setBusy(true);
    try {
      await api(`/api/automation-schedules/${item.id}/${action}`, {
        method: 'PATCH',
        body: { expected_generation: item.generation },
      });
      await loadSchedules();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: Schedule) {
    setBusy(true);
    try {
      await api(`/api/automation-schedules/${item.id}`, {
        method: 'DELETE',
        body: { expected_generation: item.generation },
      });
      await loadSchedules();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function updateRouting(
    nextStable = stableId,
    nextCandidate = candidateId,
    nextPercent = candidatePercent
  ) {
    setBusy(true);
    try {
      const result = await api<{ routing: Routing }>(
        `/api/cloud-actions/${encodeURIComponent(releaseId)}/${encodeURIComponent(actionId)}/routing`,
        {
          method: 'PUT',
          body: {
            action_contract_version: '1.0.0',
            action_surface_sha256: surfaceSha,
            environment: 'PRODUCTION',
            stable_deployment_id: nextStable,
            candidate_deployment_id: nextCandidate || undefined,
            candidate_percent: nextCandidate ? nextPercent : 0,
            expected_generation: routing?.generation ?? 0,
          },
        }
      );
      setRouting(result.routing);
      setStableId(result.routing.stable_deployment_id);
      setCandidateId(result.routing.candidate_deployment_id ?? '');
      setCandidatePercent(result.routing.candidate_percent);
      toast.success('Cloud 路由已切换');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function rollbackRouting() {
    if (!routing) return;
    await updateRouting(routing.stable_deployment_id, '', 0);
  }
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
        Cloud
        定时任务已停止新建和执行。历史配置仅保留查看与迁移参考，请改用桌面端本地定时任务调用插件或工作流。
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Cloud Endpoint</CardTitle>
          <CardDescription>
            绑定精确 Action，并验证或轮换 Endpoint 密钥。密钥只展示一次。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              placeholder="Package ID"
              value={packageId}
              onChange={(e) => setPackageId(e.target.value)}
            />
            <Input
              placeholder="Release ID"
              value={releaseId}
              onChange={(e) => setReleaseId(e.target.value)}
            />
            <Input
              placeholder="Release SHA-256"
              value={sha}
              onChange={(e) => setSha(e.target.value)}
            />
            <Input
              placeholder="Action ID"
              value={actionId}
              onChange={(e) => setActionId(e.target.value)}
            />
            <Input
              placeholder="Action surface SHA-256"
              value={surfaceSha}
              onChange={(e) => setSurfaceSha(e.target.value)}
            />
            <Input
              placeholder="HTTPS Endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                act('/api/cloud-action-deployments', {
                  target: {
                    package_id: packageId,
                    release_id: releaseId,
                    sha256: sha,
                    action_id: actionId,
                    action_contract_version: '1.0.0',
                    action_surface_sha256: surfaceSha,
                    environment: 'PRODUCTION',
                  },
                  deployment_key: 'primary',
                  endpoint_url: endpoint,
                })
              }
            >
              创建
            </Button>
            <Button
              variant="outline"
              disabled={busy || !releaseId}
              onClick={() => loadDeployments().catch((e) => toast.error((e as Error).message))}
            >
              刷新
            </Button>
          </div>
          {secret && (
            <div className="rounded-lg border border-warning/40 p-3 font-mono text-xs break-all">
              <div className="mb-1 font-sans font-medium">一次性 Endpoint 密钥</div>
              {secret}
            </div>
          )}
          <div className="divide-y rounded-lg border">
            {deployments.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 p-3">
                <div>
                  <span className="font-medium">{d.deployment_key}</span>{' '}
                  <Badge variant="secondary">{d.status}</Badge>
                  {routing?.stable_deployment_id === d.id && <Badge className="ml-1">stable</Badge>}
                  {routing?.candidate_deployment_id === d.id && (
                    <Badge className="ml-1" variant="outline">
                      candidate {routing.candidate_percent}%
                    </Badge>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {d.endpoint_host} · v{d.secret_version}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || d.status !== 'DRAFT'}
                    onClick={() => act(`/api/cloud-action-deployments/${d.id}/verify`)}
                  >
                    验证
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || d.status !== 'READY'}
                    onClick={() => act(`/api/cloud-action-deployments/${d.id}/rotate-secret`)}
                  >
                    轮换
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || d.status !== 'READY'}
                    onClick={() => {
                      setStableId(d.id);
                      void updateRouting(d.id, '', 0);
                    }}
                  >
                    设为稳定
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || d.status !== 'READY' || stableId === d.id}
                    onClick={() => setCandidateId(d.id)}
                  >
                    设为候选
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || d.status === 'RETIRED'}
                    onClick={() => act(`/api/cloud-action-deployments/${d.id}/retire`)}
                  >
                    退役
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border p-3">
            <div className="mb-2 text-sm font-medium">
              灰度路由 · generation {routing?.generation ?? 0}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-56 flex-1"
                placeholder="Stable deployment ID"
                value={stableId}
                onChange={(e) => setStableId(e.target.value)}
              />
              <Input
                className="min-w-56 flex-1"
                placeholder="Candidate deployment ID（可空）"
                value={candidateId}
                onChange={(e) => setCandidateId(e.target.value)}
              />
              <Input
                className="w-28"
                type="number"
                min={0}
                max={100}
                value={candidatePercent}
                onChange={(e) =>
                  setCandidatePercent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                }
              />
              <Button
                disabled={busy || !stableId || (candidatePercent > 0 && !candidateId)}
                onClick={() => void updateRouting()}
              >
                CAS 切流
              </Button>
              <Button
                variant="outline"
                disabled={busy || !routing?.candidate_deployment_id}
                onClick={() => void rollbackRouting()}
              >
                回滚到稳定
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>历史 Cloud 定时任务</CardTitle>
          <CardDescription>
            仅保留只读记录。Cloud 定时任务已停用，请在桌面端本地定时任务中创建和管理计划。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y rounded-lg border">
            {schedules.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground">暂无历史计划</div>
            )}
            {schedules.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 p-3">
                <div>
                  <span className="font-medium">{s.trigger.kind}</span>{' '}
                  <Badge variant="secondary">{s.status}</Badge>{' '}
                  <Badge variant="outline">已弃用</Badge>
                  <div className="text-xs text-muted-foreground">
                    {s.workflow_release_id} ·{' '}
                    {s.next_run_at ? new Date(s.next_run_at).toLocaleString() : '无下次执行'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
