// 代码助手结构化输出协议：跨三 CLI（claude / codex / opencode）零适配，统一走 stdout 文本。
// 仅依赖 fenced code block（代码模型原生产出能力），不依赖任何 CLI 的特殊输出格式。
//
// 协议包含三类围栏块：
//   - manifest 块（必填，恰好一个）：插件清单 JSON。
//   - file 块（每个文件一个）：插件源码文件，info 内 path="..." 指定相对路径。
//   - notes 块（可选）：给用户的自然语言说明。
//
// 本文件只提供 systemPrompt 常量与 info string 的纯函数分类（不含状态、不含解析主流程），
// 解析主流程（正则切块 + manifest 校验 + 状态判定）在 plugin-draft.ts 的 parseStructuredPackage 中。

// 提示模型按协议产出插件包的 systemPrompt。
// 约束：capabilities kind 必须取白名单，绝不使用裸 code-assistant（会被后端拒绝）。
export const PLUGIN_CREATOR_SYSTEM_PROMPT = `你是一名 LingFang 插件工程师。请严格按以下协议产出插件包，使用三类围栏代码块（fenced code block），不要在块外输出关键信息：

1. manifest 块（必填，恰好一个）：
\`\`\`lingfang-manifest json
{ "id": "...", "name": "...", "version": "0.1.0", "description": "...",
  "runtime_type": "client", "entry": "ui/index.html", "visibility": "tenant",
  "capabilities": [{ "kind": "code-assistant.run", "reason": "...", "risk": "low", "requires_admin": false }] }
\`\`\`

2. 文件块（每个文件一个，至少包含 entry 指向的文件）：
\`\`\`file path="ui/index.html"
<文件内容>
\`\`\`

3. 说明块（可选，给用户的自然语言说明）：
\`\`\`lingfang-notes
<说明>
\`\`\`

约束：
- capabilities 的 kind 必须取自白名单：ui.view / fs.pick / fs.read / fs.write / net.fetch / clipboard / llm.chat / storage.kv / system.info / system.screenshot / system.notify / code-assistant.run / code-assistant.session / plugin.upload / plugin.submitMarketplace；不要用裸 "code-assistant"。
- 文件 path 必须为相对路径，不含绝对路径前缀、..、隐藏段（不以 . 开头）。
- entry 必须指向一个真实产出的文件块。`;

// 围栏块 info string → 类型分类。
// 兼容裸 ``` 无 info 的退化情况（归类 unknown，由上层 parseStructuredPackage 做候选归类）。
export type StructuredBlockKind = 'manifest' | 'file' | 'notes' | 'unknown';

export interface StructuredBlock {
  kind: StructuredBlockKind;
  info: string; // 原始 info string
  language?: string; // 推断语言（json/html/...）
  path?: string; // file 块的 path
  content: string; // 块内文本（去围栏）
  start: number; // 在原文中的字符偏移（诊断用）
  truncated?: boolean; // 块未找到结束围栏（围栏嵌套 / 流被切断），供上层补 schema 诊断
}

// 协议 info string 识别：按 info 前缀匹配协议关键字，否则归 unknown。
// 注意：已知语言标识（html/python/ts 等）归 unknown，由上层做候选归类（如推断为 ui/index.html）。
export function classifyBlockInfo(info: string): StructuredBlockKind {
  const trimmed = info.trim();
  if (!trimmed) return 'unknown';
  if (trimmed.startsWith('lingfang-manifest')) return 'manifest';
  if (trimmed.startsWith('file')) return 'file';
  if (trimmed.startsWith('lingfang-notes')) return 'notes';
  return 'unknown';
}
