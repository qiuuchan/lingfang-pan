import { describe, expect, it } from 'vitest';
import { highestSemVer, normalizeReleaseSource } from './plugin-registry-model';

describe('plugin registry model helpers', () => {
  it('normalizes release provenance from canonical base64url metadata', () => {
    expect(
      normalizeReleaseSource({
        sourceKind: 'external_tool',
        sourceLabelBase64: Buffer.from('Cursor 3.0', 'utf8').toString('base64url'),
        ingestChannel: 'desktop',
      })
    ).toEqual({
      sourceKind: 'EXTERNAL_TOOL',
      sourceLabel: 'Cursor 3.0',
      ingestChannel: 'DESKTOP',
    });
  });

  it('rejects invalid utf-8 and control characters in release source labels', () => {
    expect(() =>
      normalizeReleaseSource({ sourceLabelBase64: Buffer.from([0xff]).toString('base64url') })
    ).toThrow(/来源标签编码无效/);
    expect(() =>
      normalizeReleaseSource({
        sourceLabelBase64: Buffer.from('bad\u0000label').toString('base64url'),
      })
    ).toThrow(/非法字符/);
  });

  it('selects the highest strict semver value', () => {
    expect(
      highestSemVer([
        { id: 'a', version: '1.9.0' },
        { id: 'b', version: '2.0.0-rc.1' },
        { id: 'c', version: '2.0.0' },
      ])
    ).toEqual({ id: 'c', version: '2.0.0' });
  });
});
