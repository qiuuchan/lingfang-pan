import { describe, expect, it, beforeEach } from 'vitest';
import {
  progressKey,
  doneKey,
  loadProgress,
  saveProgress,
  loadDone,
  saveDone,
  clearDone,
  isAllDone,
} from './onboarding-progress';
import { TASK_STEPS } from '@/components/onboarding/task-steps';

// vitest node 环境无 localStorage，用最小内存实现（key→value 字符串存储）模拟。
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.has(key) ? store.get(key)! : null; },
    key(index: number) { return Array.from(store.keys())[index] ?? null; },
    setItem(key: string, value: string) { store.set(key, String(value)); },
    removeItem(key: string) { store.delete(key); },
  };
}

beforeEach(() => {
  const mem = createMemoryStorage();
  // 挂到 globalThis 让被测代码的 localStorage 全局可访问。
  (globalThis as unknown as { localStorage: Storage }).localStorage = mem;
});

describe('progressKey / doneKey', () => {
  it('按 userId 拼 key，对齐 lf: 前缀', () => {
    expect(progressKey('user-1')).toBe('lf:task-progress:user-1');
    expect(doneKey('user-1')).toBe('lf:onboarding-done:user-1');
  });

  it('userId 为 null 时用 none 兜底', () => {
    expect(progressKey(null)).toBe('lf:task-progress:none');
    expect(doneKey(null)).toBe('lf:onboarding-done:none');
  });

  it('userId 为空串时也用 none 兜底', () => {
    expect(progressKey('')).toBe('lf:task-progress:none');
    expect(doneKey('')).toBe('lf:onboarding-done:none');
  });
});

describe('loadProgress', () => {
  it('无记录时返回全 false（长度对齐 TASK_STEPS）', () => {
    const done = loadProgress('user-2', TASK_STEPS);
    expect(done).toHaveLength(TASK_STEPS.length);
    expect(done.every((v) => v === false)).toBe(true);
  });

  it('读取已保存的进度并按 index 映射', () => {
    saveProgress('user-3', [true, false, true, false, true]);
    const done = loadProgress('user-3', TASK_STEPS);
    expect(done).toEqual([true, false, true, false, true]);
  });

  it('已保存数组短于步骤数时缺失位补 false', () => {
    saveProgress('user-4', [true, true]);
    const done = loadProgress('user-4', TASK_STEPS);
    expect(done).toEqual([true, true, false, false, false]);
  });

  it('非法 JSON 回退到全 false', () => {
    localStorage.setItem(progressKey('user-5'), '{not json');
    const done = loadProgress('user-5', TASK_STEPS);
    expect(done.every((v) => v === false)).toBe(true);
  });

  it('存储值非数组（对象）时回退到全 false', () => {
    localStorage.setItem(progressKey('user-6'), '{"a":1}');
    const done = loadProgress('user-6', TASK_STEPS);
    expect(done.every((v) => v === false)).toBe(true);
  });
});

describe('saveProgress / loadProgress 往返', () => {
  it('写入后可读回（不丢布尔语义，假值序列化为 false）', () => {
    saveProgress('user-7', [true, false, true, false, true]);
    const raw = localStorage.getItem(progressKey('user-7'));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual([true, false, true, false, true]);
    expect(loadProgress('user-7', TASK_STEPS)).toEqual([true, false, true, false, true]);
  });
});

describe('loadDone / saveDone / clearDone', () => {
  it('无标记时 loadDone 返回 false', () => {
    expect(loadDone('user-8')).toBe(false);
  });

  it('saveDone 后 loadDone 返回 true', () => {
    saveDone('user-8');
    expect(loadDone('user-8')).toBe(true);
  });

  it('clearDone 撤回完成标记', () => {
    saveDone('user-9');
    expect(loadDone('user-9')).toBe(true);
    clearDone('user-9');
    expect(loadDone('user-9')).toBe(false);
  });

  it('done key 与 progress key 互不干扰', () => {
    saveProgress('user-10', [true, false, false, false, false]);
    saveDone('user-10');
    expect(localStorage.getItem(progressKey('user-10'))).not.toBe(localStorage.getItem(doneKey('user-10')));
    expect(loadDone('user-10')).toBe(true);
    expect(loadProgress('user-10', TASK_STEPS)[0]).toBe(true);
  });
});

describe('isAllDone', () => {
  it('全 true 返回 true', () => {
    expect(isAllDone([true, true, true, true, true])).toBe(true);
  });

  it('含 false 返回 false', () => {
    expect(isAllDone([true, false, true, true, true])).toBe(false);
  });

  it('空数组返回 false（避免「无步骤即完成」的误导）', () => {
    expect(isAllDone([])).toBe(false);
  });
});
