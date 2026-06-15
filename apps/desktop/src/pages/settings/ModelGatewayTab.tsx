// ModelGatewayTab.tsx — 设置页模型网关配置（v3 定稿：单 provider 云分发 + 无 provider UI）。
//
// 职责（design §5 / prd AC1/AC2/AC7/AC8）：
// - 用户界面零 provider 概念：只有一个 apiKey 输入 + 「拉取模型」按钮 + 模型 checkbox 组 + 保存。
// - 挂载：GET /api/llm/active-provider（拿当前启用 provider 的 apiUrl + defaultModels 兜底）
//        + GET /api/llm/binding（当前团队的单条绑定，脱敏 hint + modelOverride）。
// - 拉取模型：tauriInvoke('fetch_models') 直连 active provider 的 /v1/models（reqwest 绕 CORS）。
// - 保存：PUT /api/llm/binding { apiKey, modelOverride }（无 gatewayId，按 teamId 唯一 upsert）。
//
// 安全（AC9）：apiKey 只在「拉取模型」时作为 fetchModels 参数经 IPC 传给 Rust reqwest 临时用，
// 不存入前端 state 之外的位置（state 在保存后清空），不进 webview 长期内存。后端只存加密 key。
//
// 错误处理：
// - active-provider 404 `no_active_provider`（AC7）→ 整个 Card 显示「平台尚未配置模型服务，请联系管理员」并禁用输入。
// - fetch_models（friendlyFetchError，按 message 前缀 code 分支）：api_key_invalid / provider_response_unsupported / 网络。
// - PUT/DELETE（friendlyLlmError，按 LlmErrorCode 分支）：binding_not_found / llm_key_decrypt_failed / ...。

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRoundIcon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { fetchModels } from '@/lib/llm-fetch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/loading-button';
import { Shimmer } from '@/lib/motion';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  ActiveProvider,
  BindingUpsertInput,
  LlmErrorCode,
  TenantBindingPublic,
} from '@lingfang/contract';
import { dragRegionProps } from '@/lib/window-drag';

/** GET /api/llm/active-provider 出参。 */
type ActiveProviderResponse = ActiveProvider;

/** GET /api/llm/binding 出参（单条绑定，无则 null）。 */
interface BindingResponse {
  binding: TenantBindingPublic | null;
}

/** LlmErrorCode → 友好提示文案（design §5，按 code 分支不 message.includes）。 */
function friendlyLlmError(code: string | undefined, fallback: string): string {
  switch (code as LlmErrorCode) {
    case 'no_active_provider':
      return '平台尚未配置模型服务，请联系管理员。';
    case 'binding_not_found':
      return '尚未保存配置，填写 API 密钥后再保存。';
    case 'llm_key_decrypt_failed':
      return '密钥读取失败，重新填写 API 密钥后保存。';
    case 'llm_key_not_configured':
      return '平台尚未配置加密密钥，请联系管理员。';
    default:
      return fallback;
  }
}

/**
 * fetch_models 错误 → 友好提示文案（design §5，按 message 前缀 code 分支）。
 *
 * Rust llm_fetch 返回的错误字符串形如 "api_key_invalid:apiKey 无效或已过期"，
 * 前缀是稳定的 code（前端用 startsWith 匹配），后缀是 provider 上下文的人类可读描述。
 */
function friendlyFetchError(message: string): string {
  if (message.startsWith('api_key_invalid')) {
    return 'API 密钥无效或已过期，请检查后重试。';
  }
  if (message.startsWith('provider_response_unsupported')) {
    return '当前模型服务暂不支持自动拉取模型（非 OpenAI 兼容协议）。';
  }
  if (message.includes('网络') || message.includes('timeout') || message.includes('Timeout')) {
    return '网络请求失败，请检查网络或服务地址后重试。';
  }
  return message;
}

/** 判定一个 ApiError 是否为「无 active provider」（HTTP 404 + code）。 */
function isNoActiveProviderError(err: unknown): boolean {
  const e = err as ApiError;
  return e?.code === 'no_active_provider' || e?.status === 404;
}

