import { useRef, useState } from 'react';
import { SendIcon, SquareIcon, GaugeIcon, AtSignIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  capitalizeModel,
  CUSTOM_MODEL_SENTINEL,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  type EffortLevel,
} from '@/lib/plugin-draft';

// 思考强度选择器：保留用户偏好字段，SDK runtime 当前不映射 provider 私有参数。
// 「不思考」对应该 CLI 不开启 extended thinking；medium 为推荐档。
// effort 随每轮 send 传（start_session + send_input 都带，可会话中途调）。
const EFFORT_OFF: EffortLevel = 'none';

/** @引用的插件项（id + name + manifest 摘要，send 时拼进 prompt）。 */
export type MentionPlugin = { id: string; name: string; summary: string };

export function Composer({
  input,
  model,
  provider,
  providerInfo,
  providers,
  streaming,
  effort,
  attachedPlugins,
  mentionablePlugins,
  onAttach,
  onDetach,
  onInputChange,
  onModelChange,
  onProviderChange,
  onEffortChange,
  onCustomModel,
  onSend,
  onStop,
}: {
  input: string;
  model: string;
  provider: string;
  providerInfo: { id: string; label: string; models: string[] };
  providers: { id: string; label: string; models: string[] }[];
  streaming: boolean;
  effort: EffortLevel;
  attachedPlugins: MentionPlugin[];
  mentionablePlugins: MentionPlugin[];
  onAttach: (plugin: MentionPlugin) => void;
  onDetach: (id: string) => void;
  onInputChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onEffortChange: (value: EffortLevel) => void;
  // R1「自定义…」：不再就地展开输入框，改为跳转到设置页（gateway tab）让用户配置上游模型。
  onCustomModel: () => void;
  onSend: () => void;
  onStop: () => void;
}) {
  // R1 模型来源纯运行时（SDK provider catalog + 上游配置），无硬编码预设。
  // selectValue：有模型则显示当前选中，无模型（空态）显示哨兵驱动空态提示项。
  const hasModels = providerInfo.models.length > 0;
  const selectValue = hasModels ? (model || providerInfo.models[0]) : CUSTOM_MODEL_SENTINEL;

  // B @触发：输入 @ 时弹插件选择 Popover。mentionQuery 是 @ 后的筛选词。
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 检测 input 末尾是否在输入 @引用（@ 后无空格、未结束）。
  function handleInputChange(value: string) {
    onInputChange(value);
    // 找最后一个 @，其后无空格 = 正在输入引用词。
    const lastAt = value.lastIndexOf('@');
    if (lastAt !== -1) {
      const after = value.slice(lastAt + 1);
      if (!after.includes(' ') && !after.includes('\n')) {
        setMentionQuery(after);
        setMentionOpen(true);
        return;
      }
    }
    setMentionOpen(false);
  }

  // 选中插件：移除 input 里的 @标记词，插入 @<name>，记录引用。
  function pickPlugin(plugin: MentionPlugin) {
    const lastAt = input.lastIndexOf('@');
    if (lastAt !== -1) {
      const before = input.slice(0, lastAt);
      const after = input.slice(lastAt + 1 + mentionQuery.length);
      onInputChange(`${before}@${plugin.name} ${after}`);
    }
    onAttach(plugin);
    setMentionOpen(false);
    setMentionQuery('');
    textareaRef.current?.focus();
  }

  const filteredMentions = mentionablePlugins
    .filter((p) => p.name.toLowerCase().includes(mentionQuery.toLowerCase()))
    .filter((p) => !attachedPlugins.some((a) => a.id === p.id))
    .slice(0, 8);

  return (
    <div>
      <div className="rounded-xl border bg-background p-3 shadow-sm">
        {/* B 已引用插件 chip 展示（可移除）。 */}
        {attachedPlugins.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedPlugins.map((p) => (
              <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                <AtSignIcon className="size-3" />
                {p.name}
                <button type="button" onClick={() => onDetach(p.id)} className="ml-0.5 rounded-full hover:bg-primary/20">
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* @触发下拉列表：相对 Textarea 容器绝对定位（避免 Popover API 差异）。 */}
        <div className="relative">
          <Textarea
            ref={textareaRef}
            placeholder="描述你想创建的插件，例如：帮我做一个能整理会议纪要并生成行动项的插件…"
            value={input}
            onChange={(event) => handleInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (mentionOpen) return; // @选择打开时 Enter 不发送（避免误触）
                onSend();
              }
            }}
            className="max-h-44 min-h-20 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
          />
          {mentionOpen && filteredMentions.length > 0 && (
            <div className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
              <div className="max-h-60 overflow-auto">
                {filteredMentions.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => pickPlugin(p)}
                    className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                  >
                    <span className="font-medium">@{p.name}</span>
                    <span className="text-muted-foreground">{p.summary}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select disabled={streaming} value={provider} onValueChange={(value) => onProviderChange(value || providers[0]?.id || provider)}>
              <SelectTrigger className="h-8 w-[150px]"><SelectValue>{providerInfo.label}</SelectValue></SelectTrigger>
              <SelectContent>{providers.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
            {/* R1 模型来源纯运行时（SDK provider catalog + 上游配置）：SelectValue 显示当前模型，列表无硬编码预设。 */}
            {/* 「自定义…」不再就地展开输入框，改为跳转到设置页（gateway tab）配置上游模型（onCustomModel）。 */}
            <Select
              disabled={streaming}
              value={selectValue}
              onValueChange={(value) => {
                if (value === CUSTOM_MODEL_SENTINEL) {
                  // 选中「自定义…」/ 空态项：跳设置页配置模型，不改 model 值。
                  onCustomModel();
                  return;
                }
                onModelChange(value || providerInfo.models[0]);
              }}
            >
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue>{hasModels ? capitalizeModel(model || providerInfo.models[0]) : '未配置模型'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providerInfo.models.map((item) => <SelectItem key={item} value={item}>{capitalizeModel(item)}</SelectItem>)}
                {/* 空态：无可用模型时显示引导项（选中跳设置）；有模型时尾加「自定义…」也跳设置。 */}
                {!hasModels && <SelectItem value={CUSTOM_MODEL_SENTINEL}>未配置可用模型，去设置…</SelectItem>}
                {hasModels && <SelectItem value={CUSTOM_MODEL_SENTINEL}>自定义…</SelectItem>}
              </SelectContent>
            </Select>
            {/* 思考强度：当前作为用户偏好字段保留。 */}
            <Select disabled={streaming} value={effort} onValueChange={(value) => onEffortChange((value as EffortLevel) || EFFORT_OFF)}>
              <SelectTrigger className="h-8 w-[130px]" title="思考强度（仅 Claude 生效）">
                <span className="flex items-center gap-1"><GaugeIcon className="size-3.5 opacity-70" /><SelectValue>{EFFORT_LABEL[effort]}</SelectValue></span>
              </SelectTrigger>
              <SelectContent>
                {EFFORT_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>{EFFORT_LABEL[level]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Task 11：精简的快捷键提示（替代原 placeholder 里冗长的 @ 说明）。 */}
            <span className="hidden text-[11px] text-muted-foreground/70 sm:inline">
              <kbd className="rounded border bg-muted px-1">@</kbd> 引用插件 · <kbd className="rounded border bg-muted px-1">Enter</kbd> 发送
            </span>
          </div>
          {streaming ? (
            <Button variant="destructive" onClick={onStop}>
              <SquareIcon className="size-4" />
              停止
            </Button>
          ) : (
            <Button onClick={() => onSend()} disabled={!input.trim()}>
              <SendIcon className="size-4" />
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
