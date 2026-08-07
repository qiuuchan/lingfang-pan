/**
 * 中继调用「终态 → 平台表示」的权威映射（deep module）。
 *
 * 接口只有一个：`relayOutcome(status)`；实现是下方这张契约表。
 *
 * 此前这张表被摊在 relay.service.ts 的 ~8 个调用点（硬编码 httpStatus /
 * errorCode 字面量），任何状态语义调整都要改多处且易漏。集中到这里后：
 *  - locality：状态→(httpStatus, errorCode) 契约只在一处，改一处即可；
 *  - leverage：一个接口，N 个调用点；
 *  - 纯函数、无需 DI，单测直接覆盖（见 relay-finalizer.spec.ts）。
 *
 * 仅覆盖「确定性」终态。以下两类不属于此表，在调用点显式给出：
 *  - upstream_error：httpStatus/errorCode 依赖真实上游状态码（见 upstream-status-policy.ts）；
 *  - client_error 中 httpStatus 取自调用方异常（AppError.status / 500）的情况。
 */
export type RelayStaticTerminalStatus =
  'insufficient_balance' | 'success' | 'no_channel' | 'no_pricing';

export interface RelayOutcome {
  /** 透传给客户端的 HTTP 状态码。 */
  httpStatus: number;
  /** 调用日志 errorCode；null 表示该终态无特定错误码（如 success）。 */
  errorCode: string | null;
}

const RELAY_TERMINAL_OUTCOME: Record<RelayStaticTerminalStatus, RelayOutcome> = {
  // 预扣失败：余额不足，402 透传给桥→插件。
  insufficient_balance: { httpStatus: 402, errorCode: 'insufficient_balance' },
  // 成功。
  success: { httpStatus: 200, errorCode: null },
  // 无可用渠道（候选为空）。
  no_channel: { httpStatus: 503, errorCode: 'no_channel_available' },
  // 全部候选因无定价被跳过。
  no_pricing: { httpStatus: 503, errorCode: 'pricing_not_configured' },
};

export function relayOutcome(status: RelayStaticTerminalStatus): RelayOutcome {
  return RELAY_TERMINAL_OUTCOME[status];
}
