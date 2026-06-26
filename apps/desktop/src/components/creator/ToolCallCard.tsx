// ToolCallCard —— Claude Code 式工具调用卡片：图标 + 工具名 + 一行摘要 + 状态，可展开看参数/结果。
//
// 渲染在 assistant 气泡内（stage_plugin/web_search/read_draft_file/patch_draft_file/list_* 等），
// ask_question 不走这里（它有独立的提问卡片）。
import { useState } from 'react';
import {
  ChevronRightIcon, Loader2Icon, CheckCircle2Icon, XCircleIcon,
  PackageIcon, GlobeIcon, FileTextIcon, FilePenIcon, FolderTreeIcon, BoxesIcon, WrenchIcon, ShieldCheckIcon, ClipboardCheckIcon,
} from 'lucide-react';

export interface ToolCardData {
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: 'running' | 'ok' | 'error';
}

// 工具名 → 图标 + 中文标签。
const TOOL_META: Record<string, { icon: typeof PackageIcon; label: string }> = {
  stage_plugin: { icon: PackageIcon, label: '生成插件草稿' },
  web_search: { icon: GlobeIcon, label: '联网搜索' },
  read_draft_file: { icon: FileTextIcon, label: '读取草稿文件' },
  patch_draft_file: { icon: FilePenIcon, label: '修改草稿文件' },
  list_draft_files: { icon: FolderTreeIcon, label: '查看文件树' },
  check_plugin: { icon: ClipboardCheckIcon, label: '检查插件' },
  review_plugin: { icon: ShieldCheckIcon, label: 'Review 插件' },
  list_team_plugins: { icon: BoxesIcon, label: '查询团队插件' },
};

/** 单行摘要：从 args/result 提炼一句话（不展开时显示）。 */
function summarize(data: ToolCardData): string {
  const a = (data.args ?? {}) as Record<string, unknown>;
  const r = (data.result ?? {}) as Record<string, unknown>;
  switch (data.name) {
    case 'web_search':
      return typeof a.query === 'string' ? `“${a.query}”` : '';
    case 'read_draft_file':
    case 'patch_draft_file':
      return typeof a.path === 'string' ? a.path : '';
    case 'stage_plugin':
      return typeof a.name === 'string' ? a.name : (typeof a.id === 'string' ? a.id : '');
    case 'list_draft_files':
      return Array.isArray(r.files) ? `${r.files.length} 个文件` : '';
    case 'check_plugin':
      return Array.isArray(r.issues) ? `${r.issues.length} 个问题` : '';
    case 'review_plugin':
      return Array.isArray(r.findings) ? `${r.findings.length} 条结果` : '';
    case 'list_team_plugins':
      return Array.isArray(r.plugins) ? `${r.plugins.length} 个插件` : '';
    default:
      return '';
  }
}

function pretty(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    // stage_plugin 的 files 全文很长，截断展示（卡片只为可见性，不是代码查看器）。
    return JSON.stringify(value, (_k, v) => (typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}…（已截断）` : v), 2);
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
    <div className="mt-3 overflow-hidden rounded-xl border border-border/40 bg-gradient-to-br from-background to-muted/20 text-sm shadow-sm backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-all hover:bg-muted/40"
      >
        <ChevronRightIcon className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
          data.status === 'running' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' :
          data.status === 'error' ? 'bg-destructive/10 text-destructive' :
          'bg-green-600/10 text-green-600'
        }`}>
          <Icon className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">{meta.label}</span>
          {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
        </div>
        <span className="ml-auto shrink-0">
          {data.status === 'running' ? (
            <Loader2Icon className="size-4 animate-spin text-blue-600 dark:text-blue-400" />
          ) : data.status === 'error' ? (
            <XCircleIcon className="size-4 text-destructive" />
          ) : (
            <CheckCircle2Icon className="size-4 text-green-600" />
          )}
        </span>
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-border/30 bg-muted/30 px-4 py-3">
          {data.args !== undefined && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <div className="size-1 rounded-full bg-primary" />
                <span>参数</span>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/40 bg-background/80 p-2.5 text-[11px] leading-relaxed shadow-sm backdrop-blur-sm">{pretty(data.args)}</pre>
            </div>
          )}
          {data.result !== undefined && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <div className="size-1 rounded-full bg-green-600" />
                <span>结果</span>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/40 bg-background/80 p-2.5 text-[11px] leading-relaxed shadow-sm backdrop-blur-sm">{pretty(data.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
