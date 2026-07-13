// BillingTab —— 设置页「模型与计费」Tab。
//
// 普通成员不在这里创建、填写或查看 API Key/API URL。插件和 Agent 统一通过宿主桥/登录态
// 调用平台 relay，并且只消耗当前会话团队额度。
import { useEffect, useState } from 'react';
import { InfoIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { modelTierLabel, normalizeModelTier } from '@/lib/model-tier';

interface RelayModel {
  id: string;
  label?: string;
  resourcePools?: Array<{ id: string; name: string; scope: string; teamId: string | null }>;
}

export function BillingTab() {
  const [models, setModels] = useState<RelayModel[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadModels() {
    setLoading(true);
    try {
      const result = await api<{ data: RelayModel[] }>('/api/relay/v1/models').catch(() => ({ data: [] }));
      setModels(result.data ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadModels(); }, []);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div className="flex items-center gap-2">
            <InfoIcon className="size-5 text-primary" />
            <div>
              <CardTitle>模型版本</CardTitle>
              <CardDescription>插件和创建器可选择平台提供的模型版本。</CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => { void loadModels(); }} disabled={loading}>
            刷新
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {models.length ? models.map((model) => {
              const tier = normalizeModelTier(model.id);
              return (
                <Badge key={model.id} variant="secondary" className="text-sm">
                  {model.label ?? (tier ? modelTierLabel(tier) : model.id)}
                  {model.resourcePools?.length ? ` · ${model.resourcePools.map((pool) => pool.name).join('、')}` : ' · 暂无可用资源池'}
                </Badge>
              );
            }) : <span className="text-sm text-muted-foreground">{loading ? '加载中…' : '连接平台后显示'}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5 text-primary" />
            <div>
              <CardTitle>模型调用</CardTitle>
              <CardDescription>密钥和上游地址由平台与团队管理员维护。</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <SparklesIcon className="size-4 text-primary" />
                插件与 Agent
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                使用平台 SDK 能力调用模型，可传 model，不需要填写密钥、地址或供应商。
              </p>
            </div>
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="text-sm font-medium">团队额度</div>
              <p className="mt-1 text-xs text-muted-foreground">
                对话与生图统一消耗当前会话团队的灵石，不会切换到其他团队或个人额度。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
