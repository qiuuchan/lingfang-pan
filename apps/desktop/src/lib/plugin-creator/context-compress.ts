// context-compress.ts —— 创建器上下文自动压缩。
//
// 问题：长对话把全部 turns 塞进 history 会超出上游 context 窗口。简单截断会丢失早期需求与决策。
// 方案：把较早的「纯对话轮」摘要成一条压缩 system 消息，**保留**最近 N 轮原文 + 任何含插件包的轮
//      （生成的代码不能被摘要吞掉），并在轮次增长时增量更新摘要（不每次全量重算）。
//
// 摘要本身走 relay（chatComplete，非流式），用 fast 版本 + 低 temperature 控成本与稳定性。
import { chatComplete, type ChatMessage } from '@/lib/relay-chat-stream';

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
    /** 保留的原文历史轮（[{role, content}]）。 */
    keptTurns: Array<{ role: string; content: string }>;
    currentInput: string;
    /** 粗略 token 估算（中文为主，1 token ≈ 1.5 字符；英文约 4 字符/token，此处取中文偏向防低估）。 */
    estimatedTokens: { system: number; summary: number; history: number; input: number; total: number };
    /** 压缩进度（供 UI 显示「距离下次压缩还有多少」）。 */
    compressInfo: {
      /** 触发压缩的字符阈值。 */
      threshold: number;
      /** 当前全部历史轮的字符数。 */
      currentChars: number;
      /** 距离触发压缩还差多少字符（≤0 表示已达/超阈值，下次将压缩）。 */
      remainingChars: number;
      /** 压缩进度百分比（currentChars / threshold，0-100+）。 */
      pct: number;
    };
  };
}

interface BuildArgs {
  /** 已发生的对话轮（user/assistant 交替），不含本次要发的输入。
   *  assistant 轮可带 parts（工具调用+结果），保留进 messages 让模型续跑时看到上轮工作。 */
  turns: { role: 'user' | 'assistant'; content: string; parts?: unknown[] }[];
  /** 本次用户输入。 */
  currentInput: string;
  /** 重试模式：turns 已含对应 user 轮，跳过追加 currentInput（避免用户消息重复）。 */
  skipAppendCurrent?: boolean;
  /** 拼装好的基础系统提示词（含 skills）。 */
  systemPrompt: string;
  /** 压缩状态（in/out）。 */
  state: CompressState;
  /** 触发压缩的累计字符阈值（超过则压缩更早的对话轮）。默认 5000。 */
  threshold?: number;
  /** 原文保留的最近轮数（每轮 user+assistant）。默认 4。 */
  recentWindowTurns?: number;
  tier?: 'fast' | 'premium';
  signal?: AbortSignal;
}

/**
 * 构建发送给 relay 的 messages，按需自动压缩历史。
 * 算法：
 *  1. totalChars = 全部 turns 字符数。未超阈值 → 不压缩，原文历史 + 当前。
 *  2. 超阈值 → 近期 recentWindowTurns 轮原文保留；更早的轮中：
 *     - 含插件包的轮原文保留（代码不可丢）；
 *     - 其余「可压缩轮」若比上次有新增 → 增量摘要（prior summary + 新轮），更新 state。
 *  3. messages = [system, 摘要(若有), ...保留的原文轮(按原序), 当前输入]。
 */
