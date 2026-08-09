// relay-models.ts —— 读取 relay 暴露的模型元信息（contextWindow）。
//
// 背景（betav2 重构）：旧创建器上下文压缩阈值硬编码 5000 字符，与后台配的 context window
// （如 256000 token）严重错配——只用了上游容量的 1.3% 就开始丢历史。
// 重构后 relay /api/relay/v1/models 返回每个 tier 的 contextWindow（token，候选模型最小值），
// 本文件封装读取 + 缓存，供 agent 循环与上下文压缩共用。
//
// 设计：
// - 后端为唯一真相源：前端不硬编码窗口值，只从这里读。
// - 缓存 5 分钟：models 端点变化频率低（管理员调渠道/定价才变），避免每次对话都拉。
// - 登录态变化刷新：setAuthToken 后下次调用自动失效重拉（因 Authorization 头变了，缓存按 token 前缀失效）。
// - 容错：拉取失败或后端未返回 contextWindow（null）→ 保守默认值，不阻断对话。
import { api, getAuthToken } from '@/lib/api';

/** 后端返回的 tier 模型元信息（relay listModels data 项的子集）。 */
interface RelayModelInfo {
  id: string; // 'fast' | 'premium'
  contextWindow: number | null;
}

interface RelayModelsResponse {
  object: 'list';
  data: RelayModelInfo[];
}

/** 后端未返回 contextWindow（null）或拉取失败时的保守默认（token）。 */
export const FALLBACK_CONTEXT_WINDOW: Record<'fast' | 'premium', number> = {
  fast: 128_000,
  premium: 200_000,
};

/** 每个登录用户的上下文窗口（按 tier）。 */
export interface ContextWindow {
  fast: number;
  premium: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

interface CacheEntry {
  value: ContextWindow;
  fetchedAt: number;
  /** 缓存对应的 auth token 前缀（token 变了缓存失效）。 */
  tokenFingerprint: string;
}

let cache: CacheEntry | null = null;

/** 取当前 token 的指纹（前 16 字符）用于缓存失效判定，避免读到上一个登录用户的窗口。 */
function tokenFingerprint(): string {
  // P1-1：token 已移出 localStorage，改从 api.ts 的内存态读取（与 setAuthToken 单一真相源一致）。
  // 仍取前 16 字符做缓存失效判定，避免读到上一个登录用户的窗口。
  try {
    const t = getAuthToken();
    return t ? t.slice(0, 16) : 'no-auth';
  } catch {
    return 'no-auth';
  }
}

/**
 * 拉取并解析 relay models，返回每个 tier 的 contextWindow。
 * 内部带 5 分钟缓存 + token 指纹失效。
 * 后端 null 或拉取失败 → 保守默认值（不抛错，保证对话流程不中断）。
 */
export async function fetchContextWindow(forceRefresh = false): Promise<ContextWindow> {
  const fp = tokenFingerprint();
  const now = Date.now();
  if (
    !forceRefresh &&
    cache &&
    cache.tokenFingerprint === fp &&
    now - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return cache.value;
  }

  let result: ContextWindow;
  try {
    const resp = await api<RelayModelsResponse>('/api/relay/v1/models', { method: 'GET' });
    const find = (id: string) => resp.data?.find((m) => m.id === id)?.contextWindow ?? null;
    const fast = find('fast');
    const premium = find('premium');
    result = {
      fast: typeof fast === 'number' && fast > 0 ? fast : FALLBACK_CONTEXT_WINDOW.fast,
      premium:
        typeof premium === 'number' && premium > 0 ? premium : FALLBACK_CONTEXT_WINDOW.premium,
    };
  } catch {
    // 后端不可达 / 未配置 / 旧版本无 contextWindow 字段 → 保守默认，不阻断对话。
    result = { ...FALLBACK_CONTEXT_WINDOW };
  }

  cache = { value: result, fetchedAt: now, tokenFingerprint: fp };
  return result;
}

/** 同步读取缓存值（无则返回默认）。用于不便 await 的场景（如 store 初始化）。 */
export function getCachedContextWindow(): ContextWindow {
  const fp = tokenFingerprint();
  const now = Date.now();
  if (cache && cache.tokenFingerprint === fp && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  return { ...FALLBACK_CONTEXT_WINDOW };
}
