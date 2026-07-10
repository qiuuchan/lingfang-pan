// PluginLogPanel.tsx — 插件启动全流程的实时输出日志面板。
//
// 展示 plugin:output 事件逐行流（venv 创建 / pip install / python 运行 stdout+stderr）。
// 深色终端风格，自动滚到底（用户上滚则暂停跟随），stderr 行红色着色。
// 与 ScriptPreviewPanel 的 persistentRun 状态机集成：starting/running/error 阶段都显示。
import { useEffect, useRef, useState } from 'react';
import type { PluginOutputEvent } from '../../lib/plugin-status';
import { CopyIcon, CheckIcon } from 'lucide-react';

export interface LogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

interface PluginLogPanelProps {
  lines: LogLine[];
  /** 是否自动滚到底（用户上滚后传 false 暂停跟随）。 */
  autoScroll?: boolean;
}

export function PluginLogPanel({ lines, autoScroll = true }: PluginLogPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // autoScroll 时，lines 变化自动滚到底。
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleCopy = async () => {
    const text = lines.map((l) => l.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默（无 clipboard 权限/非安全上下文）。
    }
  };

  return (
    <div className="relative flex flex-col">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">实时输出</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="复制全部"
          >
            {copied ? <CheckIcon className="size-3 text-emerald-500" /> : <CopyIcon className="size-3" />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="scrollbar-thin max-h-80 min-h-[8rem] overflow-auto rounded-lg bg-[#0d1117] p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <span className="text-[#8b949e]">（等待输出…）</span>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={
                line.stream === 'stderr'
                  ? 'whitespace-pre-wrap break-words text-[#ff7b72]'
                  : 'whitespace-pre-wrap break-words text-[#e6edf3]'
              }
            >
              {line.text || '\u00A0'}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 把 PluginOutputEvent 累积成 LogLine[] 的 hook（自动滚动跟随由 PluginLogPanel 处理）。 */
export function useLogBuffer() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const append = (e: PluginOutputEvent) => {
    setLines((prev) => [...prev, { stream: e.stream, text: e.line }]);
  };
  const clear = () => setLines([]);
  return { lines, append, clear };
}
