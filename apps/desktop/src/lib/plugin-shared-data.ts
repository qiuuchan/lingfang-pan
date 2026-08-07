// plugin-shared-data.ts — 插件间数据互通（Task 5）。
//
// 背景：B 插件需要直接读 A 插件产出的数据（典型：登录插件 A 写入凭证，业务插件 B 读取）。
// 设计：
// - 每个插件有自己的命名空间 key 前缀 lf:plugin-shared:{pluginId}:，只能由该插件自身写入
//   （写入方 pluginId 来自宿主侧 RuntimeMessage 的 pluginId 字段，不由调用方自报，防冒充）。
// - 读取方显式传 sourcePluginId 跨命名空间取值——即「A 主动写、B 显式按 A 的 id 取」的 opt-in 共享。
// - 持久化到 localStorage（跨会话保留，登录态不需重登）。敏感数据是否落本地由插件作者按需决定
//   （平台不强制加密；若需更高安全可后续迁到 Rust 侧 keyring）。
//
// 纯函数（无 React 依赖），便于单测。宿主侧 invokeRuntime 调用，插件侧通过 sdk.plugin.* 触发。

const PREFIX = 'lf:plugin-shared:';

/** 写入本插件命名空间下的共享数据。value 任意可序列化值。返回写入的条目信息。 */
export function setSharedData(
  pluginId: string,
  key: string,
  value: unknown
): { ok: true; key: string; storedAt: string } {
  if (!pluginId) throw new Error('setSharedData 缺少 pluginId');
  if (!key || typeof key !== 'string') throw new Error('setSharedData 缺少 key');
  const storedAt = new Date().toISOString();
  const entry = { value, storedAt, by: pluginId };
  try {
    localStorage.setItem(storageKey(pluginId, key), JSON.stringify(entry));
  } catch (err) {
    // 配额满 / localStorage 禁用：抛出明确错误，调用方提示用户（不静默吞）。
    throw new Error(
      `共享数据写入失败（存储不可用）：${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { ok: true, key, storedAt };
}

/** 读取指定源插件的共享数据（跨插件读取，opt-in：源插件需先 setSharedData 写入）。
 *  返回 { value, storedAt, by } 或 null（不存在）。 */
export function getSharedData(
  sourcePluginId: string,
  key: string
): { value: unknown; storedAt: string; by: string } | null {
  if (!sourcePluginId) throw new Error('getSharedData 缺少 sourcePluginId');
  if (!key || typeof key !== 'string') throw new Error('getSharedData 缺少 key');
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(sourcePluginId, key));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { value?: unknown; storedAt?: string; by?: string };
    return {
      value: parsed.value,
      storedAt: parsed.storedAt ?? '',
      by: parsed.by ?? sourcePluginId,
    };
  } catch {
    // 损坏数据：视为不存在（不抛，避免读取方崩溃）。
    return null;
  }
}

/** 列出某插件已共享的所有 key（便于 B 插件发现 A 提供了哪些数据）。 */
export function listSharedKeys(pluginId: string): string[] {
  if (!pluginId) return [];
  const prefix = storageKey(pluginId, '');
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        keys.push(k.slice(prefix.length));
      }
    }
  } catch {
    return [];
  }
  return keys;
}

/** 清空某插件的全部共享数据（登出/卸载时清理）。 */
export function clearSharedData(pluginId: string): number {
  if (!pluginId) return 0;
  const keys = listSharedKeys(pluginId);
  try {
    keys.forEach((k) => localStorage.removeItem(storageKey(pluginId, k)));
  } catch {
    /* 忽略 */
  }
  return keys.length;
}

function storageKey(pluginId: string, key: string): string {
  return `${PREFIX}${pluginId}:${key}`;
}
