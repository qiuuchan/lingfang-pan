import { describe, expect, it } from 'vitest';

import {
  contentSecurityPolicy,
  decodeAssetPath,
  decodeHeaderPath,
  escapeAttribute,
  exactOrigin,
  injectPreviewBootstrap,
  inlineScriptHashes,
  validateConfig,
} from './server';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_KEY = 'preview-service-key-32-characters-minimum';

describe('exactOrigin', () => {
  it('accepts an absolute HTTP(S) origin with or without a trailing slash', () => {
    expect(exactOrigin('http://x.test/', 'NAME')).toBe('http://x.test');
    expect(exactOrigin('https://x.test', 'NAME')).toBe('https://x.test');
    expect(exactOrigin('https://x.test:8443/', 'NAME')).toBe('https://x.test:8443');
  });

  it('rejects origins carrying userinfo credentials', () => {
    expect(() => exactOrigin('http://user@x.test/', 'MY_ORIGIN')).toThrow(/MY_ORIGIN/);
    expect(() => exactOrigin('http://user:pass@x.test/', 'MY_ORIGIN')).toThrow(/exact/);
  });

  it('rejects origins carrying a path, query, or fragment', () => {
    expect(() => exactOrigin('http://x.test/a', 'MY_ORIGIN')).toThrow(/MY_ORIGIN/);
    expect(() => exactOrigin('http://x.test/?x=1', 'MY_ORIGIN')).toThrow(/MY_ORIGIN/);
    expect(() => exactOrigin('http://x.test/#x', 'MY_ORIGIN')).toThrow(/MY_ORIGIN/);
  });

  it('rejects non-HTTP(S) protocols and unparsable values', () => {
    expect(() => exactOrigin('ftp://x.test/', 'MY_ORIGIN')).toThrow(/MY_ORIGIN/);
    expect(() => exactOrigin('javascript:alert(1)', 'MY_ORIGIN')).toThrow(/MY_ORIGIN/);
    expect(() => exactOrigin('x.test', 'MY_ORIGIN')).toThrow(/MY_ORIGIN must be an absolute/);
  });
});

describe('decodeAssetPath', () => {
  it('decodes a plain nested asset path', () => {
    expect(decodeAssetPath('ui/index.html')).toBe('ui/index.html');
    expect(decodeAssetPath('index.html')).toBe('index.html');
    expect(decodeAssetPath('ui/a%20b.css')).toBe('ui/a b.css');
  });

  it('rejects literal and encoded traversal segments', () => {
    expect(decodeAssetPath('..')).toBeNull();
    expect(decodeAssetPath('ui/../secret.txt')).toBeNull();
    expect(decodeAssetPath('ui/%2e%2e/secret.txt')).toBeNull();
    expect(decodeAssetPath('%2E%2E')).toBeNull();
    expect(decodeAssetPath('ui/./a.js')).toBeNull();
  });

  it('rejects encoded separators smuggled inside a segment', () => {
    expect(decodeAssetPath('ui%2F..%2Fsecret.txt')).toBeNull();
    expect(decodeAssetPath('ui%2Fsecret.txt')).toBeNull();
    expect(decodeAssetPath('ui%5Csecret.txt')).toBeNull();
    expect(decodeAssetPath('ui\\secret.txt')).toBeNull();
  });

  it('rejects empty segments and malformed percent-encoding', () => {
    expect(decodeAssetPath('')).toBeNull();
    expect(decodeAssetPath('ui//index.html')).toBeNull();
    expect(decodeAssetPath('/index.html')).toBeNull();
    expect(decodeAssetPath('ui/')).toBeNull();
    expect(decodeAssetPath('%zz')).toBeNull();
  });

  it('rejects paths longer than 512 characters', () => {
    expect(decodeAssetPath('a'.repeat(512))).toBe('a'.repeat(512));
    expect(decodeAssetPath('a'.repeat(513))).toBeNull();
  });
});

describe('decodeHeaderPath', () => {
  it('falls back to index.html for a missing or malformed header', () => {
    expect(decodeHeaderPath(null)).toBe('index.html');
    expect(decodeHeaderPath('')).toBe('index.html');
    expect(decodeHeaderPath('%')).toBe('index.html');
  });

  it('decodes a percent-encoded entry path', () => {
    expect(decodeHeaderPath(encodeURIComponent('a/b'))).toBe('a/b');
    expect(decodeHeaderPath(encodeURIComponent('ui/index.html'))).toBe('ui/index.html');
  });
});

