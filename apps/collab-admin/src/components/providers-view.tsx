import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  CheckCircle2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  ZapIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid, ActionBar } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { LlmProvider, LlmProviderStatus } from '@/lib/types';
import { formatTime } from '@/lib/types';

// 平台维护的 provider 白名单（与 collab-api enums.ts LLM_PROVIDER 对齐，custom 兜底自建网关）。
// 仅用于新增/编辑对话框的 provider 选择项；后端 service 会再次校验。
const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'moonshot', label: 'Moonshot（月之暗面）' },
  { value: 'qwen', label: 'Qwen（通义千问）' },
  { value: 'custom', label: '自定义' },
];

const PROVIDER_LABEL: Record<string, string> = Object.fromEntries(
  PROVIDER_OPTIONS.map((o) => [o.value, o.label]),
);

function providerLabel(provider: string) {
  return PROVIDER_LABEL[provider] || provider;
}

export function ProvidersView() {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const load = () =>
    api<{ providers: LlmProvider[] }>('/api/admin/llm-providers').then((r) => setProviders(r.providers));
  useLoad(load);
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(providers);

  async function activate(provider: LlmProvider) {
    // 设为当前启用：事务维护唯一 active（后端 adminActivateProvider）。
    await run(
      () => api(`/api/admin/llm-providers/${provider.id}/activate`, { method: 'PATCH' }).then(load),
      `已将「${provider.name}」设为当前启用的模型服务`,
    );
  }

  async function remove(provider: LlmProvider) {
    if (!window.confirm(`确认删除模型服务「${provider.name}」？此操作不可恢复。`)) return;
    // 后端对 active provider 返回 provider_active_not_deletable，run 会 toast.message 反馈。
    await run(
      () => api(`/api/admin/llm-providers/${provider.id}`, { method: 'DELETE' }).then(load),
      '模型服务已删除',
    );
  }

  return (
    <Section
      title="模型服务"
      description="维护平台模型 provider 列表并指定「当前启用」。应用端只感知当前启用的服务地址，用户界面不暴露 provider 概念。"
    >
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm text-muted-foreground">{totalItems} 个模型服务</div>
          <CreateProviderDialog onRefresh={load}>
            <Button>
              <PlusIcon className="mr-1.5 size-4" />
              新增模型服务
            </Button>
          </CreateProviderDialog>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>提供方</TableHead>
              <TableHead>API 地址</TableHead>
              <TableHead>模型数</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>启用</TableHead>
              <TableHead className="w-[220px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginated.length ? (
              paginated.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell className="font-medium">{provider.name}</TableCell>
                  <TableCell className="text-muted-foreground">{providerLabel(provider.provider)}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground" title={provider.apiUrl}>
                    {provider.apiUrl}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{provider.models?.length ?? 0}</TableCell>
                  <TableCell><StatusBadge value={provider.status} /></TableCell>
                  <TableCell>
                    {provider.isActive ? (
                      <Badge variant="success" className="gap-1">
                        <CheckCircle2Icon className="size-3.5" />
                        当前启用
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ActionBar>
                      <EditProviderDialog provider={provider} onRefresh={load}>
                        <Button variant="outline" size="sm">
                          <PencilIcon className="mr-1 size-3.5" />
                          编辑
                        </Button>
                      </EditProviderDialog>
                      {provider.isActive ? (
                        // 当前启用项不可删除：后端拒绝（provider_active_not_deletable），前端禁用并 tooltip 提示。
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Button variant="outline" size="sm" disabled>
                                <Trash2Icon className="mr-1 size-3.5" />
                                删除
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>当前启用项不可删除，请先切换到其他模型服务</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Button variant="destructive" size="sm" onClick={() => remove(provider)}>
                          <Trash2Icon className="mr-1 size-3.5" />
                          删除
                        </Button>
                      )}
                      {provider.isActive ? (
                        <Button variant="outline" size="sm" disabled>
                          <ZapIcon className="mr-1 size-3.5" />
                          已启用
                        </Button>
                      ) : (
                        <Button variant="default" size="sm" onClick={() => activate(provider)}>
                          <ZapIcon className="mr-1 size-3.5" />
                          设为启用
                        </Button>
                      )}
                    </ActionBar>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  暂无模型服务，请新增并设为启用
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination
          totalItems={totalItems}
          pageSize={pageSize}
          currentPage={page}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </Section>
  );
}

// 表单字段的本地状态（新增/编辑共用）。
type ProviderFormState = {
  provider: string;
  name: string;
  apiUrl: string;
  modelsText: string; // 逗号/换行分隔的模型清单，提交时拆成 string[]
  description: string;
  sortOrder: number;
  status: LlmProviderStatus;
};

function emptyForm(): ProviderFormState {
  return {
    provider: 'openai',
    name: '',
    apiUrl: '',
    modelsText: '',
    description: '',
    sortOrder: 0,
    status: 'ENABLED',
  };
}

function formFromProvider(provider: LlmProvider): ProviderFormState {
  return {
    provider: provider.provider,
    name: provider.name,
    apiUrl: provider.apiUrl,
    modelsText: (provider.models ?? []).join('\n'),
    description: provider.description || '',
    sortOrder: provider.sortOrder ?? 0,
    status: provider.status,
  };
}

// 把用户填的模型清单文本拆成去重后的 string[]（支持逗号/换行/空白分隔）。
function parseModels(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,，]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/** --- 新增 provider Dialog --- */
function CreateProviderDialog({ children, onRefresh }: { children: React.ReactNode; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProviderFormState>(emptyForm());

  async function create() {
    if (!form.name.trim()) return toast.error('请输入名称');
    if (!form.apiUrl.trim()) return toast.error('请输入 API 地址');
    const body = {
      provider: form.provider,
      name: form.name.trim(),
      apiUrl: form.apiUrl.trim(),
      models: parseModels(form.modelsText),
      description: form.description.trim(),
      sortOrder: form.sortOrder,
      status: form.status,
    };
    // ADMIN-VIEW-04 约定：仅成功才关闭对话框并清空表单。
    if (
      !(await run(
        () => api('/api/admin/llm-providers', { method: 'POST', body }).then(onRefresh),
        '模型服务已创建',
      ))
    )
      return;
    setOpen(false);
    setForm(emptyForm());
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新增模型服务</DialogTitle>
          <DialogDescription>
            新增后默认未启用，需通过「设为启用」将其指定为当前启用的模型服务。
          </DialogDescription>
        </DialogHeader>
        <ProviderFormFields form={form} setForm={setForm} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={create}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** --- 编辑 provider Dialog --- */
function EditProviderDialog({
  provider,
  children,
  onRefresh,
}: {
  provider: LlmProvider;
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProviderFormState>(formFromProvider(provider));

  // 打开时从 provider 重置表单草稿（避免上次编辑残留）。
  useEffect(() => {
    if (open) setForm(formFromProvider(provider));
  }, [open, provider]);

  async function save() {
    if (!form.name.trim()) return toast.error('请输入名称');
    if (!form.apiUrl.trim()) return toast.error('请输入 API 地址');
    const body = {
      provider: form.provider,
      name: form.name.trim(),
      apiUrl: form.apiUrl.trim(),
      models: parseModels(form.modelsText),
      description: form.description.trim(),
      sortOrder: form.sortOrder,
      status: form.status,
    };
    // isActive 不在此改，通过专门的「设为启用」操作维护唯一 active。
    if (
      !(await run(
        () => api(`/api/admin/llm-providers/${provider.id}`, { method: 'PATCH', body }).then(onRefresh),
        '模型服务信息已更新',
      ))
    )
      return;
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑模型服务</DialogTitle>
          <DialogDescription>{provider.name}</DialogDescription>
        </DialogHeader>
        <InfoGrid
          items={[
            ['ID', provider.id],
            ['当前状态', provider.isActive ? '当前启用' : '未启用'],
            ['更新时间', formatTime(provider.updatedAt)],
          ]}
        />
        <ProviderFormFields form={form} setForm={setForm} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 表单字段组（新增/编辑共用）。 */
function ProviderFormFields({
  form,
  setForm,
}: {
  form: ProviderFormState;
  setForm: (next: ProviderFormState) => void;
}) {
  function patch(next: Partial<ProviderFormState>) {
    setForm({ ...form, ...next });
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>名称</Label>
          <Input
            placeholder="如：OpenAI 官方"
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>提供方</Label>
          <Select value={form.provider} onValueChange={(v) => patch({ provider: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROVIDER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label>API 地址</Label>
        <Input
          placeholder="https://api.openai.com/v1"
          value={form.apiUrl}
          onChange={(e) => patch({ apiUrl: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label>默认模型清单</Label>
        <Textarea
          placeholder="一行一个，或用逗号分隔，如：&#10;gpt-4o&#10;gpt-4o-mini"
          value={form.modelsText}
          onChange={(e) => patch({ modelsText: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">这是占位/兜底清单，应用端实际模型由 apiKey 拉取。</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>说明</Label>
          <Input
            placeholder="可选，备注用途"
            value={form.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>排序权重</Label>
          <Input
            type="number"
            min={0}
            value={form.sortOrder}
            onChange={(e) => patch({ sortOrder: Number(e.target.value) || 0 })}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label>状态</Label>
        <Select value={form.status} onValueChange={(v) => patch({ status: v as LlmProviderStatus })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ENABLED">已启用</SelectItem>
            <SelectItem value="DISABLED">已禁用</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          禁用后应用端不可见；「当前启用」需单独通过「设为启用」操作指定。
        </p>
      </div>
    </div>
  );
}
