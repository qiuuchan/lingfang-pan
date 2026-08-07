import { useState } from 'react';
import {
  AlertTriangleIcon,
  InfoIcon,
  RefreshCwIcon,
  CopyIcon,
  CheckIcon,
  LifeBuoyIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { CreatorError, CreatorErrorLevel } from '@/lib/creator-error';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// 等级 → 图标 + 边框/底色映射。error 用红色，warning 用琥珀，info 降级为中性提示。
const LEVEL_STYLE: Record<
  CreatorErrorLevel,
  { icon: typeof AlertTriangleIcon; className: string }
> = {
  error: { icon: AlertTriangleIcon, className: 'border-destructive/30 bg-destructive/5' },
  warning: {
    icon: AlertTriangleIcon,
    className: 'border-amber-200 bg-warning/10 dark:border-amber-900/40 dark:bg-amber-950/30',
  },
  info: { icon: InfoIcon, className: 'border-border bg-muted/60' },
};

// execCommand 剪贴板回退：临时插入隐藏 textarea 触发复制。
// 与 components/markdown.tsx 的 fallbackCopy 同模式（非 secure context 的 webview 兜底）。
function fallbackCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 对话区错误气泡：把 CreatorError 渲染为带图标/标题/详情的结构化卡片，
 * 替代 Bubble.error 的裸文本堆栈。
 * - 折叠的 raw 区域用可见细滚动条（scrollbar-thin），便于排障。
 * - retryable 且提供 onRetry 时渲染「重试」按钮。
 * - 「复制错误信息」按钮：把标题+详情+raw 打包复制，便于用户反馈给支持排障。
 * - 「联系支持」按钮：mailto 深链，携带错误摘要，降低反馈门槛。
 */
export function ErrorBubble({ error, onRetry }: { error: CreatorError; onRetry?: () => void }) {
  const { icon: Icon, className } = LEVEL_STYLE[error.level];
  const [copied, setCopied] = useState(false);

  // 打包完整错误信息：标题 / 详情 / 原始技术信息，供复制或邮件正文使用。
  const errorReport = [
    `【错误类型】${error.title}`,
    error.detail ? `【可能原因】${error.detail}` : null,
    error.raw ? `【技术信息】\n${error.raw}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const onCopy = async () => {
    const text = errorReport;
    try {
      // 优先用标准 Clipboard API（Tauri webview 满足 secure context）。
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      setCopied(true);
      toast.success('已复制错误信息');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      if (fallbackCopy(text)) {
        setCopied(true);
        toast.success('已复制错误信息');
        window.setTimeout(() => setCopied(false), 1500);
      } else {
        toast.error('复制失败，请手动选取');
      }
    }
  };

  // 联系支持：mailto 深链预填主题与正文，让用户一键发邮件反馈（需运营配置真实支持邮箱）。
  // 首版用占位邮箱，避免硬编码不存在地址；后续接入帮助中心后改为站内反馈入口。
  const supportSubject = encodeURIComponent(`插件创建问题反馈：${error.title}`);
  const supportBody = encodeURIComponent(`${errorReport}\n\n—— 来自灵方桌面客户端错误反馈`);
  const supportHref = `mailto:support@lingfang.example?subject=${supportSubject}&body=${supportBody}`;

  return (
    <div
      className={cn(
        'self-start max-w-[82%] rounded-xl border px-4 py-3 text-sm break-words',
        className
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{error.title}</div>
          {error.detail && <p className="mt-1 text-xs text-muted-foreground">{error.detail}</p>}
          {error.raw && (
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground">
                查看详细信息
              </summary>
              {/* 折叠的原始技术信息：功能性滚动区，需可见细滚动条。 */}
              <pre className="scrollbar-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-xs">
                {error.raw}
              </pre>
            </details>
          )}
          {/* 反馈操作区：复制错误信息 + 联系支持（调研报告 A4 错误反馈通道）。 */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onCopy}>
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              {copied ? '已复制' : '复制错误信息'}
            </Button>
            <a href={supportHref}>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                <LifeBuoyIcon className="size-3.5" />
                联系支持
              </Button>
            </a>
          </div>
        </div>
        {error.retryable && onRetry && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onRetry}>
            <RefreshCwIcon className="size-3.5" />
            重试
          </Button>
        )}
      </div>
    </div>
  );
}
