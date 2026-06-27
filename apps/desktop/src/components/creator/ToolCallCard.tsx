// ToolCallCard —— Claude Code 风格精简工具调用卡片。
//
// 克制的一行设计：小图标 + 工具名 + 灰色摘要 + 状态点，无渐变/blur/大阴影。
// 可展开看参数/结果，展开内容同样精简（去阴影/去 blur/小字号）。
// AskQuestion 不走这里（它有独立的提问卡片）。
//
// task 06-26-agent-framework-rewrite：更新 TOOL_META 为 Claude Code 命名 + 新工具，
// 精简样式（rounded-md、size-4 行内图标、去渐变/blur/大阴影）。
import { useState } from 'react';
import {
  ChevronRightIcon, Loader2Icon, CheckCircle2Icon, XCircleIcon,
  FileTextIcon, FilePenIcon, FolderTreeIcon, GlobeIcon, PackagePlusIcon, AlertCircleIcon, BoxesIcon, WrenchIcon, MessageCircleQuestionIcon,
} from 'lucide-react';

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

export function ToolCallCard({ data }: { data: ToolCardData }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[data.name] ?? { icon: WrenchIcon, label: data.name };
  const Icon = meta.icon;
  const summary = summarize(data);

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-border/30 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/30"
      >
        <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon className={`size-3.5 shrink-0 ${
          data.status === 'running' ? 'text-blue-500' :
          data.status === 'error' ? 'text-destructive' :
          'text-muted-foreground'
        }`} />
        <span className="font-medium text-xs">{meta.label}</span>
        {summary && <span className="truncate text-xs text-muted-foreground/70">{summary}</span>}
        <span className="ml-auto shrink-0">
          {data.status === 'running' ? (
            <Loader2Icon className="size-3 animate-spin text-blue-500" />
          ) : data.status === 'error' ? (
            <XCircleIcon className="size-3 text-destructive" />
          ) : (
            <CheckCircle2Icon className="size-3 text-muted-foreground/50" />
          )}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/20 bg-muted/20 px-3 py-2">
          {data.args !== undefined && (
            <div>
              <div className="mb-1 text-[10px] font-semibold text-muted-foreground">参数</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/20 bg-background/60 p-2 text-[10px] leading-relaxed">{pretty(data.args)}</pre>
            </div>
          )}
          {data.result !== undefined && (
            <div>
              <div className="mb-1 text-[10px] font-semibold text-muted-foreground">结果</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/20 bg-background/60 p-2 text-[10px] leading-relaxed">{pretty(data.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
