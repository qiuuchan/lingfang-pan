// design §3.2.6 / §3.2.7：多会话数据访问层。
//
// 本文件集中封装会话相关 Tauri 命令调用与 activeId 持久化，供 PluginCreatorHome 复用，
// 避免散落在组件里的 tauriInvoke 字符串拼装。命令契约见 Rust code_assistant.rs（阶段 1 已落地）：
//   - code_assistant_list_sessions → ConversationMeta[]
//   - code_assistant_rename_session / delete_session / save_draft / read_draft（均经 { input: {...} }）
//
// activeId 持久化命名对齐 recentKey/pinKey（plugin-draft.ts:728 / App.tsx:46）：
//   lf:active-conversation:{tenantId}，tenantId 为 null 时用 'none' 兜底（未加入团队态）。

import { tauriInvoke } from '@/lib/api';
import type { ConversationMeta } from '@/lib/plugin-draft';

// 拼装 activeId 的 localStorage key（与 App.tsx 的 pinKey/recentKey 命名风格一致）。
export function activeConversationKey(tenantId: string | null): string {
  return `lf:active-conversation:${tenantId || 'none'}`;
}

// 列出全部会话元数据（Rust list_sessions 返回 SessionRecord 数组，前端镜像为 ConversationMeta）。
export function listConversations(): Promise<ConversationMeta[]> {
  return tauriInvoke<ConversationMeta[]>('code_assistant_list_sessions');
}

// 重命名会话标题。Rust 同步回写 draftUpdatedAt=now（design §3.2.3）。
export function renameConversation(sessionId: string, title: string): Promise<void> {
  return tauriInvoke('code_assistant_rename_session', { input: { sessionId, title } });
}

// 删除会话（连同 transcripts/{id}.jsonl 与 drafts/{id}.json 一并清除）。
export function deleteConversation(sessionId: string): Promise<void> {
  return tauriInvoke('code_assistant_delete_session', { input: { sessionId } });
}

// 保存草稿到 drafts/{id}.json。draftJson 为前端序列化的 PluginDraft 字符串（前后端草稿 schema 解耦）。
export function saveDraft(sessionId: string, draftJson: string): Promise<void> {
  return tauriInvoke('code_assistant_save_draft', { input: { sessionId, draftJson } });
}

// 读取草稿原文（不存在返回 null）。调用方负责 JSON.parse。
export function readDraft(sessionId: string): Promise<string | null> {
  return tauriInvoke<string | null>('code_assistant_read_draft', { input: { sessionId } });
}

// 扫描 workspace 目录收成结构化文件列表（SDK 工具写入 workspace 后由 Rust 扫描产出 files）。
// 返回 {path, content}[]：path 为相对 sandbox 根的路径（统一 / 分隔）。
// 空 sandbox（纯对话 / claude 未写文件）返回空数组，调用方据此回退到对话态逻辑。
export function scanWorkspaceFiles(sessionId: string): Promise<{ path: string; content: string }[]> {
  return tauriInvoke<{ path: string; content: string }[]>('code_assistant_scan_workspace', { input: { sessionId } });
}

// 读取 localStorage 中的 activeId（无则返回 null）。解析失败静默回退 null，不抛错。
export function readActiveId(tenantId: string | null): string | null {
  try {
    return localStorage.getItem(activeConversationKey(tenantId));
  } catch {
    return null;
  }
}

// 用本地代码助手 SDK 总结一段对话，生成简短标题。
// 独立短任务（不复用当前对话 session，避免污染上下文），systemPrompt 严格约束只回标题文本。
// 返回值已 trim + 截断到 16 字。失败时返回空串，调用方降级到 deriveTitle 启发式。
export async function generateTitle(opts: {
  tool: 'claude' | 'codex';
  model?: string;
  userText: string;
  assistantText: string;
}): Promise<string> {
  const sysPrompt = '你是标题总结助手。请用简体中文给下面这段对话起一个不超过 10 个字的标题，只输出标题本身，不要标点、引号、解释、换行。';
  const prompt = `用户：${opts.userText.slice(0, 500)}\n\n助手：${opts.assistantText.slice(0, 800)}\n\n请给出这段对话的标题。`;
  try {
    const record = await tauriInvoke<{ sessionId: string }>('code_assistant_start_session', {
      input: {
        tool: opts.tool,
        model: opts.model && opts.model !== 'default' ? opts.model : undefined,
        prompt,
        systemPrompt: sysPrompt,
      },
    });
    const raw = await tauriInvoke<string>('code_assistant_read_transcript', { input: { sessionId: record.sessionId } });
    // transcript 里取首个非空 stdout output 作为标题（短任务只产一轮）。
    const events = raw.split('\n').filter(Boolean);
    for (const line of events) {
      try {
        const ev = JSON.parse(line);
        if (ev.event === 'output' && ev.payload?.stream === 'stdout' && typeof ev.payload.text === 'string') {
          const title = ev.payload.text.trim().replace(/["""'。，,.!！?？\n]/g, '').slice(0, 16);
          if (title) return title;
        }
      } catch {
        /* 跳过非 JSON 行 */
      }
    }
    return '';
  } catch {
    return '';
  }
}

// 写入 activeId 到 localStorage（同步持久化，新建/切换/删除时调用）。
export function writeActiveId(tenantId: string | null, sessionId: string | null): void {
  try {
    const key = activeConversationKey(tenantId);
    if (sessionId) localStorage.setItem(key, sessionId);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage 不可用则忽略 */
  }
}
