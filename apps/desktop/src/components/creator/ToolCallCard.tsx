// ToolCallCard —— agent 工具调用输出卡片。
//
// 参考 OpenCode 式输出：紧凑步骤行 + Input/Output 折叠面板，像 IDE 里的执行记录。
// AskQuestion 不走这里（它有独立的提问卡片）。
import { useState } from 'react';
import {
  ChevronRightIcon,
  Loader2Icon,
  CheckCircle2Icon,
  XCircleIcon,
  FileTextIcon,
  FilePenIcon,
  FolderTreeIcon,
  GlobeIcon,
  PackagePlusIcon,
  AlertCircleIcon,
  BoxesIcon,
  WrenchIcon,
  MessageCircleQuestionIcon,
  ListChecksIcon,
  CalendarClockIcon,
  FileDownIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToolCardData {
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: 'running' | 'ok' | 'error';
}

// 工具名 → 图标 + 中文标签（Claude Code 风格命名）。
const TOOL_META: Record<string, { icon: typeof FileTextIcon; label: string }> = {
  Read: { icon: FileTextIcon, label: 'Read' },
  Write: { icon: FilePenIcon, label: 'Write' },
  Edit: { icon: FilePenIcon, label: 'Edit' },
  Glob: { icon: FolderTreeIcon, label: 'Glob' },
  CreatePlugin: { icon: PackagePlusIcon, label: 'CreatePlugin' },
  Check: { icon: AlertCircleIcon, label: 'Check' },
  WebSearch: { icon: GlobeIcon, label: 'WebSearch' },
  AskQuestion: { icon: MessageCircleQuestionIcon, label: 'Ask' },
  ListTeamPlugins: { icon: BoxesIcon, label: 'ListTeamPlugins' },
  TodoWrite: { icon: ListChecksIcon, label: 'Todo' },
  DateTime: { icon: CalendarClockIcon, label: '时间' },
  WebFetch: { icon: FileDownIcon, label: '网页' },
  // 旧会话兼容：历史记录里可能仍有迁移前工具名。
  stage_plugin: { icon: PackagePlusIcon, label: 'stage_plugin' },
  web_search: { icon: GlobeIcon, label: 'web_search' },
  read_draft_file: { icon: FileTextIcon, label: 'read_draft_file' },
  patch_draft_file: { icon: FilePenIcon, label: 'patch_draft_file' },
  list_draft_files: { icon: FolderTreeIcon, label: 'list_draft_files' },
  check_plugin: { icon: AlertCircleIcon, label: 'check_plugin' },
  list_team_plugins: { icon: BoxesIcon, label: 'list_team_plugins' },
};

/** 单行摘要：从 args/result 提炼一句话（不展开时显示）。 */
function summarize(data: ToolCardData): string {
  const a = (data.args ?? {}) as Record<string, unknown>;
  const r = (data.result ?? {}) as Record<string, unknown>;
  switch (data.name) {
    case 'WebSearch':
    case 'web_search':
      return typeof a.query === 'string' ? `"${a.query}"` : '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'read_draft_file':
    case 'patch_draft_file':
      return typeof a.path === 'string' ? a.path : '';
    case 'CreatePlugin':
    case 'stage_plugin':
      return typeof a.name === 'string' ? a.name : typeof a.id === 'string' ? a.id : '';
    case 'Glob':
    case 'list_draft_files':
      return Array.isArray((data.result as any)?.files)
        ? `${(data.result as any).files.length} 个文件`
        : '';
    case 'Check':
    case 'check_plugin': {
      const txt = typeof data.result === 'string' ? data.result : '';
      if (txt.includes('通过')) return '通过';
      if (txt.includes('错误')) return '有问题';
      return Array.isArray((data.result as any)?.issues)
        ? `${(data.result as any).issues.length} 个问题`
        : '';
    }
    case 'ListTeamPlugins':
    case 'list_team_plugins':
      return Array.isArray((data.result as any)?.plugins)
        ? `${(data.result as any).plugins.length} 个插件`
        : '';
    case 'TodoWrite': {
      const list = Array.isArray((a as any).todos)
        ? ((a as any).todos as Array<{ status?: string }>)
        : [];
      if (!list.length) return '清空清单';
      const done = list.filter((t) => t.status === 'completed').length;
      return `${done}/${list.length} 完成`;
    }
    case 'DateTime':
      // result 形如「当前时间：2026年6月29日 周日 ...」，取日期部分摘要。
      return typeof data.result === 'string'
        ? data.result.split('（')[0].replace('当前时间：', '')
        : '当前时间';
    case 'WebFetch':
      return typeof a.url === 'string' ? a.url.replace(/^https?:\/\//, '').slice(0, 40) : '';
    default:
      return '';
  }
}

function pretty(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    // 结果字符串过长时截断（卡片只为可见性，不是代码查看器）。
    return value.length > 2000 ? `${value.slice(0, 2000)}...（已截断）` : value;
  }
  try {
    return JSON.stringify(
      value,
      (_k, v) =>
        typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}...（已截断）` : v,
      2
    );
  } catch {
    return String(value);
  }
}

function statusText(status: ToolCardData['status']): string {
  if (status === 'running') return 'Running';
  if (status === 'error') return 'Failed';
  return 'Done';
}

function payloadMeta(value: unknown): string {
  const text = pretty(value);
  if (!text) return '';
  const lines = text.split(/\r\n|\r|\n/).length;
  return `${lines} ${lines === 1 ? 'line' : 'lines'} / ${text.length.toLocaleString()} chars`;
}

function PayloadBlock({ label, value }: { label: 'Input' | 'Output'; value: unknown }) {
  const text = pretty(value);
  if (!text) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-background/70">
      <div className="flex h-9 items-center justify-between border-b border-border/70 bg-muted/40 px-4">
        <span className="font-mono text-[11px] font-semibold text-foreground">{label}</span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {payloadMeta(value)}
        </span>
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-4 py-3 pr-6 font-mono text-[11px] leading-6 text-foreground">
        {text}
      </pre>
    </div>
  );
}

export function ToolCallCard({ data }: { data: ToolCardData }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[data.name] ?? { icon: WrenchIcon, label: data.name };
  const Icon = meta.icon;
  const summary = summarize(data);
  const status = statusText(data.status);

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border/70 bg-card/60 text-sm shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
      >
        <ChevronRightIcon
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
        <span className="flex size-8 items-center justify-center rounded-md border border-border/70 bg-muted">
          <Icon
            className={cn(
              'size-4 shrink-0',
              data.status === 'running' && 'text-primary',
              data.status === 'error' && 'text-destructive',
              data.status === 'ok' && 'text-success'
            )}
          />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-sm font-semibold text-foreground">{meta.label}</span>
            {summary ? (
              <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
            ) : null}
          </span>
        </span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px] font-semibold',
            data.status === 'running' && 'border-primary/30 bg-primary/10 text-primary',
            data.status === 'error' && 'border-destructive/40 bg-destructive/15 text-destructive',
            data.status === 'ok' && 'border-success/30 bg-success/10 text-success'
          )}
        >
          {data.status === 'running' ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : data.status === 'error' ? (
            <XCircleIcon className="size-3.5" />
          ) : (
            <CheckCircle2Icon className="size-3.5" />
          )}
          {status}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/70 bg-muted/20 px-4 py-4">
          <PayloadBlock label="Input" value={data.args} />
          <PayloadBlock label="Output" value={data.result} />
        </div>
      )}
    </div>
  );
}
