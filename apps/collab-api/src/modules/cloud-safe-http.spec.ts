import { describe, expect, it, vi } from 'vitest';
import {
  SafeOutboundHttpClient,
  isPublicEndpointAddress,
  type SafeHttpTransport,
} from './cloud-safe-http';

async function* body(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}

describe('SafeOutboundHttpClient', () => {
  it('rejects unsafe URL forms and non-public address ranges', () => {
    const client = new SafeOutboundHttpClient();
    for (const url of [
      'http://example.com/action',
      'https://user:pass@example.com/action',
      'https://localhost/action',
      'https://127.0.0.1/action',
      'https://[::1]/action',
      'https://example.com:444/action',
      'https://example.com/action#secret',
    ]) {
      expect(() => client.validateUrl(url)).toThrow();
    }
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicEndpointAddress(address)).toBe(false);
    }
    expect(isPublicEndpointAddress('8.8.8.8')).toBe(true);
    expect(isPublicEndpointAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects the entire DNS result when any answer is private', async () => {
    const transport = vi.fn<SafeHttpTransport>();
    const client = new SafeOutboundHttpClient({
      resolver: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.2', family: 4 },
      ],
      transport,
    });
    await expect(client.request({ url: 'https://example.com/action' })).rejects.toMatchObject({
      code: 'cloud_endpoint_unsafe',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('pins a validated address and rejects redirects', async () => {
    const close = vi.fn();
    const transport = vi.fn<SafeHttpTransport>(async () => ({
      statusCode: 302,
      headers: { location: 'https://other.example/action' },
      body: body(''),
      close,
    }));
    const client = new SafeOutboundHttpClient({
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport,
    });
    await expect(client.request({ url: 'https://example.com/action' })).rejects.toMatchObject({
      code: 'cloud_endpoint_redirect_denied',
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { address: '8.8.8.8', family: 4 },
      })
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('bounds response bytes before returning endpoint content', async () => {
    const close = vi.fn();
    const client = new SafeOutboundHttpClient({
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: async () => ({ statusCode: 200, headers: {}, body: body('oversized'), close }),
    });
    await expect(
      client.request({
        url: 'https://example.com/action',
        responseLimitBytes: 4,
      })
    ).rejects.toMatchObject({ code: 'cloud_response_too_large' });
    expect(close).toHaveBeenCalledOnce();
  });
});
