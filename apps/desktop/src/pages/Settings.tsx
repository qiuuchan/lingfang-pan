import { useState } from 'react';
import { toast } from 'sonner';
import { ServerIcon } from 'lucide-react';
import { useApp } from '@/App';
import { normalizeBackendUrl, testBackendUrl } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/loading-button';

export function Settings() {
  const { backendUrl, saveBackendUrl, resetSession } = useApp();
  const [backendInput, setBackendInput] = useState(backendUrl || '');
  const [testingBackend, setTestingBackend] = useState(false);
  const [savingBackend, setSavingBackend] = useState(false);

  async function testBackend() {
    const normalized = normalizeBackendUrl(backendInput);
    if (!normalized) return toast.error('请输入以 http:// 或 https:// 开头的后端地址');
    setTestingBackend(true);
    try {
      await testBackendUrl(normalized);
      toast.success('后端连接正常');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestingBackend(false);
    }
  }

  async function saveBackend() {
    const normalized = normalizeBackendUrl(backendInput);
    if (!normalized) return toast.error('请输入以 http:// 或 https:// 开头的后端地址');
    setSavingBackend(true);
    try {
      await testBackendUrl(normalized);
      const changed = normalized !== backendUrl;
      if (!saveBackendUrl(normalized)) return toast.error('后端地址格式不正确');
      setBackendInput(normalized);
      if (changed) {
        resetSession();
        toast.success('后端地址已保存，请重新登录');
      } else {
        toast.success('后端地址已保存');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingBackend(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Card className="w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ServerIcon className="size-5 text-primary" />
            <CardTitle>后端服务地址</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="text-sm text-muted-foreground">
            当前地址：<span className="font-mono text-foreground">{backendUrl || '未配置'}</span>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="backendServiceUrl">后端 URL</Label>
            <Input
              id="backendServiceUrl"
              placeholder="例如 http://127.0.0.1:3000 或 https://api.example.com"
              value={backendInput}
              onChange={(e) => setBackendInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveBackend()}
            />
          </div>
          <div className="flex items-center gap-2">
            <LoadingButton variant="outline" loading={testingBackend} onClick={testBackend}>测试连接</LoadingButton>
            <LoadingButton loading={savingBackend} onClick={saveBackend}>测试并保存</LoadingButton>
          </div>
          <p className="text-xs text-muted-foreground">
            切换到另一套后端时当前登录态会失效，保存后需要重新登录。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}