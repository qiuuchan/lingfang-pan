// token-estimate.ts —— 输入 token 启发式估算（不引入 tokenizer 依赖）。
//
// 背景：调用上游 LLM 有硬性输入上限（如 Bailian/Qwen 的 262144 token）。
// 前端需要在发请求前估算输入是否超限，决定是否压缩历史。
// 此前全用 `chars / 1.5` 一个系数——对纯中文偏准，但对英文/代码严重高估、
// 对二进制（file.size 字节数被当 token）严重低估，导致估算失真、压缩阈值错配。
//
// 方案：按内容类型分段加权（CJK ≈ 1.5 字符/token，拉丁/符号 ≈ 4 字符/token，
// 取保守偏向，宁高估防超限），并对每条消息加固定 overhead（对齐 OpenAI 实测）。
// 仍非精确 tokenizer，但配合 agent loop 的运行时护栏与后端 relay 兜底，多重防线足够。
//
// 与后端 apps/collab-api/src/modules/relay/token-estimate.ts 保持同构实现
// （前后端不共享包，复制 + 注释标注同源；改动需同步两边）。
import type { ChatMessage } from './types';

/** CJK 字符对应的 token 系数（1 个 token ≈ 1.5 个中文字符，保守偏高）。 */
export const CHARS_PER_TOKEN_CJK = 1.5;
/** 拉丁/符号/空白对应的 token 系数（1 个 token ≈ 4 个英文字符，OpenAI BPE 实测偏向）。 */
export const CHARS_PER_TOKEN_LATIN = 4;
/** 输出 token 预留：agent loop 的 max_tokens=16384，输入预算需扣除此值留给输出。 */
export const DEFAULT_OUTPUT_RESERVE = 16_384;
/** 每条消息的固定开销（role 标记 + 分隔符 + 结构，对齐 OpenAI tokenizer 实测约 4 token/条）。 */
const MESSAGE_OVERHEAD_TOKENS = 4;

const CJK_RANGE = /[\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/**
 * 估算一段文本的 token 数（按 CJK / 拉丁分段加权）。
 * 保守偏高：宁可高估触发更早的压缩，也不要低估撞上游硬限。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (CJK_RANGE.test(text[i])) cjkChars++;
    else otherChars++;
  }
  // 向上取整，避免零碎长度被抹零（短文本至少 1 token）。
  return Math.max(
    1,
    Math.ceil(cjkChars / CHARS_PER_TOKEN_CJK + otherChars / CHARS_PER_TOKEN_LATIN)
  );
}

/**
 * 估算单条消息的 token 数（适配 4 种 role：system/user/assistant/tool）。
 * - content 字符串走 estimateTokens
 * - assistant 的 tool_calls 按 arguments JSON 长度估算
 * - tool 消息按 content 长度估算
 */
export function estimateMessageTokens(msg: ChatMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  if ('content' in msg && typeof msg.content === 'string') {
    total += estimateTokens(msg.content);
  }
  // assistant 带 tool_calls：每个调用的 name + arguments 也占 token。
  if ('tool_calls' in msg && Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      total += estimateTokens(call.function.name);
      total += estimateTokens(call.function.arguments);
      total += MESSAGE_OVERHEAD_TOKENS; // tool_call 结构开销
    }
  }
  return total;
}

/**
 * 估算一批消息的总 token 数（累加每条 + 整体 overhead）。
 * 用于发请求前判断输入是否超 contextBudget。
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  return total;
}
