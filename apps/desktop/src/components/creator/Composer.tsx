import { SendIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

export function Composer({
  input,
  model,
  provider,
  providerInfo,
  providers,
  streaming,
  onInputChange,
  onModelChange,
  onProviderChange,
  onSend,
  onStop,
}: {
  input: string;
  model: string;
  provider: string;
  providerInfo: { id: string; label: string; models: string[] };
  providers: { id: string; label: string; models: string[] }[];
  streaming: boolean;
  onInputChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div>
      <div className="rounded-xl border bg-background p-3 shadow-sm">
        <Textarea
          placeholder="自然描述你想创建的插件，例如：帮我做一个能整理会议纪要并生成行动项的插件。"
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
            <Select disabled={streaming} value={model} onValueChange={(value) => onModelChange(value || providerInfo.models[0])}>
              <SelectTrigger className="h-8 w-[150px]"><SelectValue>{model === 'default' ? '默认模型' : model}</SelectValue></SelectTrigger>
              <SelectContent>{providerInfo.models.map((item) => <SelectItem key={item} value={item}>{item === 'default' ? '默认模型' : item}</SelectItem>)}</SelectContent>
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