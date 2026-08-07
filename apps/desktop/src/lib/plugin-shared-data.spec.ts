// plugin-shared-data.spec.ts — Task 5 插件间数据互通回归测试。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setSharedData,
  getSharedData,
  listSharedKeys,
  clearSharedData,
} from './plugin-shared-data';

// vitest 为 node 环境（无 localStorage），用内存 stub 模拟（仅测纯函数逻辑）。
function installLocalStorageStub() {
  const store = new Map<string, string>();
  const ls = {
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
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    configurable: true,
    writable: true,
  });
}

installLocalStorageStub();

describe('plugin shared data (Task 5)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('A 写入、B 读取（跨插件 opt-in 共享）', () => {
    setSharedData('plugin-a', 'credential', { token: 'abc', userId: 1 });
    const got = getSharedData('plugin-a', 'credential');
    expect(got).not.toBeNull();
    expect(got?.value).toEqual({ token: 'abc', userId: 1 });
    expect(got?.by).toBe('plugin-a');
    expect(typeof got?.storedAt).toBe('string');
  });

  it('未写入的 key 返回 null（不抛）', () => {
    expect(getSharedData('plugin-a', 'missing')).toBeNull();
  });

  it('命名空间隔离：A 的数据 B 用错 key 取不到', () => {
    setSharedData('plugin-a', 'secret', 'a-value');
    expect(getSharedData('plugin-a', 'other')).toBeNull();
    expect(getSharedData('plugin-b', 'secret')).toBeNull();
  });

  it('listSharedKeys 列出本插件全部共享 key', () => {
    setSharedData('plugin-a', 'k1', 1);
    setSharedData('plugin-a', 'k2', 2);
    setSharedData('plugin-b', 'k3', 3); // 其它插件的不列出
    expect(listSharedKeys('plugin-a').sort()).toEqual(['k1', 'k2']);
  });

  it('clearSharedData 清空本插件数据（登出/卸载）', () => {
    setSharedData('plugin-a', 'k1', 1);
    setSharedData('plugin-a', 'k2', 2);
    expect(clearSharedData('plugin-a')).toBe(2);
    expect(getSharedData('plugin-a', 'k1')).toBeNull();
  });

  it('损坏数据视为不存在（不抛）', () => {
    localStorage.setItem('lf:plugin-shared:plugin-a:bad', '{not json');
    expect(getSharedData('plugin-a', 'bad')).toBeNull();
  });

  it('缺参抛明确错误', () => {
    expect(() => setSharedData('', 'k', 'v')).toThrow();
    expect(() => setSharedData('p', '', 'v')).toThrow();
    expect(() => getSharedData('', 'k')).toThrow();
  });

  it('凭证互通场景：登录插件 A 存 token，业务插件 B 取用', () => {
    // 模拟登录插件 A 登录成功后写入凭证。
    setSharedData('lingfang-login', 'session', { token: 'JWT-xxx', expiresAt: 9999 });
    // 业务插件 B 用 A 的 id 读取。
    const cred = getSharedData('lingfang-login', 'session');
    expect(cred?.value).toEqual({ token: 'JWT-xxx', expiresAt: 9999 });
  });
});
