import { useEffect, useState, type ComponentType } from 'react';
import { EyeIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

type ThemeOptionProps = {
  active: boolean;
  onClick: () => void;
  icon: ComponentType<{ className?: string }>;
  label: string;
  desc: string;
};

export function ThemeOption({ active, onClick, icon: Icon, label, desc }: ThemeOptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border p-4 text-left transition-colors ${
        active ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border hover:bg-muted/50'
      }`}
    >
      <Icon className={`size-5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
    </button>
  );
}

type RevealSecretButtonProps = {
  secretKey: 'smtpPass' | 'geetestCaptchaKey';
  label: string;
  hasConfigured: boolean;
};

export function RevealSecretButton({ secretKey, label, hasConfigured }: RevealSecretButtonProps) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setRevealed('');
  }, [open]);

  async function reveal() {
    if (!password) return toast.error('请输入当前管理员密码');
    setLoading(true);
    try {
      const result = await api<{ value: string }>('/api/admin/settings/reveal-secret', {
        method: 'POST',
        body: { password, key: secretKey },
      });
      setRevealed(result.value);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!hasConfigured}
        title={hasConfigured ? '查看明文（需二次密码确认）' : '未配置，无可查看内容'}
        onClick={() => setOpen(true)}
      >
        <EyeIcon className="mr-1 size-3.5" />
        查看
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>查看 {label} 明文</DialogTitle>
            <DialogDescription>
              敏感操作：需输入当前管理员密码二次确认，操作会写入审计日志。
            </DialogDescription>
          </DialogHeader>
          {revealed ? (
            <RevealedSecretContent revealed={revealed} />
          ) : (
            <SecretPasswordForm password={password} onPasswordChange={setPassword} onReveal={reveal} />
          )}
          <RevealSecretFooter revealed={revealed} loading={loading} onClose={() => setOpen(false)} onReveal={reveal} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function RevealedSecretContent({ revealed }: { revealed: string }) {
  return (
    <div className="space-y-2">
      <Label>明文（仅本次可见，关闭后清空）</Label>
      <Input value={revealed} readOnly className="font-mono text-xs" />
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(revealed).then(
            () => toast.success('已复制到剪贴板'),
            () => toast.error('复制失败，请手动选取'),
          );
        }}
      >
        复制
      </Button>
    </div>
  );
}

type SecretPasswordFormProps = {
  password: string;
  onPasswordChange: (password: string) => void;
  onReveal: () => void;
};

function SecretPasswordForm({ password, onPasswordChange, onReveal }: SecretPasswordFormProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="reveal-password">当前管理员密码</Label>
      <Input
        id="reveal-password"
        type="password"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        placeholder="输入你的登录密码"
        onKeyDown={(e) => e.key === 'Enter' && onReveal()}
      />
    </div>
  );
}

type RevealSecretFooterProps = {
  revealed: string;
  loading: boolean;
  onClose: () => void;
  onReveal: () => void;
};

function RevealSecretFooter({ revealed, loading, onClose, onReveal }: RevealSecretFooterProps) {
  return (
    <DialogFooter>
      {revealed ? (
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      ) : (
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onReveal} disabled={loading}>
            {loading ? '验证中…' : '确认查看'}
          </Button>
        </>
      )}
    </DialogFooter>
  );
}
