import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebPreviewSession,
  WebCloudTrialCreateRequest,
  WebCloudTrialProjection,
  WebCloudPreviewAction,
  PublicPluginCard,
  PublicPluginDetail,
  WebPluginCatalogQuery,
} from './web-plugin-center.ts';

test('preview session is short-lived opaque handshake data without auth tokens', () => {
  const session = WebPreviewSession.parse({
    session_id: '11111111-1111-4111-8111-111111111111', release_id: '22222222-2222-4222-8222-222222222222',
    release_sha256: 'a'.repeat(64), mode: 'CLIENT_SANDBOX', expires_at: '2026-07-16T00:05:00.000Z', channel_nonce: 'n'.repeat(32),
  });
  assert.equal(session.mode, 'CLIENT_SANDBOX');
  assert.throws(() => WebPreviewSession.parse({ ...session, auth_token: 'secret' }));
  const target = { package_id: '11111111-1111-4111-8111-111111111111', release_id: '22222222-2222-4222-8222-222222222222', sha256: 'a'.repeat(64), action_id: 'preview', action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64) };
  assert.equal(WebCloudTrialCreateRequest.parse({ release_id: target.release_id, release_sha256: target.sha256, action_contract_version: target.action_contract_version, action_surface_sha256: target.action_surface_sha256, input: {}, request_idempotency_key: 'request-1' }).request_idempotency_key, 'request-1');
  assert.equal(WebCloudTrialProjection.parse({ invocation_id: '33333333-3333-4333-8333-333333333333', status: 'AUTHORIZED', target, quota_remaining: 4, daily_limit: 5, concurrency_limit: 1, concurrent_active: 1, quota_reset_at: '2026-07-17T00:00:00.000Z', expires_at: '2026-07-17T00:00:00.000Z', policy_decision_id: 'decision-1', output: null, error: null, created_at: '2026-07-16T00:00:00.000Z', started_at: null, completed_at: null }).status, 'AUTHORIZED');
  assert.equal(WebCloudPreviewAction.parse({ action_id: 'image.generate', name: '生成图片', description: '', action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64), input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }).action_id, 'image.generate');
});
import { inferMarketplaceCategory } from './marketplace-discovery.ts';

const card = {
  package_id: '11111111-1111-4111-8111-111111111111',
  listing_id: '22222222-2222-4222-8222-222222222222',
  release_id: '33333333-3333-4333-8333-333333333333',
  name: '图片生成器',
  summary: '生成图片',
  author_display_name: '作者',
  category: 'MEDIA',
  runtime_type: 'client',
  quality_tier: 'LISTED',
  version: '1.0.0',
  install_count: 10,
  rating_count: 2,
  average_rating_tenths: 45,
  base_price_cents: 990,
  price_version: 'base_opaque_token',
  preview_mode: 'STATIC_DESKTOP',
  updated_at: '2026-07-16T00:00:00.000Z',
};

test('public plugin card is a strict safe projection', () => {
  assert.equal(PublicPluginCard.safeParse(card).success, true);
  assert.equal(PublicPluginCard.safeParse({ ...card, manifest: { secret: true } }).success, false);
  assert.equal(PublicPluginCard.safeParse({ ...card, price_revision: 7 }).success, false);
});

test('detail carries compatibility without exposing artifact storage fields', () => {
  const detail = PublicPluginDetail.parse({
    ...card,
    readme_markdown: '# 使用说明',
    release_sha256: 'a'.repeat(64),
    compatibility: {
      runtime_type: 'client',
      desktop_platforms: ['windows-x64'],
      minimum_desktop_version: null,
      web_compatible: false,
    },
    preview_actions: [],
  });
  assert.equal(detail.compatibility.web_compatible, false);
  assert.equal('artifact_key' in detail, false);
});

test('catalog query decodes stable URL filters and bounded pagination', () => {
  const query = WebPluginCatalogQuery.parse({ q: '图片', category: 'MEDIA', page: '2', page_size: '12' });
  assert.equal(query.page, 2);
  assert.equal(query.page_size, 12);
  assert.equal(query.sort, 'POPULAR');
  assert.equal(WebPluginCatalogQuery.safeParse({ page_size: '51' }).success, false);
});

test('category inference is deterministic and conservative', () => {
  assert.equal(inferMarketplaceCategory({ name: 'AI 代码助手', description: '对话生成代码' }), 'AI');
  assert.equal(inferMarketplaceCategory({ name: '未知插件' }), 'OTHER');
});
