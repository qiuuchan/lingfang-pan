// ModelGatewayTab.tsx — 设置页 Tab2：模型网关配置。
//
// 职责：
// - 从后端拉取网关目录（GET /api/llm/gateways，仅 ENABLED）+ 当前租户绑定列表（GET /api/llm/binding，脱敏）。
// - 展示绑定卡片（apiKeyHint 脱敏串 + effectiveModels + enabled）。
// - 编辑表单：选网关 + 填 apiKey（留空=保留原密）+ enabled 开关 + 模型 checkbox 组（modelOverride）。
// - 保存 PUT /api/llm/binding；删除 DELETE /api/llm/binding/:gatewayId。
// - 错误按 LlmErrorCode 分支（design B25，不 message.includes）。
//
// 与 CliRuntimeTab 不同：本组件自管 state（数据绑定在后端，独立于探测），不进 Settings 顶层。
// 网关目录与绑定列表是 HTTP 接口返回，字段 camelCase（契约 @lingfang/contract）。

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { NetworkIcon, PlusIcon, Trash2Icon, KeyRoundIcon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  BindingUpsertInput,
  LlmErrorCode,
  LlmGatewayPublic,
  TenantBindingPublic,
} from '@lingfang/contract';

/** GET /api/llm/gateways 出参。 */
interface GatewaysResponse {
  gateways: LlmGatewayPublic[];
}

/** GET /api/llm/binding 出参。 */
interface BindingsResponse {
  bindings: TenantBindingPublic[];
}

/** PUT /api/llm/binding 出参（单条绑定，脱敏）。 */
interface BindingResponse {
  binding: TenantBindingPublic;
}

/** 编辑表单状态。gatewayId 为空串=未选。 */
interface EditState {
  gatewayId: string;
  apiKey: string;
  enabled: boolean;
  modelOverride: string[];
}

/** 初始编辑态（新增绑定）。 */
const EMPTY_EDIT: EditState = { gatewayId: '', apiKey: '', enabled: true, modelOverride: [] };

/** LlmErrorCode → 友好提示文案（design B25，按 code 分支不 message.includes）。 */
function friendlyLlmError(code: string | undefined, fallback: string): string {
  switch (code as LlmErrorCode) {
    case 'gateway_disabled':
      return '该网关已被平台禁用，请选择其他网关。';
    case 'binding_not_found':
      return '尚未保存该网关的绑定，请填写 apiKey 后再保存。';
    case 'llm_key_decrypt_failed':
      return 'apiKey 解密失败，请重新填写 apiKey 后保存。';
    case 'llm_key_not_configured':
      return '服务端尚未配置加密密钥，请联系平台管理员。';
    default:
      return fallback;
  }
}

