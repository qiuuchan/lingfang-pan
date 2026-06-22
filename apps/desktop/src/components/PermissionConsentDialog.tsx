// PermissionConsentDialog.tsx — Task 14 系统级权限运行时确认框。
//
// 监听 'lf:permission-request' 事件（由 requestSystemPermission 派发），弹出 shadcn Dialog
// 让用户授权/拒绝。勾选「记住选择」时记忆到 localStorage，下次同插件同权限不再弹。
import { useEffect, useState } from 'react';
import { ShieldAlertIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { rememberDecision, type PermissionRequest } from '@/lib/plugin-permissions';

export function PermissionConsentDialog() {
  const [req, setReq] = useState<PermissionRequest | null>(null);
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PermissionRequest>).detail;
      if (detail && typeof detail.resolve === 'function') {
        setReq(detail);
        setRemember(true);
      }
    };
    window.addEventListener('lf:permission-request', handler as EventListener);
    return () => window.removeEventListener('lf:permission-request', handler as EventListener);
  }, []);

  const close = (decision: 'granted' | 'denied') => {
    if (!req) return;
    if (remember) rememberDecision(req.pluginId, req.code, decision);
    req.resolve(decision);
    setReq(null);
  };

  // 取消（点遮罩/Esc）按拒绝处理（保守：不授权）。
  const onOpenChange = (open: boolean) => {
    if (!open && req) close('denied');
  };

  return (
    <Dialog open={Boolean(req)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-5 text-amber-500" />
            权限请求
          </DialogTitle>
          <DialogDescription>
            插件「<span className="font-medium text-foreground">{req?.pluginName}</span>」请求系统级权限，请确认是否允许。
          </DialogDescription>
        </DialogHeader>
        {req && (
          <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">权限</span>
              <code className="font-mono text-xs text-foreground">{req.code}</code>
            </div>
            <div className="text-xs leading-relaxed text-muted-foreground">{req.reason}</div>
          </div>
        )}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(Boolean(v))} />
          记住选择（下次不再询问）
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => close('denied')}>
            拒绝
          </Button>
          <Button variant="default" onClick={() => close('granted')}>
            允许
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
