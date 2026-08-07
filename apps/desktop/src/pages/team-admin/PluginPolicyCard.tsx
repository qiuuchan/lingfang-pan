import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  TeamPluginPolicyDocumentV1,
  type TeamPluginPolicyDocumentV1 as PolicyDocument,
} from '@lingfang/contract';
import { errorMessage } from '@/lib/api';
import {
  DEFAULT_PLUGIN_POLICY,
  getPluginPolicy,
  getPluginPolicyHistory,
  publishPluginPolicy,
  rollbackPluginPolicy,
  type TeamPluginPolicyRevision,
} from '@/lib/plugin-governance';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { LoadingButton } from '@/components/loading-button';

export function PluginPolicyCard() {
  const [active, setActive] = useState<TeamPluginPolicyRevision | null>(null);
  const [history, setHistory] = useState<TeamPluginPolicyRevision[]>([]);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [scope, setScope] = useState<'TEAM' | 'PACKAGE' | 'ACTION' | 'WORKFLOW'>('PACKAGE');
  const [effect, setEffect] = useState<'ALLOW' | 'DENY'>('ALLOW');
  const [operation, setOperation] = useState('install');
  const [packageId, setPackageId] = useState('');
  const [actionId, setActionId] = useState('');
  const [contractVersion, setContractVersion] = useState('1.0.0');
  const [surface, setSurface] = useState('');
  const [workflowReleaseId, setWorkflowReleaseId] = useState('');
  const [planSha, setPlanSha] = useState('');

  async function reload(preserveDraft = false) {
    setLoading(true);
    try {
      const [current, revisions] = await Promise.all([getPluginPolicy(), getPluginPolicyHistory()]);
      setActive(current);
      setHistory(revisions.revisions);
      if (!preserveDraft) {
        setDraft(JSON.stringify(current.document ?? DEFAULT_PLUGIN_POLICY, null, 2));
        setDirty(false);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  const parsed = (() => {
    try {
      return TeamPluginPolicyDocumentV1.safeParse(JSON.parse(draft));
    } catch {
      return null;
    }
  })();
  const document = parsed?.success ? parsed.data : null;
  function updateDocument(next: PolicyDocument) {
    setDraft(JSON.stringify(next, null, 2));
    setDirty(true);
  }
  function addRule() {
    if (!document) return;
    const target =
      scope === 'TEAM'
        ? { kind: 'TEAM' as const }
        : scope === 'PACKAGE'
          ? {
              kind: 'PACKAGE' as const,
              package_id: packageId,
              ...(surface ? { approved_surface_sha256: surface } : {}),
            }
          : scope === 'ACTION'
            ? {
                kind: 'ACTION' as const,
                package_id: packageId,
                action_id: actionId,
                action_contract_version: contractVersion,
                action_surface_sha256: surface,
              }
            : {
                kind: 'WORKFLOW' as const,
                workflow_release_id: workflowReleaseId,
                workflow_plan_sha256: planSha,
              };
    const next = TeamPluginPolicyDocumentV1.safeParse({
      ...document,
      rules: [
        ...document.rules,
        { rule_id: `rule-${crypto.randomUUID()}`, effect, operations: [operation], target },
      ],
    });
    if (!next.success) return toast.error(next.error.issues[0]?.message || '规则信息不完整');
    updateDocument(next.data);
  }
  async function publish() {
    if (!active || !parsed?.success) return;
    setSaving(true);
    try {
      const next = await publishPluginPolicy(active.revision, parsed.data, reason);
      toast.success(`策略修订 #${next.revision} 已发布`);
      setReason('');
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
      await reload(true);
    } finally {
      setSaving(false);
    }
  }
  async function rollback(source: TeamPluginPolicyRevision) {
    if (!active) return;
    setSaving(true);
    try {
      await rollbackPluginPolicy(
        active.revision,
        source.revision,
        `回滚到修订 #${source.revision}`
      );
      toast.success('策略已回滚为新的修订');
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
      await reload(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>团队插件治理</CardTitle>
          <p className="text-sm text-muted-foreground">
            统一控制插件来源、能力以及 Action、工作流和 Cloud 等高风险操作。
          </p>
        </div>
        <LoadingButton variant="outline" loading={loading} onClick={() => reload(!dirty)}>
          刷新
        </LoadingButton>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Badge>修订 #{active?.revision ?? 0}</Badge>
          {!active?.document && <Badge variant="secondary">虚拟兼容默认</Badge>}
          <Badge variant="outline">本地安装/更新/运行默认允许</Badge>
          <Badge variant="destructive">高风险操作默认拒绝</Badge>
        </div>
        <div className="space-y-3 rounded-lg border p-3">
          <div>
            <div className="font-medium">添加常用规则</div>
            <p className="text-sm text-muted-foreground">
              选择作用范围、允许或拒绝的操作。高风险操作没有明确允许规则时仍会拒绝。
            </p>
          </div>
          <FieldGroup className="grid gap-2 md:grid-cols-3">
            <Field className="gap-0 text-sm">
              <FieldLabel htmlFor="policy-rule-scope">范围</FieldLabel>
              <select
                id="policy-rule-scope"
                className="mt-1 w-full rounded-md border bg-background p-2"
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
              >
                <option value="TEAM">整个团队</option>
                <option value="PACKAGE">插件包</option>
                <option value="ACTION">Action</option>
                <option value="WORKFLOW">工作流</option>
              </select>
            </Field>
            <Field className="gap-0 text-sm">
              <FieldLabel htmlFor="policy-rule-effect">效果</FieldLabel>
              <select
                id="policy-rule-effect"
                className="mt-1 w-full rounded-md border bg-background p-2"
                value={effect}
                onChange={(e) => setEffect(e.target.value as typeof effect)}
              >
                <option value="ALLOW">允许</option>
                <option value="DENY">拒绝</option>
              </select>
            </Field>
            <Field className="gap-0 text-sm">
              <FieldLabel htmlFor="policy-rule-operation">操作</FieldLabel>
              <select
                id="policy-rule-operation"
                className="mt-1 w-full rounded-md border bg-background p-2"
                value={operation}
                onChange={(e) => setOperation(e.target.value)}
              >
                {[
                  'install',
                  'update',
                  'run_local',
                  'invoke_action',
                  'run_workflow',
                  'execute_cloud',
                  'manage_schedule',
                  'trigger_schedule',
                  'shared_data_read',
                  'shared_data_write',
                  'web_preview',
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
          </FieldGroup>
          {scope === 'PACKAGE' && (
            <FieldGroup className="grid gap-2 md:grid-cols-2">
              <Field>
                <Input
                  placeholder="Package ID"
                  value={packageId}
                  onChange={(e) => setPackageId(e.target.value)}
                />
              </Field>
              <Field>
                <Input
                  placeholder="批准的 surface SHA（高风险推荐）"
                  value={surface}
                  onChange={(e) => setSurface(e.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          {scope === 'ACTION' && (
            <FieldGroup className="grid gap-2 md:grid-cols-2">
              <Field>
                <Input
                  placeholder="Package ID"
                  value={packageId}
                  onChange={(e) => setPackageId(e.target.value)}
                />
              </Field>
              <Field>
                <Input
                  placeholder="Action ID"
                  value={actionId}
                  onChange={(e) => setActionId(e.target.value)}
                />
              </Field>
              <Field>
                <Input
                  placeholder="Contract version"
                  value={contractVersion}
                  onChange={(e) => setContractVersion(e.target.value)}
                />
              </Field>
              <Field>
                <Input
                  placeholder="Action surface SHA"
                  value={surface}
                  onChange={(e) => setSurface(e.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          {scope === 'WORKFLOW' && (
            <FieldGroup className="grid gap-2 md:grid-cols-2">
              <Field>
                <Input
                  placeholder="Workflow release ID"
                  value={workflowReleaseId}
                  onChange={(e) => setWorkflowReleaseId(e.target.value)}
                />
              </Field>
              <Field>
                <Input
                  placeholder="Workflow plan SHA"
                  value={planSha}
                  onChange={(e) => setPlanSha(e.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          <Button type="button" variant="outline" onClick={addRule}>
            添加规则
          </Button>
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">当前规则与预检影响</div>
          {document?.rules.length ? (
            document.rules.map((rule, index) => (
              <div
                key={rule.rule_id}
                className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
              >
                <div>
                  <Badge variant={rule.effect === 'ALLOW' ? 'secondary' : 'destructive'}>
                    {rule.effect === 'ALLOW' ? '允许' : '拒绝'}
                  </Badge>
                  <span className="ml-2">
                    {rule.target.kind} · {rule.operations.join('、')}
                  </span>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {rule.effect === 'DENY'
                      ? '匹配时预检和运行都会拒绝。'
                      : rule.operations.some((op) =>
                            [
                              'invoke_action',
                              'run_workflow',
                              'execute_cloud',
                              'manage_schedule',
                              'trigger_schedule',
                              'shared_data_read',
                              'shared_data_write',
                            ].includes(op)
                          )
                        ? '仅精确 selector 与 surface/plan 未变化时允许高风险操作。'
                        : '匹配时允许安装、更新或本地运行。'}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    updateDocument({
                      ...document,
                      rules: document.rules.filter((_, i) => i !== index),
                    })
                  }
                >
                  删除
                </Button>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              尚无显式规则：安装、更新、本地运行默认允许；Action、工作流、Cloud 与共享写入默认拒绝。
            </p>
          )}
        </div>
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">高级 JSON</summary>
          <Field className="mt-3">
            <Textarea
              className="min-h-72 font-mono text-xs"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setDirty(true);
              }}
            />
            {parsed && !parsed.success && (
              <FieldError>{parsed.error.issues[0]?.message}</FieldError>
            )}
            {!parsed && <FieldError>JSON 格式无效</FieldError>}
          </Field>
        </details>
        <Field>
          <Input
            placeholder="变更原因（可选）"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <LoadingButton loading={saving} disabled={!parsed?.success || !dirty} onClick={publish}>
          保存并应用
        </LoadingButton>
        <div className="space-y-2">
          <div className="text-sm font-medium">历史修订</div>
          {history.map((revision) => (
            <div
              key={revision.id ?? revision.revision}
              className="flex items-center justify-between rounded-md border p-2 text-sm"
            >
              <div>
                <span className="font-medium">#{revision.revision}</span>
                <span className="ml-2 text-muted-foreground">
                  {revision.changeReason || '无变更说明'}
                </span>
              </div>
              {revision.revision !== active?.revision && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => rollback(revision)}
                >
                  回滚到此版本
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
