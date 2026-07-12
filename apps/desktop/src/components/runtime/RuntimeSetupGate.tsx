import { useEffect, useState } from 'react';
import { CpuIcon, DownloadIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { downloadRuntime, getRuntimeStatus, type RuntimeDownloadEvent, type RuntimeKind } from '@/lib/runtime-config';

const SKIP_KEY = 'lf:runtime-setup-skipped';

export function RuntimeSetupGate() {
  const [open, setOpen] = useState(false);
  const [activeKind, setActiveKind] = useState<RuntimeKind | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('准备运行环境');

  useEffect(() => {
    let cancelled = false;
    void getRuntimeStatus().then((status) => {
      if (!cancelled && !status.python.available && !status.node.available && localStorage.getItem(SKIP_KEY) !== '1') setOpen(true);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function onEvent(event: RuntimeDownloadEvent) {
    if (event.event === 'Progress' && event.data.total) setProgress(Math.round(event.data.downloaded / event.data.total * 100));
    if (event.event === 'Stage') setStage(({ downloading: '下载中', verifying: '校验文件', extracting: '解压中', activating: '正在激活' } as Record<string, string>)[event.data.stage] ?? event.data.stage);
  }

  async function installAll() {
    try {
      for (const kind of ['python', 'nodejs'] as RuntimeKind[]) {
        setActiveKind(kind);
        setProgress(0);
        setStage(`准备 ${kind === 'python' ? 'Python' : 'Node.js'}`);
        await downloadRuntime(kind, onEvent);
      }
      localStorage.removeItem(SKIP_KEY);
      setOpen(false);
      toast.success('Python 与 Node.js 已准备完成');
    } catch (error) {
      toast.error(errorMessage(error, '运行时下载失败，可稍后在设置中重试'));
    } finally {
      setActiveKind(null);
    }
  }

  function skip() {
    localStorage.setItem(SKIP_KEY, '1');
    setOpen(false);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-5 backdrop-blur-sm">
      <section className="w-full max-w-xl space-y-6" aria-labelledby="runtime-setup-title">
        <div className="flex size-12 items-center justify-center rounded-lg bg-primary text-primary-foreground"><CpuIcon className="size-6" /></div>
        <div className="space-y-2">
          <h2 id="runtime-setup-title" className="text-2xl font-semibold">准备脚本运行环境</h2>
          <p className="text-sm leading-6 text-muted-foreground">Python 和 Node.js 会按需下载到应用数据目录，不写入系统目录，也不会修改系统 PATH。你也可以先跳过，仅使用 client 插件。</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border p-4"><div className="font-medium">Python 3.12</div><div className="mt-1 text-xs text-muted-foreground">用于 Python 插件和隔离 venv</div></div>
          <div className="rounded-lg border p-4"><div className="font-medium">Node.js 22</div><div className="mt-1 text-xs text-muted-foreground">用于 Node 插件和依赖安装</div></div>
        </div>
        {activeKind && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm"><span>{stage}</span><span>{activeKind === 'python' ? 'Python' : 'Node.js'} · {progress}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${Math.max(progress, 5)}%` }} /></div>
          </div>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={skip} disabled={activeKind !== null}>跳过，先使用 client 插件</Button>
          <Button onClick={() => void installAll()} disabled={activeKind !== null}><DownloadIcon className="size-4" />一键下载</Button>
        </div>
      </section>
    </div>
  );
}
