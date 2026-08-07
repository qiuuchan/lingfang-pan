// SchedulerAgentRunner.tsx —— 本地定时任务的常驻隐藏 Agent 执行器（PRD R3 / 方案 Z）。
//
// 挂载在 App.tsx 根，不依赖当前 view，永远活着。负责 AGENT_PROMPT 任务的执行：
// 1. 监听 Rust 端 emit 的 `scheduler:trigger` { task_id, run_id, started_at } 事件。
// 2. 启动隔离的 agent session：复用 runAgentLoop + createAgentTools（工具全开，PRD 决策）。
//    - 不绑 pluginId（getPluginId 返回 null）；Agent 看到 prompt 自然不会主动操作插件目录。
//    - AskQuestion 拦截：onAskQuestion 立即 reject（无头模式无法提问），Agent 自行绕开。
// 3. 监听 `scheduler:cancel` { run_id }：超时时 Rust 端 emit 此事件，AbortController.abort()。
// 4. agent loop 结束 → 调 schedulerRecordRun 回写结果（SUCCESS/FAILED）。
//
// 设计原则：
// - 不渲染任何 UI（display:none 容器）。所有用户可见反馈走 NotificationCenter（由 App.tsx 监听 scheduler:notify）。
// - 不污染 PluginCreatorStore（不调 createPlugin，不写 aiDraft）。
// - 单实例：用 ref 持有当前在跑的 AbortController，新 trigger 来时若前一个还在跑则忽略（由 Rust 端串行保证）。
import { useEffect, useRef } from 'react';
import { tauriListen, errorMessage } from '@/lib/api';
import { runAgentLoop } from '@/lib/agent/loop';
import { createAgentTools } from '@/lib/agent/tools';
import type { ChatMessage, LoopCallbacks } from '@/lib/agent/types';
import { CREATOR_CONTEXT_PROMPT } from '@/lib/agent/prompts';
import { schedulerRecordRun } from '@/lib/local-scheduler';
import { api } from '@/lib/api';
import { loadInstalledPlugin } from '@/lib/plugin-registry';
import { invokeInstalledPluginAction } from '@/lib/plugin-action-runtime';

/** trigger 事件 payload。 */
interface SchedulerTriggerPayload {
  task_id: string;
  run_id: string;
  started_at: string;
}

/** cancel 事件 payload。 */
interface SchedulerCancelPayload {
  run_id: string;
}

interface SchedulerPluginActionPayload {
  task_id: string;
  run_id: string;
  started_at: string;
  plugin_id: string;
  action: string;
  input: { input?: unknown };
}

/**
 * 无头 Agent 执行器。
 *
 * 渲染一个 display:none 的占位 div（React 要求返回元素）。
 * 所有副作用在 useEffect 内：注册 tauri 事件监听 + 启动 agent session。
 */
