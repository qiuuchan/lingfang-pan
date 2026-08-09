import { describe, expect, it } from 'vitest';
import {
  assertDryRunPayloadSize,
  highestSemVer,
  normalizeReleaseSource,
  normalizeStoredAdaptationStatus,
  PLUGIN_DRY_RUN_MAX_FILES,
  releaseDetailJson,
} from './plugin-registry-model';

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
      adaptationReport: null,
      adaptationStatus: 'NOT_RUN',
    });
  });

  it('accepts the ADAPT ingest channel used by the adaptation pipeline', () => {
    expect(normalizeReleaseSource({ ingestChannel: 'adapt' }).ingestChannel).toBe('ADAPT');
  });

  it('keeps a well-formed adaptation report and marks the release as ADAPT-ingested', () => {
    const report = JSON.stringify({ status: 'ADAPTED_PASSED', engineVersion: '0.1.0' });
    expect(
      normalizeReleaseSource({ ingestChannel: 'desktop', adaptationReport: report })
    ).toMatchObject({
      adaptationReport: report,
      adaptationStatus: 'ADAPTED_PASSED',
      ingestChannel: 'ADAPT',
    });
  });

  it('still records a failed adaptation run as ADAPT-ingested', () => {
    // 跑过但没过也是走了流水线，审核侧要能按渠道捞出来看报告。
    expect(
      normalizeReleaseSource({
        ingestChannel: 'desktop',
        adaptationReport: JSON.stringify({ status: 'NEEDS_HUMAN' }),
      })
    ).toMatchObject({ adaptationStatus: 'NEEDS_HUMAN', ingestChannel: 'ADAPT' });
  });

  it('downgrades unknown, oversized or unparsable adaptation reports to NOT_RUN', () => {
    // 客户端自造状态不得直接落库成为审核依据。
    expect(
      normalizeReleaseSource({ adaptationReport: JSON.stringify({ status: 'TOTALLY_FINE' }) })
    ).toMatchObject({ adaptationStatus: 'NOT_RUN' });
    expect(normalizeReleaseSource({ adaptationReport: 'not json' })).toMatchObject({
      adaptationReport: null,
      adaptationStatus: 'NOT_RUN',
    });
    expect(
      normalizeReleaseSource({
        ingestChannel: 'desktop',
        adaptationReport: JSON.stringify({ status: 'ADAPTED_PASSED', pad: 'x'.repeat(33 * 1024) }),
      })
    ).toMatchObject({
      adaptationReport: null,
      adaptationStatus: 'NOT_RUN',
      ingestChannel: 'DESKTOP',
    });
  });

  it('caps adaptation dry-run payloads at the request boundary', () => {
    expect(() => assertDryRunPayloadSize([{ content: 'ok' }])).not.toThrow();
    expect(() =>
      assertDryRunPayloadSize(Array.from({ length: PLUGIN_DRY_RUN_MAX_FILES + 1 }, () => ({})))
    ).toThrow(/最多支持/);
    expect(() =>
      assertDryRunPayloadSize([{ content: 'x'.repeat(5 * 1024 * 1024) }, { content: 'x'.repeat(5 * 1024 * 1024) }])
    ).toThrow(/超过 8 MiB/);
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

  it('withholds run evidence from non-owner teams in release detail', () => {
    const release = {
      id: 'r1',
      packageId: 'p1',
      version: '1.0.0',
      manifest: {},
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      status: 'PUBLISHED',
      marketReviewStatus: 'APPROVED',
      targetPlatform: 'windows-x64',
      adaptationStatus: 'ADAPTED_PASSED',
      runEvidence: '{"status":"ADAPTED_PASSED","stderr":"C:/Users/dev/secret-path"}',
      createdAt: new Date('2026-08-09T00:00:00.000Z'),
    };
    // 报告含开发者本机路径与 stderr 片段，购买方不该看到。
    expect(releaseDetailJson(release).runEvidence).toBeNull();
    expect(releaseDetailJson(release, { includeRunEvidence: true }).runEvidence).toBe(
      release.runEvidence
    );
    expect(releaseDetailJson(release).adaptationStatus).toBe('ADAPTED_PASSED');
  });

  it('falls back to NOT_RUN for legacy rows without a stored adaptation status', () => {
    expect(normalizeStoredAdaptationStatus(undefined)).toBe('NOT_RUN');
    expect(normalizeStoredAdaptationStatus('WHATEVER')).toBe('NOT_RUN');
    expect(normalizeStoredAdaptationStatus('NEEDS_HUMAN')).toBe('NEEDS_HUMAN');
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
