import {
  PublicPluginCatalogPage,
  PublicPluginDetail,
  MarketplaceDiscoveryHome,
  WebCloudTrialProjection,
  type PortableJsonSchemaNode,
  type PublicPluginDetail as PublicPluginDetailType,
  type WebCloudPreviewAction,
  type WebCloudTrialProjection as WebCloudTrialProjectionType,
} from '@lingfang/contract';
import { requestJson, type FetchImplementation } from './api';

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

export function loadCatalog(fetchImplementation?: FetchImplementation) {
  return requestJson('/api/web/plugins', PublicPluginCatalogPage, {}, fetchImplementation);
}

export function loadDiscoveryHome(fetchImplementation?: FetchImplementation) {
  return requestJson(
    '/api/web/plugins/discovery/home',
    MarketplaceDiscoveryHome,
    {},
    fetchImplementation
  );
}

export function loadPluginDetail(packageId: string, fetchImplementation?: FetchImplementation) {
  return requestJson(
    `/api/web/plugins/${encodeURIComponent(packageId)}`,
    PublicPluginDetail,
    {},
    fetchImplementation
  );
}

export function startCloudTrial(
  detail: PublicPluginDetailType,
  action: WebCloudPreviewAction,
  input: Record<string, unknown>,
  requestIdempotencyKey: string,
  fetchImplementation?: FetchImplementation
) {
  return requestJson(
    `/api/web/plugin-actions/${encodeURIComponent(detail.package_id)}/${encodeURIComponent(action.action_id)}/preview`,
    WebCloudTrialProjection,
    {
      method: 'POST',
      body: JSON.stringify({
        release_id: detail.release_id,
        release_sha256: detail.release_sha256,
        action_contract_version: action.action_contract_version,
        action_surface_sha256: action.action_surface_sha256,
        input,
        request_idempotency_key: requestIdempotencyKey,
      }),
    },
    fetchImplementation
  );
}

export function getCloudTrial(invocationId: string, fetchImplementation?: FetchImplementation) {
  return requestJson(
    `/api/web/plugin-actions/preview/${encodeURIComponent(invocationId)}`,
    WebCloudTrialProjection,
    {},
    fetchImplementation
  );
}

export function cancelCloudTrial(invocationId: string, fetchImplementation?: FetchImplementation) {
  return requestJson(
    `/api/web/plugin-actions/preview/${encodeURIComponent(invocationId)}/cancel`,
    WebCloudTrialProjection,
    { method: 'POST' },
    fetchImplementation
  );
}

export function isCloudTrialTerminal(trial: WebCloudTrialProjectionType): boolean {
  return TERMINAL_STATUSES.has(trial.status);
}

export function parseTrialInput(source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('输入必须是合法 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Action 输入必须是 JSON 对象');
  return value as Record<string, unknown>;
}

export function defaultTrialInput(schema: PortableJsonSchemaNode): Record<string, unknown> {
  const value = defaultSchemaValue(schema);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function defaultSchemaValue(schema: PortableJsonSchemaNode): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((candidate) => candidate !== 'null');
  if (type === 'object') {
    const required = new Set(schema.required ?? []);
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([name]) => required.has(name))
        .map(([name, child]) => [name, defaultSchemaValue(child)])
    );
  }
  if (type === 'array') return [];
  if (type === 'string') return 'x'.repeat(Math.min(schema.minLength ?? 0, 64));
  if (type === 'integer') return Math.ceil(schema.minimum ?? 0);
  if (type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  return null;
}