export function SchedulerAgentRunner() {
  // 当前在跑的 run_id → AbortController，cancel 事件据此终止。
  const activeRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    // trigger 监听：启动 agent session。
    let unlistenTrigger: (() => void) | null = null;
    let unlistenCancel: (() => void) | null = null;
    let unlistenPluginAction: (() => void) | null = null;

    (async () => {
      unlistenTrigger = await tauriListen<SchedulerTriggerPayload>(
        'scheduler:trigger',
        async (event) => {
          const { task_id, run_id, started_at } = event.payload;
          await runHeadlessAgent(task_id, run_id, started_at);
        }
      );
      unlistenCancel = await tauriListen<SchedulerCancelPayload>('scheduler:cancel', (event) => {
        const { run_id } = event.payload;
        const controller = activeRef.current.get(run_id);
        if (controller) {
          controller.abort();
          activeRef.current.delete(run_id);
        }
      });
      unlistenPluginAction = await tauriListen<SchedulerPluginActionPayload>(
        'scheduler:plugin-action',
        (event) => {
          void runPluginAction(event.payload);
        }
      );
    })();

    return () => {
      unlistenTrigger?.();
      unlistenCancel?.();
      unlistenPluginAction?.();
      // 卸载时中止所有在跑的 session（应用关闭）。
      for (const controller of activeRef.current.values()) {
        controller.abort();
      }
      activeRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runPluginAction(payload: SchedulerPluginActionPayload) {
    const { run_id: runId, task_id: taskId, started_at: startedAt } = payload;
    try {
      const plugin = await loadInstalledPlugin(payload.plugin_id);
      if (!plugin.releaseId || !plugin.packageId)
        throw new Error('插件发行版身份不完整，无法调用 Action');
      const manifest =
        plugin.manifest && typeof plugin.manifest === 'object'
          ? (plugin.manifest as Record<string, unknown>)
          : {};
      const actions = await api<{ actions?: Array<Record<string, unknown>> }>(
        `/api/plugin-releases/${encodeURIComponent(plugin.releaseId)}/actions`
      );
      const action = actions.actions?.find((item) => item.action_id === payload.action);
      if (!action || typeof action.action_contract_version !== 'string')
        throw new Error(`插件未导出 Action：${payload.action}`);
      const caller = {
        ...plugin,
        manifest: {
          ...manifest,
          action_dependencies: [
            {
              dependency_id: `scheduler.${payload.action}`,
              package_id: plugin.packageId,
              release_version_range: `=${plugin.version}`,
              action_id: payload.action,
              action_contract_version_range: `=${action.action_contract_version}`,
            },
          ],
        },
      };
      const output = await invokeInstalledPluginAction(caller, {
        dependency_id: `scheduler.${payload.action}`,
        input: payload.input?.input ?? {},
      });
      await schedulerRecordRun({
        id: runId,
        task_id: taskId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: 'SUCCESS',
        error: null,
        output_summary: truncate(JSON.stringify(output), 2000),
      });
    } catch (error) {
      await schedulerRecordRun({
        id: runId,
        task_id: taskId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: 'FAILED',
        error: errorMessage(error),
        output_summary: null,
      }).catch(() => undefined);
    }
  }

  /**
   * 跑一个无头 agent session。
   * 不渲染 UI，所有输出汇总为最后一条 assistant 消息文本作为 output_summary。
   */
  async function runHeadlessAgent(taskId: string, runId: string, startedAt: string) {
    // 取任务配置拿 prompt + timeout。
    // Rust 端已 emit task_id，但没把 prompt 一起带过来（避免大 payload 经事件）。
    // 这里直接 invoke scheduler_list 找到 prompt。
    let promptText: string;
    try {
      const { schedulerList } = await import('@/lib/local-scheduler');
      const tasks = await schedulerList();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) {
        throw new Error(`任务「${taskId}」不存在`);
      }
      if (task.payload.type !== 'AGENT_PROMPT') {
        throw new Error(`任务 payload 不是 AGENT_PROMPT`);
      }
      promptText = task.payload.prompt;
    } catch (e) {
      // 任务不存在或类型错 → 回写 FAILED。
      await recordFailed(runId, taskId, startedAt, `加载任务失败：${errorMessage(e)}`);
      return;
    }

    const controller = new AbortController();
    activeRef.current.set(runId, controller);

    // 收集 agent 文本输出，作为 output_summary。
    let collectedText = '';
    let collectedReasoning = '';

    const callbacks: LoopCallbacks = {
      onTextDelta: (delta) => {
        collectedText += delta;
      },
      onReasoningDelta: (delta) => {
        collectedReasoning += delta;
      },
      onReasoningEnd: () => {
        /* 无 UI，忽略 */
      },
      onToolCall: () => {
        /* 无 UI，忽略；工具实际执行由 createAgentTools 内部完成 */
      },
      onToolOutput: () => {
        /* 无 UI，忽略 */
      },
    };

    // 构造 agent 工具集：复用 createAgentTools（PRD 决策：工具全开）。
    // getPluginId 返回 null → Agent 调 Read/Write 等会报错"先用 CreatePlugin 创建"，
    // Agent 自然绕开（无头模式不应操作插件目录）。
    // onAskQuestion 拦截：无头模式不能提问，立即 reject。
    const { tools } = createAgentTools({
      getPluginId: () => null,
      getConversationId: () => null,
      onPluginCreated: () => {
        /* 无头模式不应创建插件；若 Agent 调了就忽略副作用 */
      },
      onFilesChanged: () => {
        /* 无 UI，忽略 */
      },
      onAskQuestion: () => {
        // 无头模式不能提问：返回 reject 让 Agent 看到错误，自行绕开。
        return Promise.reject(new Error('无人值守模式不支持提问，请直接执行任务或改用其他工具'));
      },
      getTodos: () => [],
      onTodoUpdate: () => {
        /* 无 UI，忽略 */
      },
    });

    // 构造 messages：system prompt + 单条 user message。
    // system prompt 复用 CREATOR_CONTEXT_PROMPT 不合适（它是插件创建专用），
    // 这里给一个通用的"任务执行"prompt。
    const systemPrompt = [
      '你是灵坊平台的本地定时任务执行 Agent。',
      '当前为无人值守模式（headless）：用户不在屏幕前，无法回答提问。',
      '请直接根据任务 prompt 执行，输出最终结果摘要（不超过 500 字）。',
      '禁止调用 AskQuestion（无人值守不支持）；禁止操作插件目录（除非任务明确要求）。',
      '执行完毕后用一段简洁文字总结结果。',
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: promptText },
    ];

    let status: 'SUCCESS' | 'FAILED' = 'SUCCESS';
    let errorMsg: string | null = null;

    try {
      const result = await runAgentLoop({
        messages,
        tools,
        tier: 'fast',
        signal: controller.signal,
        callbacks,
      });
      if (result.status === 'failed') {
        status = 'FAILED';
        errorMsg = result.error ?? '执行失败';
      } else if (result.status === 'aborted') {
        // Rust 端 cancel 事件触发；此处不回写（Rust 端已记 TIMEOUT）。
        activeRef.current.delete(runId);
        return;
      } else if (result.status === 'max_turns') {
        status = 'FAILED';
        errorMsg = '达到最大轮次上限';
      }
      // done / max_turns 走正常回写。
    } catch (e) {
      status = 'FAILED';
      errorMsg = errorMessage(e);
    } finally {
      activeRef.current.delete(runId);
    }

    // 汇总输出：取最后一段文本，截断 2000 字符。
    const summary = truncate(collectedText.trim() || collectedReasoning.trim() || '(无输出)', 2000);
    const finishedAt = new Date().toISOString();

    try {
      await schedulerRecordRun({
        id: runId,
        task_id: taskId,
        started_at: startedAt,
        finished_at: finishedAt,
        status,
        error: status === 'FAILED' ? (errorMsg ?? '未知错误') : null,
        output_summary: status === 'SUCCESS' ? summary : null,
      });
    } catch (e) {
      // 回写失败：Rust 端 executor 会按超时记 FAILED。前端 log 即可。
      console.error('[scheduler] record_run 失败', e);
    }
  }

  /** 任务加载失败时直接回写 FAILED。 */
  async function recordFailed(runId: string, taskId: string, startedAt: string, msg: string) {
    try {
      await schedulerRecordRun({
        id: runId,
        task_id: taskId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: 'FAILED',
        error: msg,
        output_summary: null,
      });
    } catch (e) {
      console.error('[scheduler] recordFailed 失败', e);
    }
  }

  return <div style={{ display: 'none' }} aria-hidden="true" />;
}

/** 截断字符串到 max 字符（末尾加 …）。 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// 防 unused 警告（CREATOR_CONTEXT_PROMPT 仅作为参考导入，未来若想用 plugin 创建器 prompt 可切换）。
void CREATOR_CONTEXT_PROMPT;