export function ModelGatewayTab() {
  const [gateways, setGateways] = useState<LlmGatewayPublic[]>([]);
  const [bindings, setBindings] = useState<TenantBindingPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  // 待确认删除的绑定（点击删除 → 置 binding → 弹二次确认 Dialog）。
  const [pendingDelete, setPendingDelete] = useState<TenantBindingPublic | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [gRes, bRes] = await Promise.all([
        api<GatewaysResponse>('/api/llm/gateways'),
        api<BindingsResponse>('/api/llm/binding'),
      ]);
      setGateways(gRes.gateways ?? []);
      setBindings(bRes.bindings ?? []);
    } catch (err) {
      toast.error((err as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载拉取目录 + 绑定（refresh 已捕获错误并 toast，无需此处再 catch）。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 进入编辑某条已有绑定（预填：apiKey 留空=保留原密，modelOverride 取 binding.modelOverride ?? 全集）。 */
  function startEditBinding(b: TenantBindingPublic) {
    const gateway = gateways.find((g) => g.id === b.gatewayId);
    // modelOverride=null 表示继承网关全集 → 编辑态默认全选。
    const override = b.modelOverride ?? gateway?.models ?? b.gatewayModels ?? [];
    setEdit({
      gatewayId: b.gatewayId,
      apiKey: '',
      enabled: b.enabled,
      modelOverride: override,
    });
  }

  /** 进入新增绑定（选空网关起步）。 */
  function startCreate() {
    setEdit({ ...EMPTY_EDIT });
  }

  /** 选定网关时同步 modelOverride 默认全集（新网关默认全选其模型）。 */
  function onSelectGateway(gatewayId: string) {
    const gateway = gateways.find((g) => g.id === gatewayId);
    setEdit((prev) => prev ? {
      ...prev,
      gatewayId,
      // 已存在的绑定：保留其 modelOverride；新网关：默认全选 models。
      modelOverride: bindings.some((b) => b.gatewayId === gatewayId)
        ? prev.modelOverride
        : (gateway?.models ?? []),
    } : prev);
  }

  /** 切换某模型勾选。 */
  function toggleModel(model: string) {
    setEdit((prev) => {
      if (!prev) return prev;
      const has = prev.modelOverride.includes(model);
      return {
        ...prev,
        modelOverride: has ? prev.modelOverride.filter((m) => m !== model) : [...prev.modelOverride, model],
      };
    });
  }

  /** 保存绑定（PUT）。apiKey 留空=保留原密（undefined，design B5）。 */
  async function saveEdit() {
    if (!edit) return;
    if (!edit.gatewayId) {
      toast.error('请选择网关');
      return;
    }
    const gateway = gateways.find((g) => g.id === edit.gatewayId);
    const exists = bindings.some((b) => b.gatewayId === edit.gatewayId);
    // 新建绑定必须填 apiKey；已存在绑定留空可保留原密。
    if (!exists && !edit.apiKey) {
      toast.error('请填写 apiKey');
      return;
    }
    const payload: BindingUpsertInput = {
      gatewayId: edit.gatewayId,
      apiKey: edit.apiKey || undefined,
      enabled: edit.enabled,
      modelOverride: edit.modelOverride,
    };
    setSaving(true);
    try {
      const res = await api<BindingResponse>('/api/llm/binding', { method: 'PUT', body: payload });
      setBindings((prev) => {
        const idx = prev.findIndex((b) => b.gatewayId === res.binding.gatewayId);
        if (idx === -1) return [...prev, res.binding];
        const next = [...prev];
        next[idx] = res.binding;
        return next;
      });
      toast.success('网关绑定已保存');
      setEdit(null);
    } catch (err) {
      const e = err as ApiError;
      toast.error(friendlyLlmError(e.code, e.message));
    } finally {
      setSaving(false);
    }
  }

  /** 删除绑定（DELETE，二次确认）。 */
  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api(`/api/llm/binding/${pendingDelete.gatewayId}`, { method: 'DELETE' });
      setBindings((prev) => prev.filter((b) => b.gatewayId !== pendingDelete.gatewayId));
      toast.success('绑定已删除');
      setPendingDelete(null);
    } catch (err) {
      const e = err as ApiError;
      toast.error(friendlyLlmError(e.code, e.message));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">加载网关目录…</CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部说明 + 新增按钮 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <NetworkIcon className="size-4 text-primary" />
          选择平台维护的网关，填写你自己的 apiKey（云端加密存储，跨电脑可用）。
        </div>
        <Button size="sm" onClick={startCreate}><PlusIcon />新增绑定</Button>
      </div>

      {/* 当前绑定列表 */}
      {bindings.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            尚未绑定任何网关，点击右上角「新增绑定」开始配置。
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {bindings.map((b) => (
            <Card key={b.id}>
              <CardContent className="flex flex-col gap-2 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{b.gatewayName}</span>
                      <Badge variant="outline">{b.provider}</Badge>
                      {b.gatewayStatus === 'DISABLED' ? (
                        <Badge variant="destructive">已禁用</Badge>
                      ) : b.enabled ? (
                        <Badge variant="default">已启用</Badge>
                      ) : (
                        <Badge variant="secondary">已停用</Badge>
                      )}
                    </div>
                    {/* apiKey 脱敏串（非明文非密文，后端 maskApiKey 产出） */}
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <KeyRoundIcon className="size-3" />
                      <span className="font-mono">{b.apiKeyHint || '（未设置密钥）'}</span>
                    </div>
                    {/* 生效模型（modelOverride ?? gatewayModels） */}
                    <div className="mt-1 text-xs text-muted-foreground">
                      生效模型：<span className="text-foreground">{b.effectiveModels.join('、') || '无'}</span>
                    </div>
                    {b.updatedBy ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        最近更新：{b.updatedBy.displayName} · {b.updatedAt}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => startEditBinding(b)}>编辑</Button>
                    <Button variant="ghost" size="sm" onClick={() => setPendingDelete(b)} aria-label="删除">
                      <Trash2Icon className="text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 编辑/新增表单（Dialog） */}
      <EditBindingDialog
        edit={edit}
        gateways={gateways}
        bindings={bindings}
        saving={saving}
        onGatewayChange={onSelectGateway}
        onApiKeyChange={(v) => setEdit((prev) => prev ? { ...prev, apiKey: v } : prev)}
        onEnabledChange={(v) => setEdit((prev) => prev ? { ...prev, enabled: v } : prev)}
        onToggleModel={toggleModel}
        onCancel={() => setEdit(null)}
        onSave={() => { void saveEdit(); }}
      />

      {/* 删除二次确认 Dialog */}
      <Dialog open={pendingDelete !== null} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除网关绑定</DialogTitle>
            <DialogDescription>
              将删除「{pendingDelete?.gatewayName ?? ''}」的绑定与其加密 apiKey，此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>取消</Button>
            <LoadingButton variant="destructive" loading={deleting} onClick={() => { void confirmDelete(); }}>
              确认删除
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 编辑/新增绑定 Dialog。edit=null 时不渲染（受控）。 */
function EditBindingDialog({
  edit,
  gateways,
  bindings,
  saving,
  onGatewayChange,
  onApiKeyChange,
  onEnabledChange,
  onToggleModel,
  onCancel,
  onSave,
}: {
  edit: EditState | null;
  gateways: LlmGatewayPublic[];
  bindings: TenantBindingPublic[];
  saving: boolean;
  onGatewayChange: (gatewayId: string) => void;
  onApiKeyChange: (v: string) => void;
  onEnabledChange: (v: boolean) => void;
  onToggleModel: (model: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const open = edit !== null;
  const gateway = edit ? gateways.find((g) => g.id === edit.gatewayId) : null;
  const exists = edit ? bindings.some((b) => b.gatewayId === edit.gatewayId) : false;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{exists ? '编辑网关绑定' : '新增网关绑定'}</DialogTitle>
          <DialogDescription>
            apiKey 留空{exists ? '表示保留原密钥不变' : '不可保存'}；云端以 AES-256-GCM 加密存储。
          </DialogDescription>
        </DialogHeader>

        {edit ? (
          <div className="flex flex-col gap-3">
            {/* 网关选择 */}
            <div className="flex flex-col gap-1.5">
              <Label>网关</Label>
              <Select value={edit.gatewayId || null} onValueChange={(v) => { if (v) onGatewayChange(String(v)); }}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择网关" />
                </SelectTrigger>
                <SelectContent>
                  {gateways.map((g) => (
                    <SelectItem key={g.id} value={g.id}>{g.name}（{g.provider}）</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {gateway?.description ? (
                <span className="text-xs text-muted-foreground">{gateway.description}</span>
              ) : null}
            </div>

            {/* apiKey */}
            <div className="flex flex-col gap-1.5">
              <Label>apiKey {exists ? '（留空保留原密）' : ''}</Label>
              <Input
                type="password"
                placeholder={exists ? '留空表示保留原密钥' : 'sk-...'}
                value={edit.apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                autoComplete="off"
              />
            </div>

            {/* 启用开关 */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="binding-enabled"
                checked={edit.enabled}
                onCheckedChange={(v) => onEnabledChange(v === true)}
              />
              <Label htmlFor="binding-enabled" className="cursor-pointer">启用此绑定</Label>
            </div>

            {/* 模型选择（checkbox 组） */}
            {gateway && gateway.models.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <Label>生效模型（勾选后保存为 modelOverride）</Label>
                <div className="flex flex-col gap-1.5 rounded-lg border p-2">
                  {gateway.models.map((m) => (
                    <div key={m} className="flex items-center gap-2">
                      <Checkbox
                        id={`model-${m}`}
                        checked={edit.modelOverride.includes(m)}
                        onCheckedChange={() => onToggleModel(m)}
                      />
                      <Label htmlFor={`model-${m}`} className="cursor-pointer font-mono text-xs">{m}</Label>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <LoadingButton loading={saving} onClick={onSave}>保存</LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
