import {
  MarketplaceCampaignAttributionToken,
  MarketplaceOrderPage,
  MarketplaceOwnerQuality,
  type PublicPluginDetail,
} from '@lingfang/contract';
import { requestJson, type FetchImplementation } from './api';

const ObjectResponse = {
  parse(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('市场响应无效');
    return value as Record<string, unknown>;
  },
};

export type PurchaseWebPluginOptions = {
  campaignToken?: string;
  fetchImplementation?: FetchImplementation;
};

export function purchaseWebPlugin(
  detail: PublicPluginDetail,
  optionsOrFetch: PurchaseWebPluginOptions | FetchImplementation = {}
) {
  if (!/^pv1\.[A-Za-z0-9_-]{43}$/.test(detail.price_version))
    throw new Error('市场价格版本无效，请刷新后重试');
  const options =
    typeof optionsOrFetch === 'function' ? { fetchImplementation: optionsOrFetch } : optionsOrFetch;
  return requestJson(
    `/api/web/plugins/${encodeURIComponent(detail.package_id)}/purchase`,
    ObjectResponse,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        expectedPriceVersion: detail.price_version,
        ...(options.campaignToken ? { campaignToken: options.campaignToken } : {}),
      }),
    },
    options.fetchImplementation
  );
}

export function loadCampaignAttributionToken(
  campaignId: string,
  packageId: string,
  fetchImplementation?: FetchImplementation
) {
  return requestJson(
    `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/items/${encodeURIComponent(packageId)}/attribution-token`,
    MarketplaceCampaignAttributionToken,
    {},
    fetchImplementation
  );
}

export function loadOwnerQuality(packageId: string, fetchImplementation?: FetchImplementation) {
  return requestJson(
    `/api/plugin-packages/${encodeURIComponent(packageId)}/quality`,
    MarketplaceOwnerQuality,
    {},
    fetchImplementation
  );
}

export function submitQualityAppeal(
  packageId: string,
  body: string,
  fetchImplementation?: FetchImplementation
) {
  return requestJson(
    `/api/plugin-packages/${encodeURIComponent(packageId)}/quality-appeals`,
    ObjectResponse,
    { method: 'POST', body: JSON.stringify({ body }) },
    fetchImplementation
  );
}

export function campaignIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('campaign')?.trim() ?? '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export async function loadWebOrders(fetchImplementation?: FetchImplementation) {
  const result = await requestJson(
    '/api/web/plugins/orders/current?pageSize=50',
    MarketplaceOrderPage,
    {},
    fetchImplementation
  );
  return result.items;
}
