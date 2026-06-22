// time.spec.ts — Task 4a 时间戳解析回归测试。
// 旧后端产出 `epoch.毫秒Z`（如 1719045678.123Z），new Date 无法解析 → 前端「Invalid Date」。
// 新后端产出 RFC 3339（2024-06-22T08:41:18.123Z）。parseTimestamp 须同时兼容二者 + 纯数字 epoch。
import { describe, it, expect } from 'vitest';
import { parseTimestamp, formatTimestamp, relativeTime, formatDate } from './time';

describe('parseTimestamp', () => {
  it('解析新格式 RFC 3339', () => {
    const d = parseTimestamp('2024-06-22T08:41:18.123Z');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2024);
    expect(d!.getUTCMonth()).toBe(5); // 6 月（0-indexed）
    expect(d!.getUTCDate()).toBe(22);
  });

  it('解析旧格式 epoch.毫秒Z（Task 4a 核心）', () => {
    // 1719045678.123Z 应等同于 2024-06-22T08:41:18Z。
    const legacy = parseTimestamp('1719045678.123Z');
    const iso = parseTimestamp('2024-06-22T08:41:18.123Z');
    expect(legacy).not.toBeNull();
    expect(iso).not.toBeNull();
    expect(Math.abs(legacy!.getTime() - iso!.getTime())).toBeLessThanOrEqual(1);
  });

  it('解析纯数字 epoch 秒与毫秒', () => {
    const secs = parseTimestamp('1719045678');
    const ms = parseTimestamp('1719045678123');
    expect(secs!.getTime()).toBe(1719045678_000); // 10 位 → 秒
    expect(ms!.getTime()).toBe(1719045678_123); // 13 位 → 毫秒
  });

  it('无法识别返回 null（而非 Invalid Date）', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('not-a-date')).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});

describe('formatTimestamp', () => {
  it('旧格式不再显示 Invalid Date', () => {
    const out = formatTimestamp('1719045678.123Z');
    expect(out).not.toContain('Invalid Date');
    expect(out).toContain('2024');
  });

  it('空值降级为 —', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp('garbage')).toBe('—');
  });
});

describe('relativeTime / formatDate', () => {
  it('未来/近期时间不抛 Invalid Date', () => {
    expect(relativeTime(Date.now() - 5000)).toContain('刚刚');
    expect(formatDate('1719045678.123Z')).toContain('2024');
  });
});
