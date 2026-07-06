// run.ts —— OpenAI Agents SDK 的插件创建 Agent 定义与运行循环。
//
// 替代旧 FloatingCreator 里手写的 streamText + stepCountIs 循环：
// - Agent：instructions（精简系统提示词 + 动态 skills）+ createAgentTools 的工具集。
// - run(agent, input, { stream: true })：框架负责多步循环、工具调用、流式输出。
// - HITL：AskQuestion 工具通过 onAskQuestion 回调挂起（UI 收集答案后 resolve），
//   无需手写 deferred；发布前确认等高风险动作可后续用 needsApproval/interruptions 扩展。
// - 上下文：history 由调用方用 context-compress 压缩后传入（thread 形式）。
import { Agent, run, type RunResult, type RunStreamEvent } from '@openai/agents';
import { agentModel } from '@/lib/agent/model';
import { createAgentTools, type AgentToolsOptions } from '@/lib/agent/tools';

import { AGENT_CORE_PROMPT } from './prompts';

/** 精简后的系统提示词：Agent 角色 + 工作流 + 工具用法。 */
export const AGENT_INSTRUCTIONS = AGENT_CORE_PROMPT;

export interface BuildAgentOptions extends AgentToolsOptions {
  tier: 'fast' | 'premium';
  /** 追加到系统提示词的动态片段（如 skills、思考模式引导）。 */
  extraInstructions?: string;
}

/** 构造插件创建 Agent + 工具控制器（resetReadTracking）。 */
export function buildPluginAgent(opts: BuildAgentOptions) {
  const { tools, resetReadTracking } = createAgentTools(opts);
  const instructions = opts.extraInstructions
    ? `${AGENT_INSTRUCTIONS}\n\n${opts.extraInstructions}`
    : AGENT_INSTRUCTIONS;
  // betav2 过渡期：tools 已迁移到自建 ToolDefinition[]，但本文件仍用 SDK Agent。
  // 阶段 4 store 接入后，run.ts/creator-adapter.ts/model.ts 将整体删除。
  const agent = new Agent({
    name: 'LingFang Plugin Creator',
    instructions,
    model: agentModel(opts.tier),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools as any,
  });
  return { agent, resetReadTracking };
}

/** Agent 单条输入项（user 消息或历史 thread）。 */
export type AgentInput = string | Parameters<typeof run>[1];

/**
 * 流式运行 Agent。返回 streamed RunResult；调用方遍历 result（for await）拿事件，
 * 完成后可读 result.finalOutput / result.history（写回会话）。
 */
export async function runAgentStreamed(
  agent: Agent<any>,
  input: AgentInput,
  options?: { signal?: AbortSignal },
): Promise<RunResult<any, any> & AsyncIterable<RunStreamEvent>> {
  const result = await run(agent, input as string, {
    stream: true,
    signal: options?.signal,
  });
  return result as RunResult<any, any> & AsyncIterable<RunStreamEvent>;
}
