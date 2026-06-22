// SkillsSelector.tsx — 创建器 Skill 选择器（项 14）。
//
// 创建器 header 的「Skill」按钮 + Popover：列出全部 Skill（创建行为类默认开 / 领域专家类按需挂），
// 勾选即拼进创建器 systemPrompt（assembleSystemPrompt），下次 send 生效。选择持久化 lf:active-skills。
//
// Skill 注册表在 lib/skills.ts，新增 Skill 自动可见，无需改本组件。
import { SparklesIcon } from 'lucide-react';
import { useApp } from '@/App';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { SKILLS, type Skill } from '@/lib/skills';

export function SkillsSelector() {
  const { activeSkillIds, toggleSkill } = useApp();
  const behavior = SKILLS.filter((s) => (s.category ?? 'behavior') === 'behavior');
  const domain = SKILLS.filter((s) => s.category === 'domain');

  return (
    <Popover>
      <PopoverTrigger
        render={(props) => (
          <Button {...props} variant="ghost" size="sm" className="gap-1.5" title="选择要激活的 Skill">
            <SparklesIcon className="size-4" />
            <span className="hidden sm:inline">Skill</span>
            {activeSkillIds.length > 0 && (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                {activeSkillIds.length}
              </span>
            )}
          </Button>
        )}
      />
      <PopoverContent className="w-80 p-0" align="end">
        <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
          Skill · 拼进 AI 提示词的能力模块（下次发送生效）
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1">
          <SkillGroup title="创建行为" skills={behavior} activeIds={activeSkillIds} onToggle={toggleSkill} />
          <SkillGroup title="领域专家" skills={domain} activeIds={activeSkillIds} onToggle={toggleSkill} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SkillGroup({
  title,
  skills,
  activeIds,
  onToggle,
}: {
  title: string;
  skills: Skill[];
  activeIds: string[];
  onToggle: (id: string) => void;
}) {
  if (!skills.length) return null;
  return (
    <div className="py-1">
      <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </div>
      {skills.map((s) => {
        const on = activeIds.includes(s.id);
        return (
          <label key={s.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
            <Checkbox checked={on} onCheckedChange={() => onToggle(s.id)} className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{s.name}</span>
              <span className="block text-xs text-muted-foreground">{s.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