export async function buildContextMessages(args: BuildArgs): Promise<BuildResult> {
  const threshold = args.threshold ?? 5000;
  const recentWindow = args.recentWindowTurns ?? 4;
  const tier = args.tier ?? 'fast';
  const turns = args.turns;
  const state = args.state;

  const totalChars = turns.reduce((s, t) => s + t.content.length, 0);

  // 未超阈值：原文返回。保留 assistant 的 parts（工具历史），让重试/续跑能断点续。
  if (totalChars <= threshold) {
    const keptTurns = turns.map((t) =>
      t.role === 'assistant' && Array.isArray(t.parts) && t.parts.length
        ? { role: t.role, content: t.content, parts: t.parts }
        : { role: t.role, content: t.content },
    );
    const historyChars = turns.reduce((s, t) => s + t.content.length, 0);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string; parts?: unknown[] }[] = [
      { role: 'system', content: args.systemPrompt },
      ...keptTurns,
    ];
    if (!args.skipAppendCurrent) messages.push({ role: 'user', content: args.currentInput });
    return {
      messages,
      compressedCount: 0,
      state,
      breakdown: {
        systemPrompt: args.systemPrompt,
        summary: '',
        keptTurns,
        currentInput: args.currentInput,
        estimatedTokens: {
          system: Math.ceil(args.systemPrompt.length / 1.5),
          summary: 0,
          history: Math.ceil(historyChars / 1.5),
          input: Math.ceil(args.currentInput.length / 1.5),
          total: Math.ceil((args.systemPrompt.length + historyChars + args.currentInput.length) / 1.5),
        },
        compressInfo: {
          threshold,
          currentChars: totalChars,
          remainingChars: threshold - totalChars,
          pct: threshold > 0 ? Math.round((totalChars / threshold) * 100) : 0,
        },
      },
    };
  }

  // 超阈值：划分近期原文区（最近 recentWindow*2 条）。
  const recentStart = Math.max(0, turns.length - recentWindow * 2);
  const older = turns.slice(0, recentStart);
  // older 里含插件包的轮必须原文保留（代码不可丢）；其余可压缩。
  const protectedFromCompress = older.filter((t) => turnHasPackage(t.content));

  // 近期原文 = older 里的包轮 + 最近窗口（按原顺序去重）。
  const recent = turns.slice(recentStart);
  const verbatim: { role: 'user' | 'assistant'; content: string }[] = [...protectedFromCompress, ...recent];

  // 找出 older 区内尚未摘要的「可压缩轮」（用 older 全局索引判定，跳过含插件包的轮）。
  const newOnesToSummarize: { role: 'user' | 'assistant'; content: string }[] = [];
  older.forEach((t, olderIdx) => {
    if (turnHasPackage(t.content)) return; // 包轮不摘要
    if (olderIdx > state.lastSummarizedIndex) newOnesToSummarize.push(t);
  });

  let nextSummary = state.summary;
  let nextLastIndex = state.lastSummarizedIndex;
  if (newOnesToSummarize.length > 0) {
    // 增量摘要：prior summary + 新可压缩轮。
    const summarizeInput: ChatMessage[] = [
      { role: 'system', content: SUMMARIZE_PROMPT },
      ...(state.summary ? [{ role: 'assistant' as const, content: `已有摘要：\n${state.summary}` }] : []),
      ...newOnesToSummarize.map((t): ChatMessage => ({ role: t.role, content: t.content })),
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

  const messages: ChatMessage[] = [{ role: 'system', content: args.systemPrompt }];
  if (nextSummary.trim()) {
    messages.push({ role: 'system', content: `[历史上下文摘要]\n${nextSummary}` });
  }
  for (const t of verbatim) messages.push({ role: t.role, content: t.content });
  if (!args.skipAppendCurrent) messages.push({ role: 'user', content: args.currentInput });

  const historyChars = verbatim.reduce((s, t) => s + t.content.length, 0);
  return {
    messages,
    compressedCount: newOnesToSummarize.length,
    state: { lastSummarizedIndex: nextLastIndex, summary: nextSummary },
    breakdown: {
      systemPrompt: args.systemPrompt,
      summary: nextSummary,
      keptTurns: verbatim.map((t) => ({ role: t.role, content: t.content })),
      currentInput: args.currentInput,
      estimatedTokens: {
        system: Math.ceil(args.systemPrompt.length / 1.5),
        summary: Math.ceil(nextSummary.length / 1.5),
        history: Math.ceil(historyChars / 1.5),
        input: Math.ceil(args.currentInput.length / 1.5),
        total: Math.ceil((args.systemPrompt.length + nextSummary.length + historyChars + args.currentInput.length) / 1.5),
      },
      // 超阈值已压缩：compressInfo 反映压缩后的状态（verbatim 是压缩后保留的近期轮）。
      // currentChars 用 verbatim（压缩后实际保留的历史），remainingChars 是距离下次再触发的余量。
      compressInfo: {
        threshold,
        currentChars: historyChars,
        remainingChars: threshold - historyChars,
        pct: threshold > 0 ? Math.round((historyChars / threshold) * 100) : 0,
      },
    },
  };
}
