// ToolCallCard —— Claude Code 式工具调用卡片：图标 + 工具名 + 一行摘要 + 状态，可展开看参数/结果。
//
// 渲染在 assistant 气泡内（stage_plugin/web_search/read_draft_file/patch_draft_file/list_* 等），
// ask_question 不走这里（它有独立的提问卡片）。
import { useState } from 'react';
import {
  ChevronRightIcon, Loader2Icon, CheckCircle2Icon, XCircleIcon,
  PackageIcon, GlobeIcon, FileTextIcon, FilePenIcon, FolderTreeIcon, BoxesIcon, WrenchIcon,
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
    <div className="mt-2 overflow-hidden rounded-xl border bg-background text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRightIcon className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{meta.label}</span>
        {summary && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>}
        <span className="ml-auto shrink-0">
          {data.status === 'running' ? (
            <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
          ) : data.status === 'error' ? (
            <XCircleIcon className="size-3.5 text-destructive" />
          ) : (
            <CheckCircle2Icon className="size-3.5 text-green-600" />
          )}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t bg-muted/20 px-3 py-2">
          {data.args !== undefined && (
            <div>
              <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">参数</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[11px] leading-relaxed">{pretty(data.args)}</pre>
            </div>
          )}
          {data.result !== undefined && (
            <div>
              <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">结果</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[11px] leading-relaxed">{pretty(data.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
