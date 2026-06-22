// 角色编辑/创建对话框公共组件：名称 + 编码 + 描述 + 权限勾选面板（复用 PermissionChecklist）。
// 供平台角色管理（roles-view）与团队角色管理（teams-view 团队详情「角色」tab）复用。
//
// 设计：
//  - 受控 open（onClose 关闭）；传入 role 表示编辑（含 isSystem 锁定），不传表示创建。
//  - onSubmit：调用方提供提交函数（创建 POST / 更新 PATCH 各自对应后端端点），返回 Promise<boolean>。
//    抽组件的关键：不同 scope 的提交 URL/方法不同，由调用方注入，组件内部不关心后端路径。
//  - 系统角色（isSystem=true）：编码 + 权限锁定（后端也会拒绝），仅可改 name/description。
//  - code 校验正则与后端 ROLE_CODE_PATTERN 一致（小写字母/数字开头，可含下划线/连字符）。
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ShieldCheckIcon } from 'lucide-react';
import { run } from '@/lib/helpers';
import type { PermissionEntry, Role } from '@/lib/types';
import { PermissionChecklist } from '@/components/role-permission-checklist';

const ROLE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 角色编辑/创建对话框（平台/团队通用）。
 *  - onSubmit：调用方注入提交逻辑，成功返回 true（组件内部已用 run 包裹做 toast 反馈）。
 *  - title/titleVerb：标题与按钮文案（创建/保存），供不同调用方语义化展示。 */
export function RoleEditDialog({
  role,
  permissions,
  groupLabelOverride,
  title,
  description,
  onClose,
  onSubmit,
}: {
  role?: Role | null;
  permissions: PermissionEntry[];
  groupLabelOverride: Map<string, string>;
  title: string;
  description?: string;
  onClose: () => void;
  onSubmit: (body: { name?: string; code?: string; description?: string; permissions?: string[] }) => Promise<boolean>;
}) {
  const isSystem = role?.isSystem ?? false;
  const [name, setName] = useState(role?.name ?? '');
  const [code, setCode] = useState(role?.code ?? '');
  const [descriptionText, setDescriptionText] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));

  function toggle(c: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  function toggleAll(codes: string[]) {
    setSelected((prev) => {
      const allOn = codes.every((c) => prev.has(c));
      const next = new Set(prev);
      if (allOn) codes.forEach((c) => next.delete(c));
      else codes.forEach((c) => next.add(c));
      return next;
    });
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error('角色名不能为空');
      return;
    }
    const trimmedCode = code.trim();
    if (trimmedCode && !ROLE_CODE_PATTERN.test(trimmedCode)) {
      toast.error('编码只能包含小写字母、数字、下划线、连字符，须以字母或数字开头');
      return;
    }
    const body = {
      name: name.trim(),
      // 系统角色不允许改权限/编码（后端会拒绝），这里也不传 code/permissions 字段
      ...(isSystem ? {} : { code: trimmedCode || undefined, permissions: [...selected] }),
    };
    if (!(await run(() => onSubmit(body), role ? '角色已更新' : '角色已创建'))) return;
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <ShieldCheckIcon className="size-5" />
            {title}
          </DialogTitle>
          {description ? (
            <DialogDescription>
              {isSystem ? '内置角色权限/编码锁定不可修改，仅可调整名称与说明。' : description}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>角色名</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="如：运营专员" />
            </div>
            <div className="space-y-2">
              <Label>编码{isSystem && <span className="ml-1 text-xs text-muted-foreground">（内置锁定）</span>}</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={64}
                placeholder="如：operator"
                disabled={isSystem}
              />
              <p className="text-xs text-muted-foreground">小写字母/数字开头，可含下划线、连字符。同 scope 下唯一。</p>
            </div>
          </div>
          <div className="space-y-2">
            <Label>说明</Label>
            <Textarea value={descriptionText} onChange={(e) => setDescriptionText(e.target.value)} maxLength={255} rows={2} placeholder="描述该角色的职责" />
          </div>

          <PermissionChecklist
            permissions={permissions}
            groupLabelOverride={groupLabelOverride}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            lock={isSystem}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave}>{role ? '保存' : '创建'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
