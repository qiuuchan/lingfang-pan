import { describe, expect, it } from 'vitest';
import { compareStrictSemVer, parseStrictSemVer } from './plugin-semver';

describe('plugin registry SemVer ordering', () => {
  it('rejects loose and leading-zero versions', () => {
    expect(parseStrictSemVer('v1.2.3')).toBeNull();
    expect(parseStrictSemVer('1.02.3')).toBeNull();
    expect(parseStrictSemVer('1.2')).toBeNull();
  });

  it('orders prereleases below their stable release', () => {
    expect(compareStrictSemVer('1.2.3-alpha.9', '1.2.3-alpha.10')).toBeLessThan(0);
    expect(compareStrictSemVer('1.2.3-rc.1', '1.2.3')).toBeLessThan(0);
    expect(compareStrictSemVer('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('ignores build metadata for precedence', () => {
    expect(compareStrictSemVer('1.2.3+windows.1', '1.2.3+windows.2')).toBe(0);
    expect(parseStrictSemVer('1.2.3+windows-x64')?.prerelease).toBeNull();
  });
});
