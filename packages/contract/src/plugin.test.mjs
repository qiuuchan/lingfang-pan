import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode } from './llm.ts';
import { resolveGrant, Plugin, PluginManifest } from './plugin.ts';
import { DraftWorkspace, LocalPluginInstallation, PluginReleaseSummary, StrictSemVer } from './plugin-registry.ts';
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

test('StrictSemVer accepts prereleases and rejects loose or leading-zero versions', () => {
  for (const version of ['0.1.0', '1.0.0-beta.1', '2.3.4+build.7']) {
    assert.equal(StrictSemVer.safeParse(version).success, true, version);
  }
  for (const version of ['v1.0.0', '1.0', '01.0.0', '1.0.0-01']) {
    assert.equal(StrictSemVer.safeParse(version).success, false, version);
  }
});

test('release, installation and draft workspace contracts keep remote and local state separate', () => {
  const manifest = {
    id: 'demo.plugin', name: 'Demo', version: '1.0.0', entry: 'main.py', runtime_type: 'python',
  };
  const release = PluginReleaseSummary.parse({
    id: '11111111-1111-4111-8111-111111111111',
    packageId: '22222222-2222-4222-8222-222222222222',
    version: '1.0.0', manifest, sha256: 'a'.repeat(64), sizeBytes: 1024,
    status: 'PUBLISHED', marketReviewStatus: 'DRAFT', targetPlatform: 'windows-x64',
    createdAt: '2026-07-11T00:00:00.000Z',
  });
  assert.equal('installed' in release, false);

  const installation = LocalPluginInstallation.parse({
    installationId: '33333333-3333-4333-8333-333333333333', packageId: release.packageId,
    origin: 'team', activeRelease: {
      releaseId: release.id, version: release.version, sha256: release.sha256,
      path: 'installed/333/releases/111/package', dependencyStatus: 'pending',
    }, pendingRelease: null, previousRelease: null, dataPath: 'installed/333/data',
    installedAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
  });
  assert.equal(installation.origin, 'team');

  const workspace = DraftWorkspace.parse({
    workspaceId: '44444444-4444-4444-8444-444444444444', title: 'Demo draft',
    path: 'workspaces/444', manifestId: 'demo.plugin', currentVersion: '1.1.0', runtime: 'python',
    conversationId: null, diagnosticStatus: 'idle', contentSha256: null,
    lastPublishedReleaseId: release.id, lastPublishedVersion: release.version,
    createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
  });
  assert.equal(workspace.lastPublishedVersion, '1.0.0');
});
