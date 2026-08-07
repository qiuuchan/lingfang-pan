import { describe, expect, it, vi } from 'vitest';
import { WebApiError } from './api';
import {
  cancelCloudTrial,
  defaultTrialInput,
  getCloudTrial,
  isCloudTrialTerminal,
  parseTrialInput,
  startCloudTrial,
} from './cloud-trial';

const detail = {
  package_id: '11111111-1111-4111-8111-111111111111',
  listing_id: '22222222-2222-4222-8222-222222222222',
  release_id: '33333333-3333-4333-8333-333333333333',
  release_sha256: 'a'.repeat(64),
  name: '图片生成器',
  summary: '',
  author_display_name: null,
  category: 'MEDIA' as const,
  runtime_type: 'cloud' as const,
  quality_tier: 'LISTED' as const,
  version: '1.0.0',
  install_count: 0,
  rating_count: 0,
  average_rating_tenths: 0,
  base_price_cents: 0,
  price_version: 'base_1',
  preview_mode: 'CLOUD_TRIAL' as const,
  updated_at: '2026-07-16T00:00:00.000Z',
  readme_markdown: '',
  compatibility: {
    runtime_type: 'cloud' as const,
    desktop_platforms: [],
    minimum_desktop_version: null,
    web_compatible: true,
  },
  preview_actions: [],
};

const action = {
  action_id: 'image.generate',
  name: '生成图片',
  description: '',
  action_contract_version: '1.0.0',
  action_surface_sha256: 'b'.repeat(64),
  input_schema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string' as const, minLength: 2 },
      count: { type: 'integer' as const, minimum: 1 },
      optional: { type: 'boolean' as const },
    },
    required: ['prompt', 'count'],
    additionalProperties: false as const,
  },
};

const target = {
  package_id: detail.package_id,
  release_id: detail.release_id,
  sha256: detail.release_sha256,
  action_id: action.action_id,
  action_contract_version: action.action_contract_version,
  action_surface_sha256: action.action_surface_sha256,
};
const projection = {
  invocation_id: '44444444-4444-4444-8444-444444444444',
  status: 'AUTHORIZED' as const,
  target,
  quota_remaining: 4,
  daily_limit: 5,
  concurrency_limit: 1,
  concurrent_active: 1,
  quota_reset_at: '2026-07-17T00:00:00.000Z',
  expires_at: '2026-07-16T00:02:00.000Z',
  policy_decision_id: 'policy-revision:1',
  output: null,
  error: null,
  created_at: '2026-07-16T00:00:00.000Z',
  started_at: null,
  completed_at: null,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Cloud Trial Web client', () => {
  it('posts exact frozen release/action identities and decodes the real projection', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(projection));
    const result = await startCloudTrial(
      { ...detail, preview_actions: [action] },
      action,
      { prompt: '日落', count: 1 },
      'request-1',
      fetcher
    );
    expect(result.invocation_id).toBe(projection.invocation_id);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/web/plugin-actions/${detail.package_id}/${action.action_id}/preview`,
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    );
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      release_id: detail.release_id,
      release_sha256: detail.release_sha256,
      action_contract_version: action.action_contract_version,
      action_surface_sha256: action.action_surface_sha256,
      input: { prompt: '日落', count: 1 },
      request_idempotency_key: 'request-1',
    });
  });

  it('surfaces structured API errors and rejects malformed success projections', async () => {
    const denied = vi
      .fn()
      .mockResolvedValue(
        response({ code: 'web_preview_quota_exceeded', message: '今日次数已用完' }, 429)
      );
    await expect(getCloudTrial(projection.invocation_id, denied)).rejects.toMatchObject({
      status: 429,
      code: 'web_preview_quota_exceeded',
      message: '今日次数已用完',
    } satisfies Partial<WebApiError>);
    const malformed = vi.fn().mockResolvedValue(
      response({
        invocation_id: projection.invocation_id,
        status: 'SUCCEEDED',
        output: { fake: true },
      })
    );
    await expect(getCloudTrial(projection.invocation_id, malformed)).rejects.toThrow();
  });

  it('uses the dedicated Web cancel endpoint and consumes its persisted terminal projection', async () => {
    const canceled = {
      ...projection,
      status: 'CANCELED' as const,
      concurrent_active: 0,
      error: { code: 'action_cancelled', message: 'Action invocation 已取消' },
      completed_at: '2026-07-16T00:00:10.000Z',
    };
    const fetcher = vi.fn().mockResolvedValue(response(canceled));
    const result = await cancelCloudTrial(projection.invocation_id, fetcher);
    expect(result.status).toBe('CANCELED');
    expect(fetcher).toHaveBeenCalledWith(
      `/api/web/plugin-actions/preview/${projection.invocation_id}/cancel`,
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    );
  });

  it('builds a schema-guided editable object and validates user JSON', () => {
    expect(defaultTrialInput(action.input_schema)).toEqual({ prompt: 'xx', count: 1 });
    expect(parseTrialInput('{"prompt":"海边"}')).toEqual({ prompt: '海边' });
    expect(() => parseTrialInput('[]')).toThrow('Action 输入必须是 JSON 对象');
    expect(() => parseTrialInput('{')).toThrow('输入必须是合法 JSON');
  });

  it('polls only until a shared invocation terminal status', () => {
    expect(isCloudTrialTerminal(projection)).toBe(false);
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT'] as const)
      expect(isCloudTrialTerminal({ ...projection, status })).toBe(true);
  });
});
