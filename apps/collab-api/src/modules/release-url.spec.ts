import { describe, expect, it } from 'vitest';
import { absoluteUpdateAssetUrl, requestBaseUrl } from './release-url';

describe('absoluteUpdateAssetUrl', () => {
  it('keeps absolute URLs unchanged', () => {
    expect(absoluteUpdateAssetUrl('https://cdn.example.com/setup.exe')).toBe('https://cdn.example.com/setup.exe');
  });

  it('resolves root-relative download URLs against the request base URL', () => {
    expect(absoluteUpdateAssetUrl('/downloads/setup.exe', 'https://api.example.com')).toBe('https://api.example.com/downloads/setup.exe');
  });

  it('throws when a relative URL has no base URL', () => {
    expect(() => absoluteUpdateAssetUrl('/downloads/setup.exe')).toThrow('缺少请求 base URL');
  });

  it('builds a request base URL from protocol and Host header', () => {
    const request = { protocol: 'https', get: (name: string) => name === 'host' ? 'api.example.com' : undefined };
    expect(requestBaseUrl(request)).toBe('https://api.example.com');
  });

  it('throws when the request Host header is missing', () => {
    const request = { protocol: 'https', get: () => undefined };
    expect(() => requestBaseUrl(request)).toThrow('缺少 Host header');
  });
});
