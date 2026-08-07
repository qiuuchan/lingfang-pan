// plugin-permissions.ts — Task 14 系统级权限运行时授权（用户确认 + 记忆）。
//
// 流程：插件调 sdk.system.requestPermission({code, reason}) → invokeRuntime 命中
// system.requestPermission kind → requestSystemPermission 先查 localStorage 记忆的决策，
// 已决则直接返回；未决则派发 'lf:permission-request' 自定义事件（携带 resolver），
// 由 PermissionConsentDialog 组件监听并弹出确认框，用户选择后 resolve + 记忆。
//
// 记忆 key：lf:perm:{pluginId}:{code} = 'granted' | 'denied'。clearPluginDecisions 供卸载/登出清理。
//
// 设计要点：授权结果在前端记忆（localStorage），不强制走 Rust——系统级敏感操作的真正执行仍受
// capability 网关（capability.rs）约束；本层只做「用户是否允许该插件使用该权限」的意图确认。

export type PermissionDecision = 'granted' | 'denied';

export interface PermissionRequest {
  pluginId: string;
  pluginName: string;
  code: string;
  reason: string;
  resolve: (decision: PermissionDecision) => void;
}

const PREFIX = 'lf:perm:';

function decisionKey(pluginId: string, code: string): string {
  return `${PREFIX}${pluginId}:${code}`;
}

/** 读取已记忆的决策（granted/denied）；未决返回 null。 */
export function getRememberedDecision(pluginId: string, code: string): PermissionDecision | null {
  try {
    const v = localStorage.getItem(decisionKey(pluginId, code));
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

/** 记忆决策（用户勾选「不再询问」或默认记忆最近一次）。 */
export function rememberDecision(
  pluginId: string,
  code: string,
  decision: PermissionDecision
): void {
  try {
    localStorage.setItem(decisionKey(pluginId, code), decision);
  } catch {
    /* 忽略配额/禁用 */
  }
}

/** 清空某插件的全部授权决策（卸载/登出清理）。 */
export function clearPluginDecisions(pluginId: string): number {
  const prefix = `${PREFIX}${pluginId}:`;
  let n = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    n = keys.length;
  } catch {
    /* 忽略 */
  }
  return n;
}

/**
 * 请求系统级权限：先查记忆，未决派发事件让 PermissionConsentDialog 弹确认框。
 * 返回 { granted, remembered } —— granted=是否允许，remembered=本次是否走了记忆命中。
 */
export function requestSystemPermission(
  pluginId: string,
  pluginName: string,
  code: string,
  reason: string
): Promise<{ granted: boolean; remembered: boolean }> {
  const remembered = getRememberedDecision(pluginId, code);
  if (remembered) {
    return Promise.resolve({ granted: remembered === 'granted', remembered: true });
  }
  return new Promise<{ granted: boolean; remembered: boolean }>((resolve) => {
    const req: PermissionRequest = {
      pluginId,
      pluginName,
      code,
      reason: reason || defaultReason(code),
      resolve: (decision) => resolve({ granted: decision === 'granted', remembered: false }),
    };
    window.dispatchEvent(new CustomEvent('lf:permission-request', { detail: req }));
  });
}

function defaultReason(code: string): string {
  return `该插件请求系统级权限「${code}」。`;
}
