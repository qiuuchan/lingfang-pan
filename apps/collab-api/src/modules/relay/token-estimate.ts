// token-estimate.ts —— 输入 token 启发式估算（relay 输入预检用）。
//
// 背景：调用上游 LLM 有硬性输入上限（如 Bailian/Qwen 的 262144 token）。
// 此前 relay 纯透传，前端漏判（上下文压缩失效）时直接撞上游 400，返回难懂的错误
// （`Range of input length should be [1, 262144]`）且可能漏判计费。
// 现在在转发前估算输入 token，超上限直接返回友好的 413 input_too_long。
//
// 与前端 apps/desktop/src/lib/agent/token-estimate.ts 保持同构实现
// （前后端不共享包，复制 + 注释标注同源；改动需同步两边）。

/** CJK 字符对应的 token 系数（1 个 token ≈ 1.5 个中文字符，保守偏高）。 */
export const CHARS_PER_TOKEN_CJK = 1.5;
/** 拉丁/符号/空白对应的 token 系数（1 个 token ≈ 4 个英文字符，OpenAI BPE 实测偏向）。 */
export const CHARS_PER_TOKEN_LATIN = 4;
/** 每条消息的固定开销（role 标记 + 分隔符 + 结构，对齐 OpenAI tokenizer 实测约 4 token/条）。 */
const MESSAGE_OVERHEAD_TOKENS = 4;

const CJK_RANGE = /[\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** relay 转发的消息形状（OpenAI Chat Completions，content 可为字符串或结构化数组）。 */
interface RelayMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  [k: string]: unknown;
}

/** 把消息 content（可能是 string / 结构化数组 / null）规范化为拼接字符串。 */
function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // OpenAI 结构化 content：[{ type: 'text', text }, { type: 'image_url', ... }]。
    // 文本部分累加，图片/其他部分按固定开销估（图片约 1000+ token，保守取占位估算）。
    let text = '';
    let imageCount = 0;
    for (const part of content) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' && typeof p.text === 'string') text += p.text;
        else if (p.type === 'image_url') imageCount++;
      }
    }
    return text + ' '.repeat(imageCount * 1000); // 图片按 ~1000 token 折算成等价字符
  }
  return '';
}

/**
 * 估算一段文本的 token 数（按 CJK / 拉丁分段加权）。
 * 保守偏高：宁可高估提前拦截，也不要低估放行撞上游硬限。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (CJK_RANGE.test(text[i])) cjkChars++;
    else otherChars++;
  }
  return Math.max(
    1,
    Math.ceil(cjkChars / CHARS_PER_TOKEN_CJK + otherChars / CHARS_PER_TOKEN_LATIN)
  );
}

/** 估算单条消息的 token 数。 */
export function estimateMessageTokens(msg: RelayMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  total += estimateTokens(contentToString(msg.content));
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      total += estimateTokens(call.function?.name ?? '');
      total += estimateTokens(call.function?.arguments ?? '');
      total += MESSAGE_OVERHEAD_TOKENS;
    }
  }
  return total;
}

/** 估算一批消息的总 token 数。 */
export function estimateMessagesTokens(messages: RelayMessage[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  return total;
}
