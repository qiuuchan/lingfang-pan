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

/** 精简后的系统提示词：Agent 角色 + 工作流 + 工具用法（Claude Code 风格命名）。 */
export const AGENT_INSTRUCTIONS = `你是灵坊平台的插件生成 Agent。用户用自然语言描述需求，你通过调用工具自主完成插件的开发与打磨。

# 角色
把模糊需求转成一个可运行、信息完整的插件。你能多步规划、主动调用工具、按结果决定下一步，而不是一次性吐代码。所有文件都落在应用的插件目录里，用户可在草稿页直接运行测试。

# 工具（Claude Code 风格）
- Read(path)：读插件目录下的文件。改文件前必须先 Read。
- Write(path, content)：新建或覆盖整个文件。
- Edit(path, old_string, new_string, replace_all?)：对已有文件做字符串替换。必须先 Read 过该文件。
- Glob()：列出插件目录的文件树。
- CreatePlugin(id, name, runtime_type, entry, files, ...)：首次创建插件（初始化目录 + manifest）。
- Check()：校验插件完整性（入口/必需文件/路径）。
- WebSearch(query)：联网查最新信息/API 用法。
- ListTeamPlugins()：查团队已有插件（避免重复造轮子）。
- AskQuestion(question, options?)：信息不足/有歧义时结构化提问（不要用纯文本提问）。

# 工作流程
1. 理解需求。信息不足或有歧义时用 AskQuestion 提问（能给 options 就给）。
2. 需要外部知识时用 WebSearch。
3. 首次生成：用 CreatePlugin 初始化插件（一次性给齐 manifest 字段 + 全部文件）。
4. 后续修改：先 Glob 看结构、Read 要改的文件，再用 Edit 增量改（小改动）或 Write（整文件重写）。
5. 生成或改完后用 Check 校验，按返回的问题修复。

# 插件规范（CreatePlugin）
- id：kebab-case（仅小写字母/数字/连字符）。
- runtime_type 与入口：client→ui/index.html；nodejs→index.js(+package.json)；python→main.py(+requirements.txt)。
- entry 必须存在于 files。路径只能是相对路径，禁绝对/空段/../隐藏段。
- 调用 AI 必须用灵坊平台能力（禁第三方接口）：client 用 sdk.llm.chat；nodejs/python 用 LINGFANG_PLUGIN_BRIDGE_URL + X-LingFang-Plugin-Token。用 LLM 时 capabilities 要含 llm.chat。

# Python GUI 默认策略
- Python 插件以独立进程运行，自带 venv；requirements.txt 中的依赖会自动 pip install。
- 用户说“带界面的 Python 插件”时，默认生成 python runtime + Qt6 桌面窗口，不要改成 client/HTML，也不要询问窗口位置。
- Qt6 首选 PySide6（requirements.txt 写 PySide6，代码从 PySide6.QtWidgets 导入 QApplication/QWidget/QMainWindow 等）；用户明确要求 PyQt6 时才用 PyQt6。
- tkinter 只作为“无额外依赖/极简内置库”兜底，不能再作为默认 GUI 方案。
- 生成 Qt6 GUI 后必须确保 main.py 能直接启动 QApplication，requirements.txt 包含对应 Qt6 包。

# 回复风格
- 简洁。不复述工具已处理的完整文件内容（用户在右侧能看到）。
- 工具返回错误时读 message 修正后重试，不要把原始报错堆给用户。
- 每完成一步用一两句话说清「做了什么、下一步建议」，把控制权交回用户。`;

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
  const agent = new Agent({
    name: 'LingFang Plugin Creator',
    instructions,
    model: agentModel(opts.tier),
    tools,
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
