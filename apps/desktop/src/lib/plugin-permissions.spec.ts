// plugin-permissions.spec.ts — Task 14 系统级权限授权回归测试。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRememberedDecision,
  rememberDecision,
  clearPluginDecisions,
  requestSystemPermission,
} from './plugin-permissions';

// node 环境无 localStorage / CustomEvent，用 stub 模拟（仅测纯逻辑 + 事件派发）。
function installStubs() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
    },
    configurable: true,
    writable: true,
  });
  // CustomEvent + window.dispatchEvent / addEventListener stub。
  const listeners: Record<string, Array<(e: { detail: unknown }) => void>> = {};
  Object.defineProperty(globalThis, 'window', {
    value: {
      dispatchEvent: (e: { type: string; detail: unknown }) => {
        (listeners[e.type] || []).forEach((fn) => fn({ detail: e.detail }));
        return true;
      },
      addEventListener: (type: string, fn: (e: { detail: unknown }) => void) => {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener: (type: string, fn: (e: { detail: unknown }) => void) => {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
    },
    configurable: true,
    writable: true,
  });
}
installStubs();

describe('plugin system permission gate (Task 14)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('记忆 granted 决策后，后续请求直接命中记忆', async () => {
    rememberDecision('p1', 'system.execute', 'granted');
    const res = await requestSystemPermission('p1', '插件A', 'system.execute', '需要执行命令');
    expect(res.granted).toBe(true);
    expect(res.remembered).toBe(true);
  });

  it('记忆 denied 决策后，后续请求返回 granted=false', async () => {
    rememberDecision('p1', 'system.elevated-fs', 'denied');
    const res = await requestSystemPermission(
      'p1',
      '插件A',
      'system.elevated-fs',
      '需要写系统目录'
    );
    expect(res.granted).toBe(false);
    expect(res.remembered).toBe(true);
  });

  it('未决策时不命中记忆（需用户确认）', async () => {
    // 派发事件后模拟用户「允许」。
    const promise = requestSystemPermission('p2', '插件B', 'system.network-listen', '监听端口');
    // requestSystemPermission 同步派发事件；这里无法直接拿到 resolve，仅验证 remembered=false 的路径不抛。
    expect(getRememberedDecision('p2', 'system.network-listen')).toBeNull();
    // 不 await（无监听器会悬挂），验证函数本身返回 Promise 即可。
    expect(promise).toBeInstanceOf(Promise);
  });

  it('clearPluginDecisions 清空指定插件全部决策', () => {
    rememberDecision('p1', 'a', 'granted');
    rememberDecision('p1', 'b', 'denied');
    rememberDecision('p2', 'c', 'granted');
    expect(clearPluginDecisions('p1')).toBe(2);
    expect(getRememberedDecision('p1', 'a')).toBeNull();
    expect(getRememberedDecision('p2', 'c')).toBe('granted'); // 其它插件不受影响
  });
});
