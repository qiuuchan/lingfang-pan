// ToolCallCard —— agent 工具调用输出卡片。
//
// 参考 OpenCode 式输出：紧凑步骤行 + Input/Output 折叠面板，像 IDE 里的执行记录。
// AskQuestion 不走这里（它有独立的提问卡片）。
import { useState } from 'react';
import {
  ChevronRightIcon, Loader2Icon, CheckCircle2Icon, XCircleIcon,
  FileTextIcon, FilePenIcon, FolderTreeIcon, GlobeIcon, PackagePlusIcon, AlertCircleIcon, BoxesIcon, WrenchIcon, MessageCircleQuestionIcon, ListChecksIcon, CalendarClockIcon, FileDownIcon,
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
      return typeof a.name === 'string' ? a.name : (typeof a.id === 'string' ? a.id : '');
    case 'Glob':
    case 'list_draft_files':
      return Array.isArray((data.result as any)?.files) ? `${(data.result as any).files.length} 个文件` : '';
    case 'Check':
    case 'check_plugin': {
      const txt = typeof data.result === 'string' ? data.result : '';
      if (txt.includes('通过')) return '通过';
      if (txt.includes('错误')) return '有问题';
      return Array.isArray((data.result as any)?.issues) ? `${(data.result as any).issues.length} 个问题` : '';
    }
    case 'ListTeamPlugins':
    case 'list_team_plugins':
      return Array.isArray((data.result as any)?.plugins) ? `${(data.result as any).plugins.length} 个插件` : '';
    case 'TodoWrite': {
      const list = Array.isArray((a as any).todos) ? (a as any).todos as Array<{ status?: string }> : [];
      if (!list.length) return '清空清单';
      const done = list.filter((t) => t.status === 'completed').length;
      return `${done}/${list.length} 完成`;
    }
    case 'DateTime':
      // result 形如「当前时间：2026年6月29日 周日 ...」，取日期部分摘要。
      return typeof data.result === 'string' ? data.result.split('（')[0].replace('当前时间：', '') : '当前时间';
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
    return JSON.stringify(value, (_k, v) => (typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}...（已截断）` : v), 2);
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
    <div className="overflow-hidden rounded-lg border border-[#2a2a2c] bg-[#121214]">
      <div className="flex h-9 items-center justify-between border-b border-[#2a2a2c] bg-[#18181a] px-4">
        <span className="font-mono text-[11px] font-semibold text-[#d5d5d8]">{label}</span>
        <span className="font-mono text-[10px] tabular-nums text-[#7f8086]">{payloadMeta(value)}</span>
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-4 py-3 pr-6 font-mono text-[11px] leading-6 text-[#e0e0e4]">{text}</pre>
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
    <div className="my-4 overflow-hidden rounded-xl border border-[#2a2a2c] bg-[#18181a] text-sm shadow-[0_10px_28px_rgba(0,0,0,0.18)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[#202023]"
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-[#8d8d92] transition-transform', open && 'rotate-90')} />
        <span className="flex size-8 items-center justify-center rounded-lg border border-[#303034] bg-[#202023]">
          <Icon className={cn(
            'size-4 shrink-0',
            data.status === 'running' && 'text-[#f5f5f7]',
            data.status === 'error' && 'text-destructive',
            data.status === 'ok' && 'text-[#e5e5e5]',
          )} />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-sm font-semibold text-[#f0f0f2]">{meta.label}</span>
            {summary ? <span className="truncate font-mono text-xs text-[#9b9ca2]">{summary}</span> : null}
          </span>
        </span>
        <span className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[11px] font-semibold',
          data.status === 'running' && 'border-[#6f6f75]/50 bg-[#2a2a2c] text-[#f5f5f7]',
          data.status === 'error' && 'border-destructive/40 bg-destructive/15 text-destructive',
          data.status === 'ok' && 'border-[#6f6f75]/50 bg-[#2a2a2c] text-[#e5e5e5]',
        )}>
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
        <div className="space-y-3 border-t border-[#2a2a2c] bg-[#151517] px-4 py-4">
          <PayloadBlock label="Input" value={data.args} />
          <PayloadBlock label="Output" value={data.result} />
        </div>
      )}
    </div>
  );
}
