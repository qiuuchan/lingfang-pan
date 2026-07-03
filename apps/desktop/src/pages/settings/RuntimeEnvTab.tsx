// RuntimeEnvTab.tsx — 设置页 Tab1：脚本运行环境（简化版：状态展示 + 镜像源配置）。
//
// 两区：
// 1. 运行时状态：Python/Node 各一行（内置版本 + Badge「内置」），只读展示。
// 2. 镜像源：pip/npm 下拉 + 自定义 URL + 保存（仅注入本应用子进程，不写系统全局）。

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CpuIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingButton } from '@/components/loading-button';
import { errorMessage } from '@/lib/api';
import {
  getRuntimeStatus,
  getRuntimeConfig,
  setMirrorConfig,
  type RuntimeStatusMap,
  type RuntimeConfig,
  type MirrorConfig,
  type RuntimeKind,
  PIP_MIRROR_PRESETS,
  NPM_MIRROR_PRESETS,
  CUSTOM_MIRROR_ID,
  RUNTIME_LABEL,
  SOURCE_LABEL,
  formatVersion,
} from '@/lib/runtime-config';

export function RuntimeEnvTab() {
  const [statusMap, setStatusMap] = useState<RuntimeStatusMap | null>(null);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [mirrorsDraft, setMirrorsDraft] = useState<MirrorConfig>({
    pipId: 'tsinghua',
    npmId: 'npmmirror',
  });
  const [savingMirrors, setSavingMirrors] = useState(false);

  // 初始加载
  useEffect(() => {
    void loadStatus();
    void loadConfig();
  }, []);

  // config 加载完成后初始化 mirrorsDraft
  useEffect(() => {
    if (config) {
      setMirrorsDraft(config.mirrors);
    }
  }, [config]);

  async function loadStatus() {
    try {
      const status = await getRuntimeStatus();
      setStatusMap(status);
    } catch (e) {
      toast.error(errorMessage(e, '加载运行时状态失败'));
    }
  }

  async function loadConfig() {
    try {
      const cfg = await getRuntimeConfig();
      setConfig(cfg);
    } catch (e) {
      toast.error(errorMessage(e, '加载配置失败'));
    }
  }

  async function handleSaveMirrors() {
    setSavingMirrors(true);
    try {
      await setMirrorConfig(mirrorsDraft);
      toast.success('镜像源已保存');
      await loadConfig();
    } catch (e) {
      toast.error(errorMessage(e, '保存镜像源失败'));
    } finally {
      setSavingMirrors(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-8">
      {/* 区 1：运行时状态（只读展示） */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CpuIcon className="size-5 text-muted-foreground" />
            <CardTitle>脚本运行环境</CardTitle>
          </div>
          <CardDescription>
            使用应用内置的 Python 与 Node.js 运行时，无需单独安装
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(['python', 'nodejs'] as RuntimeKind[]).map((kind) => {
            const key = kind === 'nodejs' ? 'node' : 'python';
            const status = statusMap?.[key];
            const label = RUNTIME_LABEL[kind];
            const version = formatVersion(label, status?.version ?? null);
            const available = status?.available ?? false;
            const source = status?.source;

            return (
              <div key={kind} className="flex items-center justify-between rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-md bg-muted">
                    <CpuIcon className="size-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{label}</span>
                      {version && <span className="text-sm text-muted-foreground">{version}</span>}
                    </div>
                    {available && source && (
                      <Badge variant="default" className="mt-1">
                        {SOURCE_LABEL[source as 'legacy']}
                      </Badge>
                    )}
                    {!available && (
                      <Badge variant="secondary" className="mt-1">
                        未安装
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* 区 2：镜像源配置 */}
      <Card>
        <CardHeader>
          <CardTitle>镜像源</CardTitle>
          <CardDescription>
            配置 pip / npm 镜像源，仅影响本应用启动的插件子进程，不修改系统全局 pip.ini / .npmrc
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <MirrorSelector
            label="pip 镜像源"
            presets={PIP_MIRROR_PRESETS}
            value={mirrorsDraft.pipId}
            customUrl={mirrorsDraft.pipUrl ?? ''}
            onIdChange={(id) => setMirrorsDraft({ ...mirrorsDraft, pipId: id })}
            onUrlChange={(url) => setMirrorsDraft({ ...mirrorsDraft, pipUrl: url })}
          />
          <MirrorSelector
            label="npm 镜像源"
            presets={NPM_MIRROR_PRESETS}
            value={mirrorsDraft.npmId}
            customUrl={mirrorsDraft.npmUrl ?? ''}
            onIdChange={(id) => setMirrorsDraft({ ...mirrorsDraft, npmId: id })}
            onUrlChange={(url) => setMirrorsDraft({ ...mirrorsDraft, npmUrl: url })}
          />
          <div className="flex justify-end">
            <LoadingButton
              loading={savingMirrors}
              onClick={() => {
                void handleSaveMirrors();
              }}
            >
              保存
            </LoadingButton>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface MirrorSelectorProps {
  label: string;
  presets: { id: string; label: string; url: string }[];
  value: string;
  customUrl: string;
  onIdChange: (id: string) => void;
  onUrlChange: (url: string) => void;
}

function MirrorSelector({ label, presets, value, customUrl, onIdChange, onUrlChange }: MirrorSelectorProps) {
  const isCustom = value === CUSTOM_MIRROR_ID;
  const selectedLabel =
    value === CUSTOM_MIRROR_ID
      ? '自定义'
      : presets.find((p) => p.id === value)?.label ?? value;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={(v) => { if (typeof v === 'string') onIdChange(v); }}>
        <SelectTrigger className="w-full">
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {presets.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_MIRROR_ID}>自定义</SelectItem>
        </SelectContent>
      </Select>
      {isCustom ? (
        <Input
          value={customUrl}
          onChange={(e) => onUrlChange((e.target as HTMLInputElement).value)}
          placeholder="https://your-mirror.example/simple"
        />
      ) : null}
    </div>
  );
}
