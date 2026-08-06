/**
 * 上游错误 → 平台表示 的策略（deep module）。
 *
 * 接口：`summarizeUpstreamError(error)` / `remapUpstreamHttpStatus(raw)` /
 * `extractUpstreamCause(error)` / `upstreamErrorCode(error)`。
 *
 * 集中了此前散落在 relay.service.ts 的 `extractUpstreamCause`、`upstreamErrorCode`
 * 以及内联的「401/403 → 502」规则。集中后：
 *  - locality：上游错误如何翻译成平台表示只在一处，根因摘要 / 状态码重映射不再各写一遍；
 *  - leverage：一个接口，relay 的多个失败分支共用；
 *  - 纯函数、无需 DI，单测直接覆盖（见 upstream-status-policy.spec.ts）。
 *
 * 与 ADR-0002 一致：平台只做对接层 + 审计，不自建计费；本模块只负责把上游错误
 * 翻译成「可透传 / 可重试」的平台表示，不涉及任何金额计量。
 */
import { UpstreamError } from './forwarders';

export interface UpstreamSummary {
  /** 上游真实 HTTP 状态码（无上游错误时为 null）。 */
  upstreamStatus: number | null;
  /** 根因摘要（≤300 字符），优先从 body 抽 message/error 字段。 */
  upstreamDetail: string | null;
  /** 透传给客户端的 HTTP 状态码（已按 remapUpstreamHttpStatus 重映射）。 */
  httpStatus: number;
  /** 调用日志 errorCode（带上游根因摘要）。 */
  errorCode: string;
}

/**
 * 上游 401/403 → 502（Bad Gateway）映射。
 *
 * 401/403 在这里表示「渠道 key 被上游拒绝」（绝非客户端鉴权问题——客户端 JWT
 * 已在 RelayTeamGuard 验证）。映射为 502 使桥/插件的重试逻辑把它归类为瞬态错误
 *（5xx 可重试），而不是误判成「鉴权失败不重试」。原始状态码保留在 upstreamStatus 供诊断。
 */
export function remapUpstreamHttpStatus(rawStatus: number | null): number {
  if (rawStatus === 401 || rawStatus === 403) return 502;
  return rawStatus ?? 502;
}

/** 从最后一次上游错误中提取「根因摘要」，供 errorCode + 客户端 details 使用。 */
export function extractUpstreamCause(error: unknown): { upstreamStatus: number | null; upstreamDetail: string | null } {
  if (!(error instanceof UpstreamError)) return { upstreamStatus: null, upstreamDetail: null };
  const body = (error.body ?? '').slice(0, 300);
  // 尝试从 JSON body 抽取 message/error.message（OpenAI/Moonshot 错误体常见字段）。
  try {
    const parsed = JSON.parse(error.body ?? '') as { message?: string; error?: { message?: string } | string; msg?: string };
    const msg = parsed.message ?? parsed.msg ?? (typeof parsed.error === 'object' ? parsed.error?.message : undefined);
    if (msg && typeof msg === 'string') {
      return { upstreamStatus: error.httpStatus, upstreamDetail: msg.slice(0, 300) };
    }
  } catch { /* body 非 JSON，回落到原文截断 */ }
  return { upstreamStatus: error.httpStatus, upstreamDetail: body || null };
}

/** 拼接 errorCode：upstream_<status> + 根因摘要，便于后台调用日志一眼定位。 */
export function upstreamErrorCode(error: unknown): string {
  const { upstreamStatus, upstreamDetail } = extractUpstreamCause(error);
  const tag = `upstream_${upstreamStatus ?? 'unknown'}`;
  if (!upstreamDetail) return tag;
  // 截断 100 字符，避免 errorCode 过长（数据库列 + 日志可读性）。
  return `${tag}:${upstreamDetail.slice(0, 100)}`;
}

/** 一次性给出上游错误在平台侧的完整表示（httpStatus 已按策略重映射）。 */
export function summarizeUpstreamError(error: unknown): UpstreamSummary {
  const { upstreamStatus, upstreamDetail } = extractUpstreamCause(error);
  const httpStatus = remapUpstreamHttpStatus(upstreamStatus);
  const errorCode = error instanceof UpstreamError ? upstreamErrorCode(error) : 'upstream_llm_error';
  return { upstreamStatus, upstreamDetail, httpStatus, errorCode };
}