export function ModelGatewayTab() {
  // 当前启用 provider（null=平台未配置 active provider）。
  const [activeProvider, setActiveProvider] = useState<ActiveProvider | null>(null);
  // 平台未配置 active provider（active-provider 404 时为 true，整 Card 切到禁用态）。
  const [noProvider, setNoProvider] = useState(false);

  // 当前团队的单条绑定（null=未绑定）。
  const [binding, setBinding] = useState<TenantBindingPublic | null>(null);

  // 挂载态：拉 active-provider + binding。
  const [loading, setLoading] = useState(true);

  // 用户填的明文 apiKey（未保存；保存后清空）。
  const [apiKeyInput, setApiKeyInput] = useState('');
  // 拉取状态。
  const [fetching, setFetching] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  // 选中要保存进 modelOverride 的模型子集。
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // 待确认删除（点删除 → 置 true → 弹二次确认 Dialog）。
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setNoProvider(false);
    try {
      // 先拉 active-provider：404 时切到「平台未配置」禁用态，binding 也不必再拉。
      try {
        const apRes = await api<ActiveProviderResponse>('/api/llm/active-provider');
        setActiveProvider(apRes);
      } catch (err) {
        if (isNoActiveProviderError(err)) {
          setActiveProvider(null);
          setNoProvider(true);
          // 无 active provider 时直接结束加载，binding 也无意义。
          setLoading(false);
          return;
        }
        throw err;
      }
      // 再拉当前团队的单条绑定（脱敏 hint + modelOverride）。
      const bRes = await api<BindingResponse>('/api/llm/binding');
      setBinding(bRes.binding);
      // 若已有绑定且含 modelOverride，预填勾选态（方便用户在未重新拉取时调整选择）。
      setSelectedModels(bRes.binding?.modelOverride ?? []);
    } catch (err) {
      toast.error((err as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载拉取 active-provider + binding（refresh 已捕获错误并 toast）。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 点「拉取模型」：调 fetch_models（Rust 直连 active provider /v1/models）。
   *  已绑定 key 时直接用 decrypt 拿明文拉取，不需要用户重新填。 */
  async function handleFetchModels() {
    if (!activeProvider) return;
    // 优先用用户输入的 key；输入为空但已有绑定时，调 decrypt 拿绑定的 key。
    let key = apiKeyInput.trim();
    if (!key && binding) {
      try {
        const res = await api<{ apiKey: string }>('/api/llm/binding/decrypt', { method: 'POST' });
        key = res.apiKey;
      } catch {
        toast.error('获取已保存的密钥失败');
        return;
      }
    }
    if (!key) {
      toast.error('先填写 API 密钥');
      return;
    }
    setFetching(true);
    setFetchedModels([]);
    setSelectedModels([]);
    try {
      const models = await fetchModels(
        activeProvider.name ?? '',
        activeProvider.apiUrl,
        key,
      );
      setFetchedModels(models);
      // 默认全选拉取到的模型（用户可取消勾选）。
      setSelectedModels(models);
      if (models.length === 0) {
        toast.info('当前模型服务无可用模型。');
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
    // 新建绑定必须填 apiKey；已存在绑定留空可保留原密。
    if (!binding && !apiKeyInput.trim()) {
      toast.error('填写 API 密钥');
      return;
    }
    const payload: BindingUpsertInput = {
      apiKey: apiKeyInput.trim() || undefined,
      modelOverride: selectedModels,
    };
    setSaving(true);
    try {
      const res = await api<BindingResponse>('/api/llm/binding', { method: 'PUT', body: payload });
      setBinding(res.binding);
      // 保存后清空明文 apiKey（不长期持有）。
      setApiKeyInput('');
      toast.success('已保存');
    } catch (err) {
      const e = err as ApiError;
      toast.error(friendlyLlmError(e.code, e.message));
    } finally {
      setSaving(false);
    }
  }

  /** 删除绑定（DELETE，二次确认）。 */
  async function confirmDelete() {
    setDeleting(true);
    try {
      await api('/api/llm/binding', { method: 'DELETE' });
      setBinding(null);
      setFetchedModels([]);
      setSelectedModels([]);
      setApiKeyInput('');
      setPendingDelete(false);
      toast.success('模型配置已删除');
    } catch (err) {
      const e = err as ApiError;
      toast.error(friendlyLlmError(e.code, e.message));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    // 加载骨架：标题块 + 若干行占位，替代「加载中…」纯文字。
    return (
      <Card>
        <CardContent className="space-y-3 py-6">
          <Shimmer className="h-5 w-40" />
          <Shimmer className="h-10 w-full" />
          <Shimmer className="h-10 w-full" />
          <Shimmer className="h-8 w-32" />
        </CardContent>
      </Card>
    );
  }

  // AC7：平台未配置 active provider → 整 Card 显示提示并禁用所有输入。
  if (noProvider) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">模型服务</CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          平台尚未配置模型服务，请联系管理员。
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部说明：零 provider 概念（不暴露「网关目录/provider/源」字样）。 */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <KeyRoundIcon className="size-4 text-primary" />
        填写你的 API 密钥（云端加密存储，跨电脑可用），拉取当前可用模型并勾选要启用的。
      </div>

      {/* 配置区 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">模型服务</CardTitle>
          {/* 已绑定标记：显示脱敏 hint + 「已配置」Badge。 */}
          {binding ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <KeyRoundIcon className="size-3" />
              <span className="font-mono">{binding.apiKeyHint || '（未设置密钥）'}</span>
              {binding.enabled ? (
                <Badge variant="default">已启用</Badge>
              ) : (
                <Badge variant="secondary">已停用</Badge>
              )}
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 1. apiKey 输入 + 拉取按钮 */}
          <div className="flex flex-col gap-1.5">
            <Label>API 密钥 {binding ? '（留空保留原密钥）' : ''}</Label>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder={binding ? '重新填写以覆盖原密钥' : 'sk-...'}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                autoComplete="off"
              />
              <LoadingButton
                onClick={() => { void handleFetchModels(); }}
                loading={fetching}
                disabled={!apiKeyInput.trim() || fetching}
              >
                拉取模型
              </LoadingButton>
            </div>
          </div>

          {/* 2. 模型展示区 */}
          {fetching ? (
            <div className="rounded-lg border p-3 text-center text-sm text-muted-foreground">
              拉取中
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

          {/* 3. 已绑定但未重新拉取时，若 modelOverride 非空，回显当前生效模型（供用户知情）。 */}
          {!fetching && fetchedModels.length === 0 && binding?.modelOverride && binding.modelOverride.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              当前生效模型：<span className="font-mono text-foreground">{binding.modelOverride.join('、')}</span>
            </div>
          ) : null}

          {/* 4. 保存 + 删除按钮 */}
          <div className="flex justify-end gap-2">
            {binding ? (
              <LoadingButton
                variant="outline"
                onClick={() => setPendingDelete(true)}
                disabled={deleting}
              >
                删除配置
              </LoadingButton>
            ) : null}
            <LoadingButton onClick={() => { void handleSave(); }} loading={saving} disabled={saving}>
              保存
            </LoadingButton>
          </div>

          {binding?.updatedBy ? (
            <div className="text-xs text-muted-foreground">
              最近更新：{binding.updatedBy.displayName} · {binding.updatedAt}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 删除二次确认 Dialog */}
      <Dialog open={pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(false); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader {...dragRegionProps}>
            <DialogTitle data-tauri-drag-region>删除模型配置</DialogTitle>
            <DialogDescription>
              将删除当前的模型配置与关联的密钥，此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <LoadingButton variant="outline" onClick={() => setPendingDelete(false)}>取消</LoadingButton>
            <LoadingButton variant="destructive" loading={deleting} onClick={() => { void confirmDelete(); }}>
              确认删除
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
