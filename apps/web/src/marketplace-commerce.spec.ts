import { describe, expect, it, vi } from 'vitest';
import type { PublicPluginDetail } from '@lingfang/contract';
import { prepareWebSession } from './session';
import { campaignIdFromSearch, loadCampaignAttributionToken, purchaseWebPlugin } from './marketplace-commerce';

function response(value: unknown) {
  return Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('web marketplace commerce', () => {
  it('submits the catalog string price version with cookie CSRF and an idempotency key', async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(() => response({ csrfToken: 'csrf-commerce' }))
      .mockImplementationOnce(() => response({ entitled: true }));
    await prepareWebSession(fetcher);
    await purchaseWebPlugin({
      package_id: '11111111-1111-4111-8111-111111111111',
      price_version: `pv1.${'a'.repeat(43)}`,
    } as PublicPluginDetail, fetcher);
    const [path, init] = fetcher.mock.calls[1];
    expect(path).toBe('/api/web/plugins/11111111-1111-4111-8111-111111111111/purchase');
    expect(init.credentials).toBe('include');
    expect((init.headers as Headers).get('x-csrf-token')).toBe('csrf-commerce');
    expect((init.headers as Headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.parse(String(init.body))).toEqual({ expectedPriceVersion: `pv1.${'a'.repeat(43)}` });
  });

  it('rejects stale non-v1 catalog tokens before any purchase request', async () => {
    const fetcher = vi.fn();
    expect(() => purchaseWebPlugin({ package_id: 'package-1', price_version: 'base_old' } as PublicPluginDetail, fetcher)).toThrow('市场价格版本无效');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('loads a campaign token and freezes it into the purchase command', async () => {
    const campaignId = '22222222-2222-4222-8222-222222222222';
    const packageId = '11111111-1111-4111-8111-111111111111';
    const fetcher = vi.fn()
      .mockImplementationOnce(() => response({ campaign_token: 'ct1.signed', expires_at: '2026-07-16T01:00:00.000Z' }))
      .mockImplementationOnce(() => response({ entitled: true }));
    const attribution = await loadCampaignAttributionToken(campaignId, packageId, fetcher);
    await purchaseWebPlugin({ package_id: packageId, price_version: `pv1.${'a'.repeat(43)}` } as PublicPluginDetail, {
      campaignToken: attribution.campaign_token,
      fetchImplementation: fetcher,
    });
    expect(fetcher.mock.calls[0][0]).toBe(`/api/marketplace/campaigns/${campaignId}/items/${packageId}/attribution-token`);
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toEqual({
      expectedPriceVersion: `pv1.${'a'.repeat(43)}`,
      campaignToken: 'ct1.signed',
    });
  });

  it('accepts only a valid campaign query id', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(campaignIdFromSearch(`?campaign=${id}`)).toBe(id);
    expect(campaignIdFromSearch('?campaign=not-an-id')).toBeNull();
    expect(campaignIdFromSearch('')).toBeNull();
  });
});
