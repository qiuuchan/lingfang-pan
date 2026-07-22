// context-compress.ts —— 创建器上下文自动压缩。
//
// 问题：长对话把全部 turns 塞进 history 会超出上游 context 窗口（如 256K token）。
//      简单截断会丢失早期需求与决策，且会破坏原生 function calling 的 tool_calls / tool result 配对。
// 方案：把较早的「可压缩轮」摘要成一条压缩 system 消息，**保留**最近 N 轮原文 + 任何含插件包的轮
//      （生成的代码不能被摘要吞掉），并在轮次增长时增量更新摘要（不每次全量重算）。
//
// betav2 关键修复：此前压缩产物 built.messages 从未真正传给 agent 循环——
// CreatorWorkspace 只取 summary 插一条 system 消息，再用 turnsToMessages(完整历史) 把全部轮
// （含 role:'tool' 的大文件/网页结果）重新塞回，导致压缩完全失效、历史只增不减、最终撞上游 256K 硬限。
// 现在本函数直接产出**可发给模型的原生 ChatMessage[]**：
//  - 近期保留区用 turnsToMessages 还原（保留 tool_calls + role:'tool' 配对，断点续跑可用）
//  - 早期可压缩轮整体进摘要文本（连同工具结果一起摘要，不丢上下文但丢弃原生结构——对早期历史可接受）
//  - 含插件包的轮（```lingfang-plugin）强制原文保留，永不进摘要
// 调用方直接用返回的 messages，不再二次全量还原。
//
// 摘要本身走 relay（chatComplete，非流式），用 fast 版本 + 低 temperature 控成本与稳定性。
import { chatComplete, type ChatMessage as SimpleChatMessage } from '@/lib/relay-chat-stream';
import { turnsToMessages, type HistoryPart, type HistoryTurn } from '@/lib/agent/history';
import { estimateMessagesTokens, estimateTokens } from '@/lib/agent/token-estimate';
import type { ChatMessage } from '@/lib/agent/types';

/** 检测一轮是否含插件包（```lingfang-plugin 块）——这些轮必须原文保留，不能被摘要吞掉。 */
export function turnHasPackage(content: string): boolean {
  return /```lingfang-plugin\b/.test(content);
}

/** 压缩摘要状态（跨多次 send 缓存，增量更新）。 */
export interface CompressState {
  /** 已摘要到 turns[lastSummarizedIndex]（含）。-1 表示尚未摘要任何轮。 */
  lastSummarizedIndex: number;
  /** 累计摘要文本。 */
  summary: string;
}

export function emptyCompressState(): CompressState {
  return { lastSummarizedIndex: -1, summary: '' };
}

const SUMMARIZE_PROMPT = `你在为一个「AI 插件生成」对话做上下文压缩。把下面若干轮历史对话压缩成一段简洁摘要，供后续生成参考。

要求：
- 保留：用户的核心需求、关键约束、已做的重要决策、已经生成过什么类型的插件、文件结构要点。
- 丢弃：寒暄、重复、完整的代码块（绝不要把 \`\`\`lingfang-plugin 代码块写进摘要——只说"已生成 <名> 插件包"即可）、冗长解释。
- 用要点形式（中文），≤ 300 字。
- 只输出摘要正文，不要前后缀。`;

export interface BuildResult {
  /** 组装好的 messages（含 system + 摘要 + 近期原文 + 当前用户输入）。 */
  messages: ChatMessage[];
  /** 本次是否触发了（新）压缩——用于 UI 显示「已压缩 N 轮」指示。 */
  compressedCount: number;
  /** 更新后的压缩状态（调用方写回 ref）。 */
  state: CompressState;
  /** 上下文查看面板用：各部分内容与 token 占比估算（让用户看清"模型到底看到了什么"）。 */
  breakdown: {
    systemPrompt: string;
    summary: string;
    /** 保留的原文历史轮（[{role, content}]，content 为展示用文本，含工具摘要）。 */
    keptTurns: Array<{ role: string; content: string }>;
    currentInput: string;
    /** 粗略 token 估算（中文为主，1 token ≈ 1.5 字符；英文约 4 字符/token）。 */
    estimatedTokens: { system: number; summary: number; history: number; input: number; total: number };
    /** 压缩进度（供 UI 显示「距离下次压缩还有多少」）。 */
    compressInfo: {
      /** 触发压缩的 token 阈值。 */
      threshold: number;
      /** 当前全部历史轮的 token 估算。 */
      currentTokens: number;
      /** 距离触发压缩还差多少 token（≤0 表示已达/超阈值，下次将压缩）。 */
      remainingTokens: number;
      /** 压缩进度百分比（currentTokens / threshold，0-100+）。 */
      pct: number;
    };
  };
}

interface BuildArgs {
  /** 已发生的对话轮（user/assistant 交替），不含本次要发的输入。
   *  assistant 轮可带 parts（工具调用+结果），保留进 messages 让模型续跑时看到上轮工作。 */
  turns: { role: 'user' | 'assistant'; content: string; parts?: HistoryPart[] }[];
  /** 本次用户输入。 */
  currentInput: string;
  /** 重试模式：turns 已含对应 user 轮，跳过追加 currentInput（避免用户消息重复）。 */
  skipAppendCurrent?: boolean;
  /** 拼装好的基础系统提示词（含 skills）。 */
  systemPrompt: string;
  /** 压缩状态（in/out）。 */
  state: CompressState;
  /** 触发压缩的累计 token 阈值（超过则压缩更早的对话轮）。
   *  优先用 contextWindow 推算；都未传则保守默认（见 DEFAULT_THRESHOLD_TOKENS）。 */
  threshold?: number;
  /** 真实上下文窗口（token，来自 relay /models）。提供后按 contextWindow×0.7 推算阈值。 */
  contextWindow?: number;
  /** 原文保留的最近轮数（每轮 user+assistant）。默认 4。 */
  recentWindowTurns?: number;
  tier?: 'fast' | 'premium';
  signal?: AbortSignal;
}

/** 预算占比：留 30% 给 system prompt + 当前输入 + 输出。 */
const CONTEXT_BUDGET_RATIO = 0.7;
/** 无 contextWindow 时的保守默认阈值（token）。 */
const DEFAULT_THRESHOLD_TOKENS = 8_000;

/** 据 contextWindow（token）推算压缩阈值（token）。 */
function thresholdFromContextWindow(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return DEFAULT_THRESHOLD_TOKENS;
  return Math.floor(contextWindow * CONTEXT_BUDGET_RATIO);
}

/**
 * 把一轮的 parts 渲染成展示用文本（供 breakdown.keptTurns 与摘要输入用）。
 * 文本 part 原样拼接；工具 part 渲染成 `[工具名] 参数… → 结果…` 的紧凑形式。
 */
function renderTurnText(content: string, parts?: HistoryPart[]): string {
  if (!parts || parts.length === 0) return content;
  const segments: string[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.content.trim()) segments.push(p.content);
    } else if (p.type === 'tool') {
      const argsStr = typeof p.args === 'string' ? p.args : JSON.stringify(p.args ?? {});
      const resultStr = typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? '');
      segments.push(`[工具 ${p.name}]\n参数：${argsStr}\n结果：${resultStr}`);
    }
  }
  const text = segments.join('\n').trim();
  return text || content;
}

