import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode } from './llm.ts';
import { resolveGrant, Plugin, PluginManifest } from './plugin.ts';
import { PluginDraft, PluginDraftStatus, PluginDraftDiagnostic } from './draft.ts';

test('owner and admin default to allowed when no grant matches', () => {
  assert.equal(resolveGrant([], 'u1', 'owner'), true);
  assert.equal(resolveGrant([], 'u1', 'admin'), true);
});

test('deny grant still overrides owner default allow', () => {
  const grants = [
    { tenant_id: 't1', plugin_id: 'p1', subject_kind: 'role', subject_id: 'owner', effect: 'deny' },
  ];

  assert.equal(resolveGrant(grants, 'u1', 'owner'), false);
});

test('error code contract includes backend stable codes', () => {
  for (const code of ['bad_request', 'forbidden', 'payment_required', 'insufficient_balance', 'upstream_llm_error', 'internal']) {
    assert.equal(ErrorCode.safeParse(code).success, true, code);
  }
});

// CONTRACT-04 回归：市场已发布插件（PUBLIC + ENABLED + APPROVED）必须能通过 Plugin.safeParse，
// 防止契约静默漂移回 'listed'/'disabled' 或漏掉 'public' 枚举值。
test('published marketplace plugin round-trips through Plugin schema', () => {
  const published = {
    id: 'p1',
    name: 'summarizer',
    version: '1.0.0',
    description: '示例',
    teamId: 't1',
    authorUserId: 'u1',
    runtimeType: 'CLIENT',
    entry: 'ui/index.html',
    capabilities: [],
    visibility: 'PUBLIC',
    status: 'ENABLED',
    reviewStatus: 'APPROVED',
    marketplace: true,
    priceCents: 0,
    installCount: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
  const result = Plugin.safeParse(published);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

// CONTRACT-03 回归：桌面端实际产出的 partial/chat 状态与 diagnostics/local-cli/warn 必须通过契约。
test('plugin draft real-world values round-trip through draft schema', () => {
  assert.equal(PluginDraftStatus.safeParse('partial').success, true);
  assert.equal(PluginDraftStatus.safeParse('chat').success, true);
  const diag = PluginDraftDiagnostic.safeParse({ stage: 'local-cli', status: 'warn', message: 'ok' });
  assert.equal(diag.success, true);
  const draft = PluginDraft.safeParse({
    id: 'd1',
    status: 'partial',
    files: [],
    turns: [],
    diagnostics: [{ stage: 'diagnostics', status: 'warn', message: 'm' }],
  });
  assert.equal(draft.success, true, JSON.stringify(draft.error?.issues));
});

// CONTRACT-02 回归：PluginManifest 边界字段保持 snake_case（manifest.json 自洽），不上传时 visibility 默认 tenant。
test('PluginManifest manifest-boundary fields stay snake_case', () => {
  const manifest = PluginManifest.safeParse({
    id: 'p1',
    name: 'demo',
    version: '0.1.0',
    entry: 'ui/index.html',
    runtime_type: 'client',
  });
  assert.equal(manifest.success, true, JSON.stringify(manifest.error?.issues));
});
