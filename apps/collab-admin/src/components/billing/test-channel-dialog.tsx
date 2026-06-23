// TestChannelDialog —— 渠道测试对话框：连通性 + 实对话(CHAT) + 生图(IMAGE)，按渠道 kind 自动给对应段。
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2Icon } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Channel } from '@/lib/types';

export function TestChannelDialog({ channel, onDone, onClose }: { channel: Channel; onDone: () => void; onClose: () => void }) {
  const isImage = channel.kind === 'IMAGE';
  const [conn, setConn] = useState<{ loading: boolean; ok: boolean | null; message: string; models: string[] }>({ loading: true, ok: null, message: '', models: [] });
  const [model, setModel] = useState('');
  const [chat, setChat] = useState<{ loading: boolean; ok: boolean | null; message: string; reply: string; latencyMs: number }>({ loading: false, ok: null, message: '', reply: '', latencyMs: 0 });
  const [imgPrompt, setImgPrompt] = useState('a red circle on white background');
  const [img, setImg] = useState<{ loading: boolean; ok: boolean | null; message: string; imageUrl: string | null; latencyMs: number }>({ loading: false, ok: null, message: '', imageUrl: null, latencyMs: 0 });

  useEffect(() => {
    let mounted = true;
    setConn({ loading: true, ok: null, message: '', models: [] });
    api<{ ok: boolean; message: string; models: string[] }>(`/api/admin/billing/channels/${channel.id}/test`, { method: 'POST' })
      .then((r) => { if (mounted) { setConn({ loading: false, ok: r.ok, message: r.message, models: r.models ?? [] }); if (r.models?.length) setModel(r.models[0]); } })
      .catch((e: Error) => { if (mounted) setConn({ loading: false, ok: false, message: e.message || '请求失败', models: [] }); });
    return () => { mounted = false; };
  }, [channel.id]);
  useEffect(() => { if (conn.ok !== null && !conn.loading) onDone(); /* eslint-disable-next-line */ }, [conn.ok, conn.loading]);

  async function runChat() {
    if (!model) return;
    setChat({ loading: true, ok: null, message: '', reply: '', latencyMs: 0 });
    try { const r = await api<{ ok: boolean; message: string; reply: string; latencyMs: number }>(`/api/admin/billing/channels/${channel.id}/test-chat`, { method: 'POST', body: { model } }); setChat({ loading: false, ok: r.ok, message: r.message, reply: r.reply, latencyMs: r.latencyMs }); }
    catch (e) { setChat({ loading: false, ok: false, message: (e as Error).message, reply: '', latencyMs: 0 }); }
  }
  async function runImage() {
    if (!model) return;
    setImg({ loading: true, ok: null, message: '', imageUrl: null, latencyMs: 0 });
    try { const r = await api<{ ok: boolean; message: string; imageUrl: string | null; latencyMs: number }>(`/api/admin/billing/channels/${channel.id}/test-image`, { method: 'POST', body: { model, prompt: imgPrompt } }); setImg({ loading: false, ok: r.ok, message: r.message, imageUrl: r.imageUrl, latencyMs: r.latencyMs }); }
    catch (e) { setImg({ loading: false, ok: false, message: (e as Error).message, imageUrl: null, latencyMs: 0 }); }
  }

  const models = [...conn.models, ...channel.models.filter((m) => !conn.models.includes(m))];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>测试渠道 · {channel.name}</DialogTitle>
          <DialogDescription>{channel.kind === 'CHAT' ? '聊天' : '生图'}渠道 · {channel.protocol} · {channel.baseUrl}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* ① 连通性 */}
          <div className="space-y-1">
            <div className="text-sm font-medium">① 连通性（models 端点）</div>
            {conn.loading ? <div className="text-sm text-muted-foreground flex items-center gap-1"><Loader2Icon className="size-3 animate-spin" />探测中…</div> : (
              <div className="flex items-start gap-2 text-sm">{conn.ok ? <span className="text-green-600">✓ 成功</span> : <span className="text-red-600">✗ 失败</span>}<span className="text-muted-foreground">{conn.message}</span></div>
            )}
          </div>
          {/* ② 实对话（仅 CHAT）或 生图（仅 IMAGE）*/}
          <div className="space-y-2">
            <div className="text-sm font-medium">{isImage ? '② 生图验证' : '② 实对话验证（hi）'}</div>
            <div className="flex gap-2">
              <Select value={model} onValueChange={setModel} disabled={models.length === 0}>
                <SelectTrigger className="flex-1"><SelectValue placeholder={models.length ? '选模型' : '无可用模型'} /></SelectTrigger>
                <SelectContent>{models.map((m) => <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" onClick={isImage ? runImage : runChat} disabled={(isImage ? img.loading : chat.loading) || !model}>{isImage ? (img.loading ? '生成中…' : '生成测试图') : (chat.loading ? '发送中…' : '发送 hi')}</Button>
            </div>
            {isImage && <Input value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} placeholder="prompt" />}
            {(isImage ? img : chat).ok !== null && !(isImage ? img : chat).loading && (
              <div className={`rounded-md border p-2 text-sm ${(isImage ? img : chat).ok ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950' : 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'}`}>
                <div className="flex items-center gap-2">
                  {(isImage ? img : chat).ok ? <span className="text-green-600">✓ {(isImage ? img : chat).message}</span> : <span className="text-red-600">✗ {(isImage ? img : chat).message}</span>}
                  {(isImage ? img : chat).ok && <span className="text-xs text-muted-foreground tabular-nums">{(isImage ? img : chat).latencyMs} ms</span>}
                </div>
                {!isImage && chat.reply && <div className="mt-1 text-muted-foreground">回复：{chat.reply}</div>}
                {isImage && img.imageUrl && <img src={img.imageUrl} alt="测试图" className="mt-2 max-h-48 rounded border" />}
              </div>
            )}
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
