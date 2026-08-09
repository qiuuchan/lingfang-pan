// adapt/report.ts —— 适配检验改造流水线的数据契约。
//
// 所有模块（validate / transform / runtime-check / index 编排）共用这些类型，
// 桌面端 UI、CLI、服务端干跑端点也消费 AdaptationReport。
//
// 约定：manifest 边界字段沿用仓库规范使用 snake_case（id / version / runtime_type /
// entry / capabilities / visibility），不要改成 camelCase。

/** 问题分类。 */
export type AdaptationCategory =
  | 'manifest'
  | 'structure'
  | 'runtime'
  | 'capability'
  | 'ai_boundary'
  | 'dependency'
  | 'execution';

/** 初始严重度：自动可修 / 需人工 / 已修复。 */
export type AdaptationSeverity = 'auto_fixable' | 'needs_human' | 'fixed';

/** 运行时确证的证据项。 */
export interface RunEvidence {
  method: 'import_smoke' | 'py_compile' | 'node_check' | 'short_run' | 'html_check' | 'bridge_handshake' | 'none';
  passed: boolean;
  detail?: string;
  durationMs?: number;
}

/** 单个适配问题。 */
export interface AdaptationIssue {
  code: string;
  category: AdaptationCategory;
  severity: AdaptationSeverity;
  /** manifest 字段或文件路径。 */
  path?: string;
  message: string;
  detail?: string;
  /** 确定性 transform 能否修复。 */
  fixable: boolean;
}

/** 一次确定性改造应用的记录（用于 UI 展示与人工复核 diff）。 */
export interface FixApplied {
  code: string;
  category: AdaptationCategory;
  message: string;
  path?: string;
  /** 改造前后的差异，便于人工复核（尤其 A4 AI 边界归一化）。 */
  diff?: { before?: string; after?: string } | string;
}

/** 最终适配状态（会随发布请求上送服务端落库）。 */
export type AdaptationStatus =
  | 'ADAPTED_PASSED' // 校验 + 改造通过，且（若执行）确证能跑
  | 'ADAPTED_FAILED' // 改造后仍残留需人工/agent 的问题
  | 'NEEDS_HUMAN' // 存在只能人工处理的问题
  | 'NOT_RUN'; // 未执行适配（如纯校验模式）

/** 流水线最终报告。 */
export interface AdaptationReport {
  /** 整体是否通过：所有 auto-fixable 已修 + 无残留需人工/agent（除非显式允许带残留发布）。 */
  ok: boolean;
  pluginId?: string;
  runtimeType?: string;
  issues: AdaptationIssue[];
  fixesApplied: FixApplied[];
  /** 改造后仍需人工/agent 处理的问题。 */
  remaining: AdaptationIssue[];
  /** 是否确证可运行（仅当执行了运行时检查才为 true）。 */
  canRun: boolean;
  runEvidence?: RunEvidence[];
  status: AdaptationStatus;
  summary: string;
  /** 生成报告的引擎版本，便于服务端/前端区分行为。 */
  engineVersion: string;
}

export const ADAPT_ENGINE_VERSION = '0.1.0' as const;

/** 便捷构造器：从问题 + 已应用改造产出报告。 */
export function buildReport(input: {
  pluginId?: string;
  runtimeType?: string;
  issues: AdaptationIssue[];
  fixesApplied: FixApplied[];
  canRun?: boolean;
  runEvidence?: RunEvidence[];
  /** 是否真的跑了改造流水线。false = 纯静态 dry-run，只能产出 NOT_RUN。 */
  adapted?: boolean;
  /** 是否执行了运行时确证（短跑/冒烟）。 */
  executed?: boolean;
}): AdaptationReport {
  const { issues, fixesApplied } = input;
  const remaining = issues.filter(
    (i) => i.severity === 'needs_human' || i.severity === 'auto_fixable'
  );
  // ok 必须与 status 同向：确证失败（executed 但 canRun=false）时即使零残留问题也不能算 ok。
  const ok = remaining.length === 0 && !(input.executed && input.canRun === false);
  const canRun = input.canRun ?? false;

  // status 会随发布上送服务端并成为审核依据，所以「没跑流水线」和「跑了但没过」
  // 必须区分开：纯 dry-run 即使零问题也不能自称 ADAPTED_PASSED。
  let status: AdaptationStatus;
  if (!input.adapted) status = 'NOT_RUN';
  else if (remaining.some((i) => i.severity === 'needs_human')) status = 'NEEDS_HUMAN';
  else if (remaining.length > 0) status = 'ADAPTED_FAILED';
  else if (input.executed && !canRun) status = 'ADAPTED_FAILED';
  else status = 'ADAPTED_PASSED';

  const summary = !input.adapted
    ? `静态校验完成：发现 ${issues.length} 个问题（未执行改造）`
    : status === 'ADAPTED_FAILED' && !ok
      ? `确证失败：运行时应答不可用（已应用 ${fixesApplied.length} 项自动改造）`
      : ok
        ? `适配通过（应用 ${fixesApplied.length} 项自动改造）`
        : `适配未完成：剩余 ${remaining.length} 项待人工/agent 处理（已应用 ${fixesApplied.length} 项自动改造）`;

  return {
    ok,
    pluginId: input.pluginId,
    runtimeType: input.runtimeType,
    issues,
    fixesApplied,
    remaining,
    canRun,
    runEvidence: input.runEvidence,
    status,
    summary,
    engineVersion: ADAPT_ENGINE_VERSION,
  };
}
