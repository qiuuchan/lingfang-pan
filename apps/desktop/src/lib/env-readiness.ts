// env-readiness.ts — 环境就绪检测 hook（创建插件前置条件）。
//
// 背景：用户首次进入 PluginCreatorHome 只看到示例输入，不知道要先配模型服务、加入团队，
// 直接 send 才以失败 toast 收场（原因不明）。本 hook 把「环境是否就绪 + 缺什么」前端化，供横幅展示。
//
// 检测项（design 平台缺口 Top7）：
// ① 模型服务是否配了：GET /api/llm/binding 看有 apiKeyHint（脱敏串非空代表已存过 key）。
// ② 后端地址是否配了：apiBase() 非空（无后端地址 api() 会直接抛）。
// ③ 是否加入团队：session.tenantName 非空（未加入团队无法上传团队共享 / 提交市场）。
//
// 返回 { ready, missing, loading }：
// - ready：四项全过为 true。
// - missing：未就绪项的简体中文一句话描述数组（横幅直接 join('；') 展示）。
// - loading：检测进行中（首次拉取未完成），调用方可据此暂不渲染横幅避免闪烁。
//
// 容错：绑定拉取失败不抛，按「未就绪」处理（横幅会提示去设置），避免检测本身炸 UI。

import { useCallback, useEffect, useState } from 'react';
import { api, apiBase } from '@/lib/api';
import type { Session, View } from '@/lib/types';

export interface EnvReadinessResult {
  /** 是否全部就绪（四项全过）。 */
  ready: boolean;
  /** 未就绪项的一句话描述（简体中文），供横幅 join 展示。 */
  missing: string[];
  /** 检测进行中（首次未完成）。 */
  loading: boolean;
}

/** 主动重检（供外部在「用户从设置返回」后调用刷新）。 */
export type RefreshEnvReadiness = () => void;

/** GET /api/llm/binding 出参的最小形态（只关心 binding.apiKeyHint）。 */
interface BindingResponse {
  binding: { apiKeyHint?: string | null } | null;
}

/**
 * 检测创建插件所需的环境前置条件。
 *
 * @param session 当前登录态（取 tenantName 判定是否已加入团队）。
 * @param activeView 当前激活的 View（默认 'home'）。当切回 'home' 时自动重检，
 *                   让用户从设置返回后横幅立即刷新（PluginCreatorHome 常驻挂载，view 切换不卸载）。
 * @returns 就绪状态 + missing 描述 + loading 态 + refresh 重检函数。
 */
export function useEnvReadiness(
  session: Session,
  activeView: View = 'home',
): EnvReadinessResult & { refresh: RefreshEnvReadiness } {
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // 检测单次执行：四项并行查，失败按未就绪处理，绝不抛出（横幅兜底提示用户去设置）。
  const probe = useCallback(async (signal?: { cancelled: boolean }): Promise<void> => {
    // ③ 后端地址（最廉价，先查；无后端地址后续 api() 会直接抛）。
    const backendConfigured = Boolean(apiBase());

    const modelConfigured = await (
      api<BindingResponse>('/api/llm/binding')
        .then((res) => Boolean(res?.binding?.apiKeyHint))
        .catch(() => false)
    );

    // 组件已卸载 / tenantName 已变（依赖变化触发重探）：丢弃本次结果，避免 stale setState。
    if (signal?.cancelled) return;

    const miss: string[] = [];
    if (!backendConfigured) miss.push('未配置公司平台地址');
    if (!modelConfigured) miss.push('未配置模型服务 API 密钥');
    // ④ 是否加入团队：session.tenantName 非空（PENDING_APPROVAL 等中间态也没有 team）。
    if (!session.tenantName) miss.push('未加入团队');

    setMissing(miss);
    setReady(miss.length === 0);
    setLoading(false);
  }, [session.tenantName]);

  // 单一 effect 同时响应 tenantName 变化 + 切回 home，两者都触发一次完整重检。
  // 切回 home 时 loading 会短暂为 true（横幅在探测期间不渲染），探测完按最新结果重渲染——
  // 避免横幅停留在设置前的旧状态。PluginCreatorHome 常驻挂载（view 切换不卸载），
  // 故监听 activeView 才能在用户从设置返回时主动刷新。
  useEffect(() => {
    if (activeView !== 'home') return;
    const signal = { cancelled: false };
    setLoading(true);
    void probe(signal);
    return () => { signal.cancelled = true; };
  }, [probe, activeView]);

  return {
    ready,
    missing,
    loading,
    // 手动重检（用户从设置返回后调用刷新）；不重置 loading 态（refresh 通常已是二次调用，无需 loading 闪烁）。
    refresh: () => { void probe({ cancelled: false }); },
  };
}
