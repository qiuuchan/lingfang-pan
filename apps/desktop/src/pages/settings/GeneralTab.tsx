// GeneralTab.tsx — 通用设置（项 11）：关窗行为等应用级偏好。
//
// 设置页「通用」sub-tab。目前承载「关闭窗口时」行为选择（最小化到托盘 / 直接退出 / 每次询问），
// 读写 lf:close-action，与 App.tsx 的 close-requested 监听 + CloseBehaviorDialog 联动。
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { loadCloseAction, saveCloseAction, type CloseAction } from '@/lib/close-behavior';

const OPTIONS: { value: CloseAction; label: string }[] = [
  { value: 'ask', label: '每次询问' },
  { value: 'tray', label: '最小化到托盘（后台运行）' },
  { value: 'quit', label: '直接退出' },
];

export function GeneralTab() {
  const [action, setAction] = useState<CloseAction>(loadCloseAction);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>通用</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor="close-action">关闭窗口时</Label>
        <Select
          value={action}
          onValueChange={(value) => {
            const next = value as CloseAction;
            setAction(next);
            saveCloseAction(next);
          }}
        >
          <SelectTrigger id="close-action" className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          选「最小化到托盘」时，关闭窗口后应用在后台继续运行，可单击系统托盘图标恢复。
        </p>
      </CardContent>
    </Card>
  );
}
