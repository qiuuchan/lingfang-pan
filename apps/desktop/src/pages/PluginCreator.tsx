// PluginCreator —— relay 版插件创建器（替代已删除的 code_assistant CLI 创建器）。
//
// 流程：用户输入自然语言描述 → 调 /api/relay/v1/chat/completions（fast/premium，扣团队灵石）
// → AI 返回 ```lingfang-plugin 代码块 → 解析为 {manifest, files} → 预览文件 + 上传到团队云端。
//
// 与旧 CLI 创建器的区别：AI 调用走平台 relay（SDK/HTTP），不再 spawn ClaudeCode/Codex 子进程；
// 计费/日志/系统提示词规则注入统一由 relay 承担（见 docs/billing-and-relay-design.md）。
import { useState } from 'react';
import { toast } from 'sonner';
import { WandSparklesIcon, UploadIcon, RefreshCwIcon, FileCode2Icon } from 'lucide-react';
import { useApp } from '@/App';
import { api, type ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { LoadingButton } from '@/components/loading-button';
import { createPlugin, uploadCreatedPlugin, type CreatedPluginPackage } from '@/lib/plugin-creator/relay-creator';

const EXAMPLES = [
  { icon: '⏱️', title: '番茄钟', prompt: '做一个番茄钟插件，可设置 25/45 分钟、暂停继续、完成后提醒' },
  { icon: '📝', title: 'Markdown 速记', prompt: '一个 Markdown 速记插件，左侧编辑右侧实时预览，支持复制导出' },
  { icon: '🎨', title: '配色生成', prompt: '一个配色方案生成插件，输入主题给出一组和谐颜色和预览' },
];

export function PluginCreator() {
  const { session } = useApp();
  const [prompt, setPrompt] = useState('');
  const [tier, setTier] = useState<'fast' | 'premium'>('fast');
  const [loading, setLoading] = useState(false);
  const [pkg, setPkg] = useState<CreatedPluginPackage | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function generate() {
    if (!prompt.trim()) return toast.error('请描述你想做的插件');
    setLoading(true);
    setPkg(null);
    try {
      const result = await createPlugin({ prompt: prompt.trim(), tier });
      setPkg(result);
      setActiveFile(result.files[0]?.path ?? null);
      toast.success('插件已生成，预览后可上传');
    } catch (e) {
      toast.error((e as ApiError).message || '生成失败');
    } finally {
      setLoading(false);
    }
  }

  async function upload() {
    if (!pkg) return;
    setUploading(true);
    try {
      await uploadCreatedPlugin(pkg);
      toast.success(`插件「${pkg.manifest.name}」已上传到团队空间`);
      setPkg(null);
      setPrompt('');
    } catch (e) {
      toast.error((e as ApiError).message || '上传失败');
    } finally {
      setUploading(false);
    }
  }

  const activeContent = pkg?.files.find((f) => f.path === activeFile)?.content ?? '';

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><WandSparklesIcon className="size-5 text-primary" />AI 创建插件</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">用自然语言描述插件，AI 经平台中转生成（扣团队灵石）。底层模型由后台配置。</p>
          {/* 样例 */}
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button key={ex.title} type="button" onClick={() => setPrompt(ex.prompt)} className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors hover:bg-muted">
                <span>{ex.icon}</span><span>{ex.title}</span>
              </button>
            ))}
          </div>
          {/* 版本切换 */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">版本：</span>
            {(['fast', 'premium'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTier(t)} className={`rounded-md border px-3 py-1 text-sm transition-colors ${tier === t ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}>
                {t === 'fast' ? '⚡ 快速版' : '✦ 高级版'}
              </button>
            ))}
          </div>
          <Textarea
            placeholder="例如：做一个番茄钟插件，可设置 25/45 分钟、暂停继续、完成后提醒…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
          />
          <LoadingButton loading={loading} onClick={generate} className="w-full">
            <WandSparklesIcon className="mr-1.5 size-4" />{loading ? '生成中…' : '生成插件'}
          </LoadingButton>
        </CardContent>
      </Card>

      {pkg && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2"><FileCode2Icon className="size-5 text-primary" />{pkg.manifest.name}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={generate} disabled={loading}><RefreshCwIcon className="mr-1 size-3.5" />重新生成</Button>
                <LoadingButton loading={uploading} size="sm" onClick={upload}><UploadIcon className="mr-1 size-3.5" />上传到团队</LoadingButton>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">{pkg.manifest.runtime_type}</Badge>
              <Badge variant="outline">{pkg.manifest.entry}</Badge>
              <span className="text-muted-foreground">v{pkg.manifest.version}</span>
              <span className="text-muted-foreground">{pkg.files.length} 个文件</span>
              <span className="text-xs text-muted-foreground">归属团队：{session.tenantName ?? '当前团队'}</span>
            </div>
            {pkg.manifest.description && <p className="mb-3 text-sm text-muted-foreground">{pkg.manifest.description}</p>}
            <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
              {/* 文件树 */}
              <div className="rounded-lg border p-2">
                <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">文件</div>
                <div className="space-y-0.5">
                  {pkg.files.map((f) => (
                    <button key={f.path} type="button" onClick={() => setActiveFile(f.path)} className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-xs ${activeFile === f.path ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`} title={f.path}>
                      {f.path}
                    </button>
                  ))}
                </div>
              </div>
              {/* 文件内容 */}
              <div className="max-h-[50vh] overflow-auto rounded-lg border bg-muted/30 p-3">
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">{activeContent}</pre>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
