import { describe, expect, it } from 'vitest';
import { assertPreviewServiceKey } from './web-preview-asset.controller';

describe('plugin preview internal service authentication', () => {
  const expected = 'preview-service-key-32-characters-minimum';

  it('accepts only the exact service key', () => {
    expect(() => assertPreviewServiceKey(expected, expected)).not.toThrow();
    expect(() => assertPreviewServiceKey(`${expected}x`, expected)).toThrow();
    expect(() =>
      assertPreviewServiceKey('wrong-key-with-the-same-size-000000000', expected)
    ).toThrow();
  });

  it('fails closed when the service key is missing or weak', () => {
    expect(() => assertPreviewServiceKey(undefined, undefined)).toThrow();
    expect(() => assertPreviewServiceKey('short', 'short')).toThrow();
  });
});
