// ModelGatewayTab.tsx — 设置页模型网关配置（重做版：填 key + Rust 拉取模型）。
//
// 职责（design §3.2 / prd AC1-AC8）：
// - 挂载拉取 provider 云分发列表（GET /api/llm/gateways）+ 当前租户绑定（GET /api/llm/binding，脱敏）。
// - 新交互：选 provider → 填 apiKey → 点「拉取模型」（tauriInvoke fetch_models，Rust 直连 provider
//   /v1/models）→ 显示拉取到的真实模型列表（checkbox 多选）→ 保存 PUT /api/llm/binding。
// - 已绑定 provider：显示脱敏 apiKeyHint + 「已配置」标记，apiKey 留空=保留原密（design B5）。
// - 错误按前缀 code 分支（不 message.includes，design §3.2 第5点）：
//   fetch_models：api_key_invalid / provider_response_unsupported / 网络 / 其余。
//   PUT/DELETE：按 LlmErrorCode 分支（gateway_disabled / binding_not_found / ...）。
//
// 安全（AC7）：apiKey 只在「拉取模型」时作为 fetchModels 参数经 IPC 传给 Rust reqwest 临时用，
// 不存入前端 state 之外的位置（state 在保存/取消后清空），不进 webview 长期内存。后端只存加密 key。
//
// 与旧版差异（破坏式重做）：删除「网关下拉 + 静态 models checkbox 组」交互，provider 的 apiUrl
// 来自云分发，用户不感知 url；模型由 provider 真实 /v1/models 返回，非 Admin 维护静态数组。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { NetworkIcon, KeyRoundIcon, Trash2Icon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { fetchModels } from '@/lib/llm-fetch';
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

/** LlmErrorCode → 友好提示文案（design B25，按 code 分支不 message.includes）。 */
function friendlyLlmError(code: string | undefined, fallback: string): string {
  switch (code as LlmErrorCode) {
    case 'gateway_disabled':
      return '该 provider 已被平台禁用，请选择其他 provider。';
    case 'binding_not_found':
      return '尚未保存该 provider 的绑定，请填写 apiKey 后再保存。';
    case 'llm_key_decrypt_failed':
      return 'apiKey 解密失败，请重新填写 apiKey 后保存。';
    case 'llm_key_not_configured':
      return '服务端尚未配置加密密钥，请联系平台管理员。';
    default:
      return fallback;
  }
}

/**
 * fetch_models 错误 → 友好提示文案（design §3.2 第5点，按 message 前缀 code 分支）。
 *
 * Rust llm_fetch 返回的错误字符串形如 "api_key_invalid:openai 的 apiKey 无效或已过期"，
 * 前缀是稳定的 code（前端用 startsWith 匹配），后缀是 provider 上下文的人类可读描述。
 */
function friendlyFetchError(message: string): string {
  if (message.startsWith('api_key_invalid')) {
    return 'apiKey 无效或已过期，请检查后重试。';
  }
  if (message.startsWith('provider_response_unsupported')) {
    return '该 provider 暂不支持自动拉取模型（非 OpenAI 兼容协议）。';
  }
  if (message.includes('网络') || message.includes('timeout') || message.includes('Timeout')) {
    return '网络请求失败，请检查网络或 provider 地址后重试。';
  }
  return message;
}

