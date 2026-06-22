// CloseBehaviorDialog.tsx — 关窗询问悬浮窗（项 11）。
//
// 主窗口 close-requested 且偏好为 'ask' 时弹出。三选项：
// - 最小化到托盘：隐藏窗口，进程保留（后台运行）。
// - 直接退出：结束进程。
// - 取消（X/Esc/遮罩）：什么都不做，窗口保持打开。
// 「以后不再询问」勾选后，本次选择写入 lf:close-action，下次直接执行不再弹。
import { useState } from 'react';
import { MinusIcon, LogOutIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { saveCloseAction } from '@/lib/close-behavior';

export function CloseBehaviorDialog({
  open,
  onChoose,
}: {
  open: boolean;
  /** 用户做出选择（tray/quit/cancel）。cancel = 取消，窗口保持打开。 */
  onChoose: (action: 'tray' | 'quit' | 'cancel') => void;
}) {
  const [remember, setRemember] = useState(false);

  function choose(action: 'tray' | 'quit') {
    if (remember) saveCloseAction(action);
    onChoose(action);
    // 复位：下次打开默认不勾
    setRemember(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // 关闭（X/Esc/遮罩）= 取消，窗口保持打开。
        if (!o) onChoose('cancel');
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>关闭窗口</DialogTitle>
          <DialogDescription>是否最小化到托盘？最小化后应用在后台继续运行，可从托盘图标恢复。</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(Boolean(v))} />
          以后不再询问（按本次选择执行）
        </label>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => choose('tray')}>
            <MinusIcon className="size-4" /> 最小化到托盘
          </Button>
          <Button variant="destructive" onClick={() => choose('quit')}>
            <LogOutIcon className="size-4" /> 直接退出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
