// version.spec.ts —— isVersionNewer / parseVersion 单测。
import { describe, it, expect } from 'vitest';
import { isVersionNewer, parseVersion } from './version';

describe('parseVersion', () => {
  it('解析标准 x.y.z', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.0.0')).toEqual([0, 0, 0]);
  });
  it('忽略 pre-release 后缀（取前 x.y.z）', () => {
    expect(parseVersion('1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseVersion('2.0.0-rc.1+build.5')).toEqual([2, 0, 0]);
  });
  it('非法格式回退 [0,0,0]', () => {
    expect(parseVersion('')).toEqual([0, 0, 0]);
    expect(parseVersion('abc')).toEqual([0, 0, 0]);
    expect(parseVersion('1')).toEqual([0, 0, 0]);
  });
});

describe('isVersionNewer', () => {
  it('高版本为 true', () => {
    expect(isVersionNewer('0.0.2', '0.0.1')).toBe(true);
    expect(isVersionNewer('0.1.0', '0.0.9')).toBe(true);
    expect(isVersionNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isVersionNewer('2.0.0', '1.9.9')).toBe(true);
  });
  it('同版本为 false（严格大于，不含相等）', () => {
    expect(isVersionNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isVersionNewer('0.0.0', '0.0.0')).toBe(false);
  });
  it('低版本为 false', () => {
    expect(isVersionNewer('0.0.1', '0.0.2')).toBe(false);
    expect(isVersionNewer('1.0.0', '2.0.0')).toBe(false);
  });
  it('非法版本按 0.0.0 比较', () => {
    expect(isVersionNewer('bad', '0.0.0')).toBe(false); // 0.0.0 vs 0.0.0
    expect(isVersionNewer('0.0.1', 'bad')).toBe(true);  // 0.0.1 vs 0.0.0
  });
});
