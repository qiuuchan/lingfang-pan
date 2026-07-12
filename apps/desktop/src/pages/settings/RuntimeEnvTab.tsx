import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { CpuIcon, DownloadIcon, FolderOpenIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingButton } from '@/components/loading-button';
import { errorMessage } from '@/lib/api';
import {
  CUSTOM_MIRROR_ID,
  NPM_MIRROR_PRESETS,
  PIP_MIRROR_PRESETS,
  RUNTIME_LABEL,
  SOURCE_LABEL,
  downloadRuntime,
  formatVersion,
  getRuntimeConfig,
  getRuntimeStatus,
  probeSystemRuntime,
  setMirrorConfig,
  setUserSpecifiedRuntime,
  uninstallRuntime,
  type MirrorConfig,
  type RuntimeConfig,
  type RuntimeDownloadEvent,
  type RuntimeKind,
  type RuntimeStatusMap,
  type SystemRuntimeProbe,
} from '@/lib/runtime-config';

interface DownloadState {
  active: boolean;
  stage: string;
  downloaded: number;
  total: number | null;
}

const EMPTY_DOWNLOAD: DownloadState = { active: false, stage: '', downloaded: 0, total: null };

export function RuntimeEnvTab() {
  const [statusMap, setStatusMap] = useState<RuntimeStatusMap | null>(null);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [mirrorsDraft, setMirrorsDraft] = useState<MirrorConfig>({ pipId: 'tsinghua', npmId: 'npmmirror' });
  const [savingMirrors, setSavingMirrors] = useState(false);
  const [downloads, setDownloads] = useState<Record<RuntimeKind, DownloadState>>({ python: EMPTY_DOWNLOAD, nodejs: EMPTY_DOWNLOAD });
  const [probes, setProbes] = useState<Partial<Record<RuntimeKind, SystemRuntimeProbe>>>({});

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (config) setMirrorsDraft(config.mirrors); }, [config]);

  async function refresh() {
    try {
      const [status, nextConfig] = await Promise.all([getRuntimeStatus(), getRuntimeConfig()]);
      setStatusMap(status);
      setConfig(nextConfig);
    } catch (error) {
      toast.error(errorMessage(error, '加载运行时配置失败'));
    }
  }

  function updateDownload(kind: RuntimeKind, event: RuntimeDownloadEvent) {
    setDownloads((current) => {
      const previous = current[kind];
      if (event.event === 'Started') return { ...current, [kind]: { active: true, stage: '下载中', downloaded: 0, total: event.data.total } };
      if (event.event === 'Progress') return { ...current, [kind]: { active: true, stage: '下载中', downloaded: event.data.downloaded, total: event.data.total } };
      if (event.event === 'Stage') return { ...current, [kind]: { ...previous, active: true, stage: stageLabel(event.data.stage) } };
      return { ...current, [kind]: { ...previous, active: false, stage: '已完成' } };
    });
  }

  async function install(kind: RuntimeKind) {
    setDownloads((current) => ({ ...current, [kind]: { ...EMPTY_DOWNLOAD, active: true, stage: '准备下载' } }));
    try {
      await downloadRuntime(kind, (event) => updateDownload(kind, event));
      toast.success(`${RUNTIME_LABEL[kind]} 已安装并激活`);
      await refresh();
    } catch (error) {
      setDownloads((current) => ({ ...current, [kind]: { ...current[kind], active: false, stage: '失败' } }));
      toast.error(errorMessage(error, `${RUNTIME_LABEL[kind]} 下载失败`));
    }
  }

  async function remove(kind: RuntimeKind) {
    try {
      await uninstallRuntime(kind);
      toast.success(`${RUNTIME_LABEL[kind]} 应用管理版本已卸载`);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, '卸载运行时失败'));
    }
  }

  async function chooseRuntime(kind: RuntimeKind) {
    const selected = await openDialog({ directory: true, multiple: false, title: `选择 ${RUNTIME_LABEL[kind]} 安装目录` });
    if (typeof selected !== 'string') return;
    try {
      await setUserSpecifiedRuntime(kind, selected);
      toast.success(`已使用指定的 ${RUNTIME_LABEL[kind]}`);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, '指定运行时失败'));
    }
  }

  async function inspectSystem(kind: RuntimeKind) {
    try {
      const probe = await probeSystemRuntime(kind);
      setProbes((current) => ({ ...current, [kind]: probe }));
      if (!probe.available) toast.info(`系统 PATH 中未找到 ${RUNTIME_LABEL[kind]}`);
    } catch (error) {
      toast.error(errorMessage(error, '探测系统运行时失败'));
    }
  }

  async function useSystem(kind: RuntimeKind) {
    const probe = probes[kind];
    if (!probe?.path || !probe.meetsMinimum) return;
    try {
      await setUserSpecifiedRuntime(kind, probe.path);
      toast.success(`已显式采用系统 ${RUNTIME_LABEL[kind]}`);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, '采用系统运行时失败'));
    }
  }

  async function clearSpecified(kind: RuntimeKind) {
    try {
      await setUserSpecifiedRuntime(kind, null);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, '恢复应用管理运行时失败'));
    }
  }

  async function saveMirrors() {
    setSavingMirrors(true);
    try {
      await setMirrorConfig(mirrorsDraft);
      toast.success('镜像源已保存');
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, '保存镜像源失败'));
    } finally {
      setSavingMirrors(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-8">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><CpuIcon className="size-5 text-muted-foreground" /><CardTitle>脚本运行环境</CardTitle></div>
          <CardDescription>便携运行时保存在应用数据目录。系统 PATH 仅用于探测，必须由你显式采用后才会执行。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(['python', 'nodejs'] as RuntimeKind[]).map((kind) => {
            const status = statusMap?.[kind === 'nodejs' ? 'node' : 'python'];
            const download = downloads[kind];
            const probe = probes[kind];
            const percent = download.total ? Math.min(100, Math.round(download.downloaded / download.total * 100)) : null;
            return (
              <div key={kind} className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{RUNTIME_LABEL[kind]}</span>
                      {status?.version && <span className="text-sm text-muted-foreground">{formatVersion(RUNTIME_LABEL[kind], status.version)}</span>}
                      <Badge variant={status?.available ? 'default' : 'secondary'}>{status?.source ? SOURCE_LABEL[status.source] : '未安装'}</Badge>
                    </div>
                    {status?.dir && <div className="mt-1 break-all text-xs text-muted-foreground">{status.dir}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void install(kind)} disabled={download.active}><DownloadIcon className="size-4" />{status?.available ? '重装' : '下载'}</Button>
                    <Button size="sm" variant="outline" onClick={() => void chooseRuntime(kind)} disabled={download.active}><FolderOpenIcon className="size-4" />指定目录</Button>
                    <Button size="icon" variant="outline" title="探测系统安装" onClick={() => void inspectSystem(kind)}><RefreshCwIcon className="size-4" /></Button>
                    {status?.source === 'userSpecified' && <Button size="sm" variant="outline" onClick={() => void clearSpecified(kind)}>恢复应用管理</Button>}
                    {status?.source === 'appManaged' && <Button size="icon" variant="destructive" title="卸载" onClick={() => void remove(kind)}><Trash2Icon className="size-4" /></Button>}
                  </div>
                </div>
                {download.active || download.stage ? (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground"><span>{download.stage}</span><span>{percent === null ? formatBytes(download.downloaded) : `${percent}%`}</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: percent === null ? '20%' : `${percent}%` }} /></div>
                  </div>
                ) : null}
                {probe && (
                  <div className="flex flex-col gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                    <span className="break-all">系统探测：{probe.available ? `${probe.version ?? ''} · ${probe.path}` : '未找到'}{probe.available && !probe.meetsMinimum ? '（版本过低）' : ''}</span>
                    {probe.path && probe.meetsMinimum && <Button size="sm" variant="outline" onClick={() => void useSystem(kind)}>采用此版本</Button>}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>镜像源</CardTitle><CardDescription>仅影响本应用启动的插件子进程，不修改系统全局配置。</CardDescription></CardHeader>
        <CardContent className="space-y-6">
          <MirrorSelector label="pip 镜像源" presets={PIP_MIRROR_PRESETS} value={mirrorsDraft.pipId} customUrl={mirrorsDraft.pipUrl ?? ''} onIdChange={(pipId) => setMirrorsDraft({ ...mirrorsDraft, pipId })} onUrlChange={(pipUrl) => setMirrorsDraft({ ...mirrorsDraft, pipUrl })} />
          <MirrorSelector label="npm 镜像源" presets={NPM_MIRROR_PRESETS} value={mirrorsDraft.npmId} customUrl={mirrorsDraft.npmUrl ?? ''} onIdChange={(npmId) => setMirrorsDraft({ ...mirrorsDraft, npmId })} onUrlChange={(npmUrl) => setMirrorsDraft({ ...mirrorsDraft, npmUrl })} />
          <div className="flex justify-end"><LoadingButton loading={savingMirrors} onClick={() => void saveMirrors()}>保存</LoadingButton></div>
        </CardContent>
      </Card>
    </div>
  );
}

function MirrorSelector({ label, presets, value, customUrl, onIdChange, onUrlChange }: { label: string; presets: { id: string; label: string; url: string }[]; value: string; customUrl: string; onIdChange: (id: string) => void; onUrlChange: (url: string) => void }) {
  const selectedLabel = value === CUSTOM_MIRROR_ID ? '自定义' : presets.find((preset) => preset.id === value)?.label ?? value;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={(next) => { if (typeof next === 'string') onIdChange(next); }}>
        <SelectTrigger className="w-full"><SelectValue>{selectedLabel}</SelectValue></SelectTrigger>
        <SelectContent>{presets.map((preset) => <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>)}<SelectItem value={CUSTOM_MIRROR_ID}>自定义</SelectItem></SelectContent>
      </Select>
      {value === CUSTOM_MIRROR_ID && <Input value={customUrl} onChange={(event) => onUrlChange(event.currentTarget.value)} placeholder="https://your-mirror.example/simple" />}
    </div>
  );
}

function stageLabel(stage: string) {
  return ({ downloading: '下载中', verifying: '校验 SHA256', extracting: '解压中', activating: '正在激活' } as Record<string, string>)[stage] ?? stage;
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
