import { SendIcon, SquareIcon, GaugeIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  capitalizeModel,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  type EffortLevel,
} from '@/lib/plugin-draft';

// R2 思考强度选择器：claude 透传 --effort；codex/opencode 无对应参数（忽略，仅 claude 生效）。
// 「不思考」对应该 CLI 不开启 extended thinking；medium 为推荐档。
// effort 随每轮 send 传（start_session + send_input 都带，可会话中途调）。
const EFFORT_OFF: EffortLevel = 'none';

export function Composer({
  input,
  model,
  provider,
  providerInfo,
  providers,
  streaming,
  effort,
  onInputChange,
  onModelChange,
  onProviderChange,
  onEffortChange,
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
  onInputChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onEffortChange: (value: EffortLevel) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div>
      <div className="rounded-xl border bg-background p-3 shadow-sm">
        <Textarea
          placeholder="描述你想创建的插件，例如：帮我做一个能整理会议纪要并生成行动项的插件。"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          className="max-h-44 min-h-20 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select disabled={streaming} value={provider} onValueChange={(value) => onProviderChange(value || providers[0]?.id || provider)}>
              <SelectTrigger className="h-8 w-[150px]"><SelectValue>{providerInfo.label}</SelectValue></SelectTrigger>
              <SelectContent>{providers.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
            {/* R1 模型名首字母大写：SelectValue 显示用 capitalizeModel，SelectItem 同步大写展示。 */}
            <Select disabled={streaming} value={model} onValueChange={(value) => onModelChange(value || providerInfo.models[0])}>
              <SelectTrigger className="h-8 w-[150px]"><SelectValue>{capitalizeModel(model)}</SelectValue></SelectTrigger>
              <SelectContent>{providerInfo.models.map((item) => <SelectItem key={item} value={item}>{capitalizeModel(item)}</SelectItem>)}</SelectContent>
            </Select>
            {/* R2 思考强度：仅 claude 生效（codex/opencode 传了也忽略，标注提示）。 */}
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
