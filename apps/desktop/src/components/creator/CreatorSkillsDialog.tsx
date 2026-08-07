// CreatorSkillsDialog.tsx —— 技能（Skills）选择弹窗。
//
// 从 CreatorWorkspace 抽取（betav2 阶段4c）。勾选技能动态拼装进系统提示词。
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SKILLS } from '@/lib/skills';

export interface CreatorSkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeSkillIds: string[];
  onToggle: (id: string) => void;
}

export function CreatorSkillsDialog({
  open,
  onOpenChange,
  activeSkillIds,
  onToggle,
}: CreatorSkillsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>技能</DialogTitle>
          <DialogDescription>按需开启，让 AI 生成更符合预期的插件。</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[56vh] flex-col gap-2 overflow-y-auto">
          {SKILLS.map((s) => {
            const checked = activeSkillIds.includes(s.id);
            return (
              <label
                key={s.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'}`}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => onToggle(s.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{s.description}</div>
                </div>
              </label>
            );
          })}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
