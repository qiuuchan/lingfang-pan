import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { LoadingButton } from '@/components/loading-button';
import {
  deleteSharedNamespace,
  exportSharedNamespace,
  listSharedNamespaces,
  migrateSharedNamespaceValue,
  reactivateSharedNamespace,
  type SharedNamespaceAdmin,
} from '@/lib/plugin-shared-state';

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

export function SharedStateTab() {
  const [namespaces, setNamespaces] = useState<SharedNamespaceAdmin[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SharedNamespaceAdmin | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [reactivateTarget, setReactivateTarget] = useState<SharedNamespaceAdmin | null>(null);
  const [reactivateSchema, setReactivateSchema] = useState('1');
  const [reactivateBusy, setReactivateBusy] = useState(false);
  const [migrateTarget, setMigrateTarget] = useState<SharedNamespaceAdmin | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNamespaces((await listSharedNamespaces()).namespaces);
    } catch (error) {
      if ((error as { status?: number }).status !== 401) toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(namespace: SharedNamespaceAdmin) {
    setDownloadingId(namespace.namespace_id);
    try {
      const blob = await exportSharedNamespace(namespace.namespace_id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `plugin-shared-${namespace.namespace_id}-g${namespace.generation}.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('共享命名空间已导出');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setDownloadingId(null);
    }
  }

  async function removeNamespace() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteSharedNamespace(deleteTarget.namespace_id);
      toast.success('命名空间已停用，值正文已清除');
      setDeleteTarget(null);
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }

  function openReactivate(namespace: SharedNamespaceAdmin) {
    setReactivateSchema(String(namespace.active_schema_version));
    setReactivateTarget(namespace);
  }

  async function reactivate() {
    if (!reactivateTarget) return;
    const schema = Number(reactivateSchema);
    if (!Number.isInteger(schema) || schema < 1) {
      toast.error('Schema 版本必须是正整数');
      return;
    }
    setReactivateBusy(true);
    try {
      await reactivateSharedNamespace(reactivateTarget.namespace_id, schema);
      toast.success('命名空间已重新激活');
      setReactivateTarget(null);
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setReactivateBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>插件共享状态</CardTitle>
          <CardDescription>
            仅展示 namespace 元数据与容量，不浏览插件值正文。删除会保留 identity/allocator 并递增
            generation。
          </CardDescription>
        </div>
        <LoadingButton variant="outline" loading={loading} onClick={() => void load()}>
          刷新
        </LoadingButton>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Namespace</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Generation</TableHead>
              <TableHead>Schema</TableHead>
              <TableHead>用量</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {namespaces.map((namespace) => (
              <TableRow key={namespace.namespace_id}>
                <TableCell>
                  <div className="font-medium">{namespace.name}</div>
                  <div
                    className="max-w-44 truncate text-xs text-muted-foreground"
                    title={namespace.namespace_id}
                  >
                    {namespace.namespace_id}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {namespace.owner_kind === 'PACKAGE' ? '插件' : '工作流'}
                  </Badge>
                  <div
                    className="mt-1 max-w-40 truncate text-xs text-muted-foreground"
                    title={namespace.owner_id}
                  >
                    {namespace.owner_id}
                  </div>
                </TableCell>
                <TableCell>{namespace.generation}</TableCell>
                <TableCell>v{namespace.active_schema_version}</TableCell>
                <TableCell>
                  <div>
                    {bytes(namespace.used_bytes)} / {bytes(namespace.quota_bytes)}
                  </div>
                  <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary"
                      style={{
                        width: `${Math.min(100, namespace.quota_bytes ? (namespace.used_bytes / namespace.quota_bytes) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={namespace.deleted_at ? 'secondary' : 'default'}>
                    {namespace.deleted_at ? '已停用' : '启用中'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {!namespace.deleted_at && (
                      <>
                        <LoadingButton
                          size="sm"
                          variant="outline"
                          loading={downloadingId === namespace.namespace_id}
                          onClick={() => void download(namespace)}
                        >
                          导出
                        </LoadingButton>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setMigrateTarget(namespace)}
                        >
                          迁移
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setDeleteTarget(namespace)}
                        >
                          停用
                        </Button>
                      </>
                    )}
                    {namespace.deleted_at && (
                      <Button size="sm" onClick={() => openReactivate(namespace)}>
                        重新激活
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!loading && namespaces.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  暂无共享命名空间
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null);
        }}
        title="停用共享命名空间？"
        description={
          deleteTarget
            ? `将清除 ${deleteTarget.name} 的全部值正文并撤销 Artifact 授权；namespace identity 与 revision allocator 会保留。`
            : undefined
        }
        confirmText="停用并清除"
        destructive
        busy={deleteBusy}
        onConfirm={removeNamespace}
      />

      <Dialog
        open={Boolean(reactivateTarget)}
        onOpenChange={(open) => {
          if (!open && !reactivateBusy) setReactivateTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重新激活 {reactivateTarget?.name}</DialogTitle>
            <DialogDescription>
              沿用原 namespace identity，generation 递增；旧 token、订阅与 relist token 不会命中新
              generation。
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="shared-reactivate-schema">Active schema version</FieldLabel>
            <Input
              id="shared-reactivate-schema"
              type="number"
              min={1}
              step={1}
              value={reactivateSchema}
              onChange={(event) => setReactivateSchema(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={reactivateBusy}
              onClick={() => setReactivateTarget(null)}
            >
              取消
            </Button>
            <LoadingButton loading={reactivateBusy} onClick={() => void reactivate()}>
              重新激活
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {migrateTarget && (
        <MigrationDialog
          namespace={migrateTarget}
          onClose={() => setMigrateTarget(null)}
          onMigrated={load}
        />
      )}
    </Card>
  );
}

function MigrationDialog({
  namespace,
  onClose,
  onMigrated,
}: {
  namespace: SharedNamespaceAdmin;
  onClose: () => void;
  onMigrated: () => Promise<void>;
}) {
  const [key, setKey] = useState('');
  const [sourceSchema, setSourceSchema] = useState(String(namespace.active_schema_version));
  const [targetSchema, setTargetSchema] = useState(String(namespace.active_schema_version + 1));
  const [expectedRevision, setExpectedRevision] = useState('');
  const [valueJson, setValueJson] = useState('{}');
  const [saving, setSaving] = useState(false);

  async function submit() {
    const source = Number(sourceSchema);
    const target = Number(targetSchema);
    if (
      !key.trim() ||
      !Number.isInteger(source) ||
      source < 1 ||
      !Number.isInteger(target) ||
      target < 1 ||
      source === target ||
      !/^[0-9]+$/.test(expectedRevision)
    ) {
      toast.error('请填写 key、不同的正整数 schema 版本和十进制 expected revision');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(valueJson);
    } catch {
      toast.error('迁移值必须是合法 JSON');
      return;
    }
    setSaving(true);
    try {
      await migrateSharedNamespaceValue(namespace.namespace_id, key.trim(), {
        value,
        source_schema_version: source,
        target_schema_version: target,
        expected_revision: expectedRevision,
      });
      toast.success('共享值已按 CAS 完成 schema 迁移');
      onClose();
      await onMigrated();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>迁移共享值：{namespace.name}</DialogTitle>
          <DialogDescription>
            输入目标 JSON 并以 expected revision 执行 CAS。管理端不接受含 ArtifactRef 的值，避免绕过
            STANDARD invocation 授权。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field className="gap-1 sm:col-span-2">
            <FieldLabel htmlFor="shared-migrate-key">Key</FieldLabel>
            <Input
              id="shared-migrate-key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              maxLength={128}
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="shared-migrate-source">源 schema</FieldLabel>
            <Input
              id="shared-migrate-source"
              type="number"
              min={1}
              value={sourceSchema}
              onChange={(event) => setSourceSchema(event.target.value)}
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="shared-migrate-target">目标 schema</FieldLabel>
            <Input
              id="shared-migrate-target"
              type="number"
              min={1}
              value={targetSchema}
              onChange={(event) => setTargetSchema(event.target.value)}
            />
          </Field>
          <Field className="gap-1 sm:col-span-2">
            <FieldLabel htmlFor="shared-migrate-revision">Expected revision</FieldLabel>
            <Input
              id="shared-migrate-revision"
              inputMode="numeric"
              value={expectedRevision}
              onChange={(event) => setExpectedRevision(event.target.value)}
            />
          </Field>
          <Field className="gap-1 sm:col-span-2">
            <FieldLabel htmlFor="shared-migrate-value">目标 JSON</FieldLabel>
            <Textarea
              id="shared-migrate-value"
              rows={9}
              className="font-mono text-xs"
              value={valueJson}
              onChange={(event) => setValueJson(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <LoadingButton loading={saving} onClick={() => void submit()}>
            执行迁移
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