/** turns（含 parts）转成 HistoryTurn[]，供 turnsToMessages 还原原生 function calling 历史。 */
function toHistoryTurns(turns: BuildArgs['turns']): HistoryTurn[] {
  return turns.map((t) => ({
    role: t.role,
    content: t.content,
    parts: t.parts,
    // assistant 轮都视作 done（调用方已过滤非 done 轮）；保留 status 兜底。
    status: t.role === 'assistant' ? 'done' : undefined,
  }));
}

/**
 * 构建发送给 relay 的 messages，按需自动压缩历史。
 * 算法：
 *  1. currentTokens = 全部 turns 估算 token。未超阈值 → 不压缩，原文历史（原生 function calling）+ 当前。
 *  2. 超阈值 → 近期 recentWindowTurns 轮原文保留（用 turnsToMessages 还原，保 tool 配对）；更早的轮中：
 *     - 含插件包的轮原文保留（代码不可丢）；
 *     - 其余「可压缩轮」若比上次有新增 → 增量摘要（prior summary + 新轮），更新 state。
 *  3. messages = [system, 摘要(若有), ...保留的原文轮(原生 messages), 当前输入]。
 */
export async function buildContextMessages(args: BuildArgs): Promise<BuildResult> {
  const threshold = args.threshold ?? thresholdFromContextWindow(args.contextWindow);
  const recentWindow = args.recentWindowTurns ?? 4;
  const tier = args.tier ?? 'fast';
  const turns = args.turns;
  const state = args.state;

  // 用真实 token 估算（CJK/拉丁加权）替代旧的 chars/1.5。
  const historyTurnsForEstimate = toHistoryTurns(turns);
  const estimatedHistoryMessages = turnsToMessages(historyTurnsForEstimate, '', true);
  const historyTokens = estimateMessagesTokens(estimatedHistoryMessages);
  const systemTokens = estimateTokens(args.systemPrompt);

  // 未超阈值：原文返回（原生 function calling 历史），保留 assistant 的 parts（工具历史）。
  if (historyTokens <= threshold) {
    const historyMessages = turnsToMessages(historyTurnsForEstimate, args.skipAppendCurrent ? '' : args.currentInput, args.skipAppendCurrent);
    const messages: ChatMessage[] = [
      { role: 'system', content: args.systemPrompt },
      ...historyMessages,
    ];
    const inputTokens = estimateTokens(args.currentInput);
    return {
      messages,
      compressedCount: 0,
      state,
      breakdown: {
        systemPrompt: args.systemPrompt,
        summary: '',
        keptTurns: turns.map((t) => ({ role: t.role, content: renderTurnText(t.content, t.parts) })),
        currentInput: args.currentInput,
        estimatedTokens: {
          system: systemTokens,
          summary: 0,
          history: historyTokens,
          input: inputTokens,
          total: systemTokens + historyTokens + inputTokens,
        },
        compressInfo: {
          threshold,
          currentTokens: historyTokens,
          remainingTokens: threshold - historyTokens,
          pct: threshold > 0 ? Math.round((historyTokens / threshold) * 100) : 0,
        },
      },
    };
  }

  // 超阈值：划分近期原文区（最近 recentWindow*2 条 = recentWindow 轮）。
  const recentStart = Math.max(0, turns.length - recentWindow * 2);
  const older = turns.slice(0, recentStart);
  // older 里含插件包的轮必须原文保留（代码不可丢）；其余可压缩。
  const protectedFromCompressIdx = new Set<number>();
  older.forEach((t, i) => {
    // 同时检测 content 与 parts 渲染文本（包块可能在 text part 里）。
    if (turnHasPackage(t.content) || (t.parts && t.parts.some((p) => p.type === 'text' && turnHasPackage(p.content)))) {
      protectedFromCompressIdx.add(i);
    }
  });

  // 找出 older 区内尚未摘要的「可压缩轮」（用 older 全局索引判定，跳过含插件包的轮）。
  const newOnesToSummarize: { role: 'user' | 'assistant'; content: string }[] = [];
  older.forEach((t, olderIdx) => {
    if (protectedFromCompressIdx.has(olderIdx)) return; // 包轮不摘要
    if (olderIdx > state.lastSummarizedIndex) {
      newOnesToSummarize.push({ role: t.role, content: renderTurnText(t.content, t.parts) });
    }
  });

  let nextSummary = state.summary;
  let nextLastIndex = state.lastSummarizedIndex;
  if (newOnesToSummarize.length > 0) {
    // 增量摘要：prior summary + 新可压缩轮。
    const summarizeInput: SimpleChatMessage[] = [
      { role: 'system', content: SUMMARIZE_PROMPT },
      ...(state.summary ? [{ role: 'assistant' as const, content: `已有摘要：\n${state.summary}` }] : []),
      ...newOnesToSummarize.map((t): SimpleChatMessage => ({ role: t.role, content: t.content })),
      { role: 'user', content: '请输出更新后的完整摘要（含上面已有摘要的内容 + 这些新对话）。' },
    ];
    try {
      nextSummary = await chatComplete(summarizeInput, tier, args.signal);
      nextLastIndex = older.length - 1; // 已摘要到 older 区末
    } catch {
      // 摘要失败（网络/限流）：不推进 lastSummarizedIndex，保留这些轮下次重试。
      // 此前的做法是「标记为已摘要但 summary 不更新」= 静默丢弃这些轮（既没进摘要也没保留原文），
      // 若含关键决策会丢失。改为不推进索引：下轮这些轮仍作为「未摘要的新轮」参与摘要重试。
      nextSummary = state.summary;
      nextLastIndex = state.lastSummarizedIndex;
    }
  }

  // 近期原文区 = older 里受保护的包轮 + recent 窗口（按原顺序去重合并）。
  // 用 turnsToMessages 还原原生 function calling 历史（保 tool_calls + role:'tool' 配对）。
  const verbatimTurns: BuildArgs['turns'] = [
    ...older.filter((_, i) => protectedFromCompressIdx.has(i)),
    ...turns.slice(recentStart),
  ];
  const verbatimMessages = turnsToMessages(toHistoryTurns(verbatimTurns), args.skipAppendCurrent ? '' : args.currentInput, args.skipAppendCurrent);

  const messages: ChatMessage[] = [{ role: 'system', content: args.systemPrompt }];
  if (nextSummary.trim()) {
    messages.push({ role: 'system', content: `[历史上下文摘要]\n${nextSummary}` });
  }
  messages.push(...verbatimMessages);

  const summaryTokens = estimateTokens(nextSummary);
  const historyKeptTokens = estimateMessagesTokens(verbatimMessages);
  const inputTokens = estimateTokens(args.currentInput);
  return {
    messages,
    compressedCount: newOnesToSummarize.length,
    state: { lastSummarizedIndex: nextLastIndex, summary: nextSummary },
    breakdown: {
      systemPrompt: args.systemPrompt,
      summary: nextSummary,
      keptTurns: verbatimTurns.map((t) => ({ role: t.role, content: renderTurnText(t.content, t.parts) })),
      currentInput: args.currentInput,
      estimatedTokens: {
        system: systemTokens,
        summary: summaryTokens,
        history: historyKeptTokens,
        input: inputTokens,
        total: systemTokens + summaryTokens + historyKeptTokens + inputTokens,
      },
      // 超阈值已压缩：compressInfo 反映压缩后的状态（verbatim 是压缩后保留的近期轮）。
      compressInfo: {
        threshold,
        currentTokens: historyKeptTokens,
        remainingTokens: threshold - historyKeptTokens,
        pct: threshold > 0 ? Math.round((historyKeptTokens / threshold) * 100) : 0,
      },
    },
  };
}