export function ModelGatewayTab() {
  const [providers, setProviders] = useState<LlmGatewayPublic[]>([]);
  const [bindings, setBindings] = useState<TenantBindingPublic[]>([]);
  const [loading, setLoading] = useState(true);

  // 编辑态：选中的 provider id（null=未选）。
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  // 用户填的明文 apiKey（未保存；保存/取消/切换 provider 时清空）。
  const [apiKeyInput, setApiKeyInput] = useState('');
  // 拉取状态。
  const [fetching, setFetching] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  // 选中要保存进 modelOverride 的模型子集。
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

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
      setProviders(gRes.gateways ?? []);
      setBindings(bRes.bindings ?? []);
    } catch (err) {
      toast.error((err as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载拉取 provider 列表 + 绑定（refresh 已捕获错误并 toast，无需此处再 catch）。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 当前选中的 provider 对象（从云分发列表查）。
  const selectedProvider = useMemo(
    () => providers.find((g) => g.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );

  // 当前选中 provider 的已有绑定（若有）。
  const selectedBinding = useMemo(
    () => bindings.find((b) => b.gatewayId === selectedProviderId) ?? null,
    [bindings, selectedProviderId],
  );

  /** 切换 provider：清空编辑态，回到「待填 key」初始态。 */
  function handleSelectProvider(gatewayId: string) {
    setSelectedProviderId(gatewayId);
    setApiKeyInput('');
    setFetchedModels([]);
    setSelectedModels([]);
    setFetching(false);
  }

  /** 重置编辑态（关闭面板/取消）。 */
  function resetEdit() {
    setSelectedProviderId(null);
    setApiKeyInput('');
    setFetchedModels([]);
    setSelectedModels([]);
    setFetching(false);
  }

  /** 点「拉取模型」：调 fetch_models（Rust 直连 provider /v1/models）。 */
  async function handleFetchModels() {
    if (!selectedProvider) return;
    if (!apiKeyInput.trim()) {
      toast.error('请先填写 apiKey');
      return;
    }
    setFetching(true);
    setFetchedModels([]);
    setSelectedModels([]);
    try {
      // AC7：apiKey 仅作为参数传给 Rust reqwest 临时用，不落盘不进长期内存。
      const models = await fetchModels(
        selectedProvider.provider,
        selectedProvider.apiUrl,
        apiKeyInput,
      );
      setFetchedModels(models);
      // 默认全选拉取到的模型（用户可取消勾选）。
      setSelectedModels(models);
      if (models.length === 0) {
        toast.info('该 provider 当前无可用模型。');
      } else {
        toast.success(`已拉取 ${models.length} 个模型`);
      }
    } catch (err) {
      // fetchModels 抛 Error（tauriInvoke 失败时 message 为 Rust 返回的字符串，含 code 前缀）。
      toast.error(friendlyFetchError((err as Error).message || '拉取模型失败'));
    } finally {
      setFetching(false);
    }
  }

  /** 切换某模型勾选。 */
  function toggleModel(model: string) {
    setSelectedModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model],
    );
  }

  /** 保存绑定（PUT）。apiKey 留空=保留原密（undefined，design B5）。 */
  async function handleSave() {
    if (!selectedProviderId) {
      toast.error('请选择 provider');
      return;
    }
    const exists = bindings.some((b) => b.gatewayId === selectedProviderId);
    // 新建绑定必须填 apiKey；已存在绑定留空可保留原密。
    if (!exists && !apiKeyInput.trim()) {
      toast.error('请填写 apiKey');
      return;
    }
    const payload: BindingUpsertInput = {
      gatewayId: selectedProviderId,
      apiKey: apiKeyInput.trim() || undefined,
      modelOverride: selectedModels,
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
      toast.success('provider 绑定已保存');
      resetEdit();
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
      // 若删除的正是当前编辑中的 provider，一并重置编辑态。
      if (selectedProviderId === pendingDelete.gatewayId) {
        resetEdit();
      }
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
        <CardContent className="py-8 text-center text-sm text-muted-foreground">加载 provider 列表…</CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部说明 */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <NetworkIcon className="size-4 text-primary" />
        选择平台分发的 provider，填写你自己的 apiKey（云端加密存储，跨电脑可用），拉取该 provider 的真实可用模型。
      </div>

      {/* provider 配置区 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">配置 provider</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 1. provider 选择 */}
          <div className="flex flex-col gap-1.5">
            <Label>provider</Label>
            <Select
              value={selectedProviderId}
              onValueChange={(v) => { if (typeof v === 'string') handleSelectProvider(v); }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择 provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}（{g.provider}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProvider?.description ? (
              <span className="text-xs text-muted-foreground">{selectedProvider.description}</span>
            ) : null}
            {/* 已绑定标记：选中已配置的 provider 时显示脱敏 hint */}
            {selectedBinding ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRoundIcon className="size-3" />
                <span className="font-mono">{selectedBinding.apiKeyHint || '（未设置密钥）'}</span>
                <Badge variant="secondary">已配置</Badge>
              </div>
            ) : null}
          </div>

          {/* 2. apiKey 输入 + 拉取按钮 */}
          <div className="flex flex-col gap-1.5">
            <Label>apiKey {selectedBinding ? '（留空保留原密）' : ''}</Label>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder={selectedBinding ? '重新填写覆盖原密钥' : 'sk-...'}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                autoComplete="off"
                disabled={!selectedProviderId}
              />
              <LoadingButton
                onClick={() => { void handleFetchModels(); }}
                loading={fetching}
                disabled={!selectedProviderId || !apiKeyInput.trim() || fetching}
              >
                拉取模型
              </LoadingButton>
            </div>
          </div>

          {/* 3. 模型展示区 */}
          {fetching ? (
            <div className="rounded-lg border p-3 text-center text-sm text-muted-foreground">
              正在拉取模型…
            </div>
          ) : fetchedModels.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label>可用模型（勾选后保存为生效模型）</Label>
              <div className="flex flex-col gap-1.5 rounded-lg border p-2 max-h-60 overflow-y-auto">
                {fetchedModels.map((m) => (
                  <div key={m} className="flex items-center gap-2">
                    <Checkbox
                      id={`model-${m}`}
                      checked={selectedModels.includes(m)}
                      onCheckedChange={() => toggleModel(m)}
                    />
                    <Label htmlFor={`model-${m}`} className="cursor-pointer font-mono text-xs">{m}</Label>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* 4. 保存按钮 */}
          {selectedProviderId ? (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={resetEdit}>取消</Button>
              <LoadingButton onClick={() => { void handleSave(); }} loading={saving} disabled={saving}>
                保存
              </LoadingButton>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 当前绑定列表 */}
      {bindings.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            尚未绑定任何 provider，请在上方选择 provider 并填写 apiKey 开始配置。
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="text-sm text-muted-foreground">已绑定的 provider</div>
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
                    {/* 编辑=选中该 provider 进入配置区，预填 modelOverride（若已绑定）。 */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleSelectProvider(b.gatewayId);
                        // 预填已绑定的 modelOverride（用于在未重新拉取时保留原选择）。
                        setSelectedModels(b.modelOverride ?? b.effectiveModels ?? []);
                      }}
                    >
                      编辑
                    </Button>
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

      {/* 删除二次确认 Dialog */}
      <Dialog open={pendingDelete !== null} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除 provider 绑定</DialogTitle>
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
