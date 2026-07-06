// QuestionCard.tsx —— AskQuestion 工具的人在环提问卡片。
//
// 从 FloatingCreator.renderQuestionCard 抽取（betav2 阶段4c）。
// 卡片展示问题 + 选项按钮（单选/多选）+ 自由文本输入框。
// 用户作答后调 onAnswer，由父组件 resolve 悬挂的 deferred（agent 循环继续）。
import { CheckCircle2Icon, SendIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export interface QuestionCardProps {
  question: string;
  toolCallId: string;
  options?: { label: string; value: string }[];
  allowFreeText: boolean;
  multiSelect: boolean;
  answer?: string;
  answered: boolean;
  /** 自由文本草稿（受控，按 toolCallId 索引）。 */
  draftText: string;
  /** 多选已选值（受控，按 toolCallId 索引）。 */
  selected: string[];
  /** 作答（单选直接答 label，多选答拼接 label，自由文本答输入）。 */
  onAnswer: (answer: string) => void;
  /** 自由文本草稿变更。 */
  onDraftChange: (text: string) => void;
  /** 多选切换某选项。 */
  onToggleOption: (value: string) => void;
}

export function QuestionCard(props: QuestionCardProps) {
  const { question, options, allowFreeText, multiSelect, answer, answered, draftText, selected, onAnswer, onDraftChange, onToggleOption } = props;
  const submitMulti = () => {
    if (!selected.length) return;
    const labels = selected
      .map((v) => options?.find((o) => o.value === v)?.label ?? v)
      .join('、');
    onAnswer(labels);
  };
  return (
    <div className="rounded-xl border border-[#2a2a2c] bg-[#18181a] p-4 text-[#e8e8eb] shadow-[0_10px_28px_rgba(0,0,0,0.16)]">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-[#2a2a2c] text-[#e5e5e5]">
          <span className="font-mono text-xs font-bold">?</span>
        </div>
        <div className="flex-1 text-sm font-medium">{question}</div>
      </div>
      {answered ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-[#3a3a3d] bg-[#202023] px-3 py-2">
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-[#e5e5e5]" />
          <span className="text-xs text-[#b8b8bd]">已回答：{answer}</span>
        </div>
      ) : (
        <div className="mt-3 space-y-2.5">
          {options && options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {options.map((o) => {
                const on = selected.includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      if (multiSelect) {
                        onToggleOption(o.value);
                      } else {
                        onAnswer(o.label);
                      }
                    }}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${on ? 'border-[#6f6f75] bg-[#2a2a2c] text-[#e5e5e5]' : 'border-[#2a2a2c] bg-[#151517] text-[#a0a0a3] hover:bg-[#2a2a2c] hover:text-[#e5e5e5]'}`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}
          {multiSelect && options && options.length > 0 && (
            <Button size="sm" className="h-8 gap-1.5 rounded-md bg-[#2a2a2c] px-3.5 text-xs text-[#e5e5e5] hover:bg-[#343437] disabled:text-[#6f7076]" disabled={!selected.length} onClick={submitMulti}>
              <CheckCircle2Icon className="size-3.5" />
              确认选择
            </Button>
          )}
          {/* 兜底：allowFreeText 为真，或既无选项也不允许自由输入（防死锁——否则卡片无任何作答控件，deferred 永不 resolve）时，都给自由输入框。 */}
          {(allowFreeText || !(options && options.length > 0)) && (
            <div className="flex items-end gap-2">
              <Textarea
                placeholder="或在此输入你的回答…"
                value={draftText}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onAnswer(draftText); } }}
                rows={1}
                className="min-h-[36px] max-h-24 resize-none rounded-md border-[#2a2a2c] bg-[#151517] font-mono text-sm text-[#e5e5e5] placeholder:text-[#5a5a5c] focus-visible:border-[#3a3a3d] focus-visible:ring-0 dark:bg-[#151517]"
              />
              <Button size="sm" className="h-9 gap-1.5 rounded-md bg-[#2a2a2c] px-3.5 text-xs text-[#e5e5e5] hover:bg-[#343437] disabled:text-[#6f7076]" disabled={!draftText.trim()} onClick={() => onAnswer(draftText)}>
                <SendIcon className="size-3.5" />
                提交
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
