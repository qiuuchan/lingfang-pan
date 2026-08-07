import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_LABELS,
  normalizePluginProvenance,
  sanitizePluginSourceLabel,
} from './plugin-provenance';

describe('plugin provenance', () => {
  it('uses the shared label for an empty source label', () => {
    expect(normalizePluginProvenance({ sourceKind: 'LINGFANG_CREATOR' })).toEqual({
      sourceKind: 'LINGFANG_CREATOR',
      sourceLabel: DEFAULT_SOURCE_LABELS.LINGFANG_CREATOR,
    });
  });

  it('removes control characters and enforces the contract length', () => {
    const label = sanitizePluginSourceLabel(`  Cursor\u0000${'x'.repeat(100)}  `);
    expect(label).not.toContain('\u0000');
    expect([...label]).toHaveLength(80);
  });

  it.each([
    'C:\\Users\\demo\\plugin',
    'Imported from /Users/demo/plugin',
    '来源：/Users/demo/private-plugin',
    'source`/Users/demo/private-plugin',
    'source:/Users/demo/private-plugin',
    '/etc/lingfang/plugin',
    'file:///home/demo/plugin',
    '\\\\server\\share\\plugin',
  ])('does not allow a local absolute path in release provenance: %s', (path) => {
    expect(sanitizePluginSourceLabel(path)).toBe('');
  });

  it('does not mistake an HTTPS URL for a local path', () => {
    expect(sanitizePluginSourceLabel('Docs https://example.com/plugins/demo')).toBe(
      'Docs https://example.com/plugins/demo'
    );
  });
});