describe('escapeAttribute', () => {
  it('escapes every attribute-breaking character', () => {
    expect(escapeAttribute('&"<>')).toBe('&amp;&quot;&lt;&gt;');
  });

  it('neutralises an attribute break-out payload', () => {
    expect(escapeAttribute('"><script>alert(1)</script>')).toBe(
      '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(escapeAttribute('ui/')).toBe('ui/');
  });
});

describe('inlineScriptHashes', () => {
  it('hashes inline script bodies', () => {
    const hashes = inlineScriptHashes('<script>x</script>');
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
  });

  it('ignores external scripts that carry a src attribute', () => {
    expect(inlineScriptHashes('<script src="/_lingfang/bridge.js"></script>')).toEqual([]);
    expect(inlineScriptHashes('<script type="module" src="/a.js"></script>')).toEqual([]);
    expect(inlineScriptHashes('<p>no scripts here</p>')).toEqual([]);
  });

  it('deduplicates identical inline bodies and separates different ones', () => {
    expect(inlineScriptHashes('<script>x</script><script>x</script>')).toHaveLength(1);
    expect(inlineScriptHashes('<script>x</script><script>y</script>')).toHaveLength(2);
  });
});

describe('contentSecurityPolicy', () => {
  it('locks the preview document down by default', () => {
    const policy = contentSecurityPolicy(['http://w.test']);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain('frame-ancestors http://w.test');
  });

  it('only frames inside the configured Web app origins', () => {
    const policy = contentSecurityPolicy(['http://w.test', 'https://w2.test']);
    expect(policy).toContain('frame-ancestors http://w.test https://w2.test');
    expect(policy).not.toContain('frame-ancestors *');
  });

  it('allow-lists inline scripts by hash instead of unsafe-inline', () => {
    const policy = contentSecurityPolicy(['http://w.test'], '<script>x</script>');
    expect(policy).toMatch(/script-src 'self' 'sha256-/);
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe('injectPreviewBootstrap', () => {
  it('injects the base tag and bridge right after an existing head', () => {
    const html = injectPreviewBootstrap('<html><head></head></html>', SESSION_ID, 'ui/').toString(
      'utf8'
    );
    expect(html).toContain(`<base href="/sessions/${SESSION_ID}/ui/">`);
    expect(html).toContain('<script src="/_lingfang/bridge.js"></script>');
    expect(html).toBe(
      `<html><head><base href="/sessions/${SESSION_ID}/ui/"><script src="/_lingfang/bridge.js"></script></head></html>`
    );
  });

  it('derives the base directory from the entry path', () => {
    const html = injectPreviewBootstrap(
      '<html><head></head></html>',
      SESSION_ID,
      'ui/index.html'
    ).toString('utf8');
    expect(html).toContain(`<base href="/sessions/${SESSION_ID}/ui/">`);
    const root = injectPreviewBootstrap('<head></head>', SESSION_ID, 'index.html').toString('utf8');
    expect(root).toContain(`<base href="/sessions/${SESSION_ID}/">`);
  });

  it('prepends the injection when no head element exists', () => {
    const html = injectPreviewBootstrap('<p>hi</p>', SESSION_ID, 'ui/').toString('utf8');
    expect(html.startsWith(`<base href="/sessions/${SESSION_ID}/ui/">`)).toBe(true);
    expect(html.endsWith('<p>hi</p>')).toBe(true);
  });

  it('escapes the entry directory before writing it into the base attribute', () => {
    const html = injectPreviewBootstrap(
      '<head></head>',
      SESSION_ID,
      '"><script>alert(1)</script>/a.html'
    ).toString('utf8');
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/');
  });
});

describe('validateConfig', () => {
  const base = {
    internalOrigin: 'http://api.example.test',
    serviceKey: SERVICE_KEY,
    webAppOrigins: ['http://web.example.test'],
  };

  it('normalises and deduplicates a valid configuration', () => {
    const config = validateConfig({
      ...base,
      webAppOrigins: ['http://web.example.test/', 'http://web.example.test'],
      publicOrigin: 'http://preview.example.test/',
    });
    expect(config.internalOrigin).toBe('http://api.example.test');
    expect(config.webAppOrigins).toEqual(['http://web.example.test']);
    expect(config.publicOrigin).toBe('http://preview.example.test');
    expect(typeof config.fetchImplementation).toBe('function');
  });

  it('rejects a service key shorter than 32 characters', () => {
    expect(() => validateConfig({ ...base, serviceKey: 'a'.repeat(31) })).toThrow(
      /at least 32 characters/
    );
    expect(() => validateConfig({ ...base, serviceKey: '' })).toThrow(/at least 32 characters/);
  });

  it('rejects an empty Web app origin list', () => {
    expect(() => validateConfig({ ...base, webAppOrigins: [] })).toThrow(
      /PREVIEW_WEB_APP_ORIGINS must contain at least one origin/
    );
  });

  it('rejects a public origin that reuses a Web app origin', () => {
    expect(() => validateConfig({ ...base, publicOrigin: 'http://web.example.test/' })).toThrow(
      /must differ/
    );
  });

  it('rejects malformed origins', () => {
    expect(() => validateConfig({ ...base, internalOrigin: 'api.example.test' })).toThrow(
      /COLLAB_API_INTERNAL_ORIGIN/
    );
    expect(() => validateConfig({ ...base, webAppOrigins: ['http://web.test/app'] })).toThrow(
      /PREVIEW_WEB_APP_ORIGINS/
    );
  });
});
