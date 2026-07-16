import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriInvokeMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => vi.fn());
const dialogOpenMock = vi.hoisted(() => vi.fn());
const isTauriMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
  isTauri: isTauriMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialogOpenMock }));

vi.mock('@/lib/api', () => ({
  api: apiMock,
  apiBase: vi.fn(() => 'http://test.local'),
  getAuthToken: vi.fn(() => 'token'),
  tauriInvoke: tauriInvokeMock,
  errorMessage: (caught: unknown, fallback = '') => (
    typeof caught === 'string' ? caught : caught instanceof Error ? caught.message : fallback
  ),
}));

import {
  activatePendingClientPlugin,
  buyMarketplacePackage,
  createDraftWorkspace,
  createWorkflowUpgradeDraft,
  getMarketplaceOwnerQuality,
  getPluginReleaseDetail,
  getPluginPackageDetail,
  inspectLocalArtifact,
  listPluginManagement,
  loadDraftWorkspacePlugin,
  normalizePluginProvenance,
  persistDraftWorkspace,
  publishDraftWorkspace,
  publishLocalArtifact,
  publishPluginRelease,
  discardPendingPluginUpdate,
  previewPendingInstalledPlugin,
  retryMarketplaceSubmission,
  requiresRunnerActivation,
  selectPluginArtifact,
  submitReleaseToMarketplace,
  submitMarketplaceQualityAppeal,
  updateOwnerMarketplaceStatus,
  updatePluginPackageStatus,
  updatePluginReleaseStatus,
  withdrawMarketplaceSubmission,
  type RegistryPublishResult,
} from './plugin-registry';

const installation = {
  installationId: '11111111-1111-4111-8111-111111111111',
  packageId: '22222222-2222-4222-8222-222222222222',
  origin: 'team' as const,
  protected: false,
  activeRelease: {
    releaseId: 'active',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    path: '/installed/active',
    dependencyStatus: 'ready' as const,
  },
  pendingRelease: {
    releaseId: 'pending',
    version: '2.0.0',
    sha256: 'b'.repeat(64),
    path: '/installed/pending',
    dependencyStatus: 'pending' as const,
  },
  previousRelease: null,
  dataPath: '/installed/data',
  installedAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
};

describe('pending installation bridge', () => {
  beforeEach(() => {
    tauriInvokeMock.mockReset();
    apiMock.mockReset();
    vi.stubGlobal('CustomEvent', class {
      constructor(public type: string) {}
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('client 和 cloud 都必须等 Runner 成功边界后激活 pending', () => {
    expect(requiresRunnerActivation('client')).toBe(true);
    expect(requiresRunnerActivation('cloud')).toBe(true);
    expect(requiresRunnerActivation('nodejs')).toBe(false);
    expect(requiresRunnerActivation('python')).toBe(false);
  });

  it('预览 pending payload 时使用待激活版本并保留 installationId', async () => {
    tauriInvokeMock.mockResolvedValueOnce({
      installation,
      manifest: {
        id: 'team.demo',
        name: 'Pending Demo',
        version: '2.0.0',
        runtime_type: 'client',
        entry: 'ui/index.html',
      },
      entryContent: '<main>pending</main>',
      readmeMarkdown: '# Pending README',
    });

    const plugin = await previewPendingInstalledPlugin(installation.installationId);

    expect(tauriInvokeMock).toHaveBeenCalledWith('preview_pending_installed_plugin', {
      installationId: installation.installationId,
    });
    expect(plugin).toMatchObject({
      id: installation.installationId,
      installationId: installation.installationId,
      packageId: installation.packageId,
      version: '2.0.0',
      releaseId: 'pending',
      releaseSha256: 'b'.repeat(64),
      pendingActivation: { releaseId: 'pending' },
      readmeMarkdown: '# Pending README',
    });
    expect(plugin.files).toContainEqual({ path: 'ui/index.html', content: '<main>pending</main>' });
  });

  it('激活和丢弃命令都会通知本机安装列表刷新', async () => {
    tauriInvokeMock.mockResolvedValue(installation);

    await activatePendingClientPlugin(installation.installationId);
    await discardPendingPluginUpdate(installation.installationId, 'iframe failed');

    expect(tauriInvokeMock).toHaveBeenNthCalledWith(1, 'activate_pending_client_plugin', {
      installationId: installation.installationId,
    });
    expect(tauriInvokeMock).toHaveBeenNthCalledWith(2, 'discard_pending_plugin_update', {
      installationId: installation.installationId,
      reason: 'iframe failed',
    });
    expect(window.dispatchEvent).toHaveBeenCalledTimes(2);
  });
});

const workspace = {
  workspaceId: '33333333-3333-4333-8333-333333333333',
  title: 'Demo',
  path: '/local/workspaces/demo',
  manifestId: 'demo.plugin',
  currentVersion: '1.0.0',
  runtime: 'client' as const,
  sourceKind: 'EXTERNAL_TOOL' as const,
  sourceLabel: 'Cursor workspace',
  conversationId: null,
  diagnosticStatus: 'ready' as const,
  contentSha256: null,
  lastPublishedReleaseId: null,
  lastPublishedVersion: null,
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
};

const publishResult = {
  package: { id: '44444444-4444-4444-8444-444444444444' },
  release: { id: '55555555-5555-4555-8555-555555555555', version: '1.0.0' },
} as unknown as RegistryPublishResult;

describe('registry management api', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('all business lifecycle calls use the shared api boundary', async () => {
    apiMock
      .mockResolvedValueOnce({ items: ['managed'] })
      .mockResolvedValueOnce({ package: { id: 'package' } })
      .mockResolvedValueOnce({ release: { id: 'release', readme_markdown: '# Demo' } })
      .mockResolvedValueOnce({ release: { id: 'release' } })
      .mockResolvedValueOnce({ release: { id: 'release' } })
      .mockResolvedValueOnce({ package: { id: 'package' }, listing: null })
      .mockResolvedValueOnce({ release: { id: 'release' }, listing: null })
      .mockResolvedValueOnce({ packageId: 'package', listing: { status: 'DELISTED' } });

    await listPluginManagement();
    await getPluginPackageDetail('package/id');
    await getPluginReleaseDetail('release/id');
    await submitReleaseToMarketplace('release/id', 990);
    await withdrawMarketplaceSubmission('release/id', '  wait  ');
    await updatePluginPackageStatus('package/id', 'ARCHIVED');
    await updatePluginReleaseStatus('release/id', 'YANKED');
    await updateOwnerMarketplaceStatus('package/id', 'DELISTED', '  owner request  ');

    expect(apiMock.mock.calls).toEqual([
      ['/api/plugin-registry/manage'],
      ['/api/plugin-packages/package%2Fid'],
      ['/api/plugin-releases/release%2Fid'],
      ['/api/plugin-releases/release%2Fid/submit-marketplace', { method: 'POST', body: { priceCents: 990 } }],
      ['/api/plugin-releases/release%2Fid/withdraw-marketplace', { method: 'POST', body: { reason: 'wait' } }],
      ['/api/plugin-packages/package%2Fid/status', { method: 'PATCH', body: { status: 'ARCHIVED' } }],
      ['/api/plugin-releases/release%2Fid/status', { method: 'PATCH', body: { status: 'YANKED' } }],
      ['/api/plugin-packages/package%2Fid/marketplace-status', {
        method: 'PATCH',
        body: { status: 'DELISTED', reason: 'owner request' },
      }],
    ]);
  });

  it('paid purchase always sends the opaque string price version and an idempotency key', async () => {
    const version = `pv1.${'a'.repeat(43)}`;
    await buyMarketplacePackage('package-1', version);
    expect(apiMock).toHaveBeenCalledWith('/api/plugin-packages/package-1/purchase', {
      method: 'POST',
      headers: { 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/i) },
      body: { expectedPriceVersion: version },
    });
  });

  it('rejects a missing or legacy price token before purchase', async () => {
    await expect(buyMarketplacePackage('package-1', 'base_old')).rejects.toThrow('市场价格版本无效');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('loads the exact owner quality snapshot and submits an appeal through the shared api boundary', async () => {
    apiMock.mockResolvedValueOnce({ packageId: 'package/id', snapshot: null }).mockResolvedValueOnce({ ticket: { id: 'ticket-1' } });
    await getMarketplaceOwnerQuality('package/id');
    await submitMarketplaceQualityAppeal('package/id', '快照数据异常');
    expect(apiMock.mock.calls).toEqual([
      ['/api/plugin-packages/package%2Fid/quality'],
      ['/api/plugin-packages/package%2Fid/quality-appeals', { method: 'POST', body: { body: '快照数据异常' } }],
    ]);
    apiMock.mockReset();
  });
});

describe('artifact picker and publishing', () => {
  beforeEach(() => {
    tauriInvokeMock.mockReset();
    dialogOpenMock.mockReset();
    isTauriMock.mockReset();
    isTauriMock.mockReturnValue(false);
  });

  it('browser environment keeps the manual-path fallback', async () => {
    await expect(selectPluginArtifact()).resolves.toBeNull();
    expect(dialogOpenMock).not.toHaveBeenCalled();
  });

  it('uses the official native .lfplugin-only picker in Tauri', async () => {
    isTauriMock.mockReturnValue(true);
    dialogOpenMock.mockResolvedValue('/local/demo.lfplugin');

    await expect(selectPluginArtifact()).resolves.toBe('/local/demo.lfplugin');
    expect(dialogOpenMock).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [{ name: 'LingFang Plugin', extensions: ['lfplugin'] }],
    });
  });

  it('returns null when the native picker is cancelled', async () => {
    isTauriMock.mockReturnValue(true);
    dialogOpenMock.mockResolvedValue(null);

    await expect(selectPluginArtifact()).resolves.toBeNull();
  });

  it('inspects and directly publishes an artifact without leaking its local path as source label', async () => {
    tauriInvokeMock
      .mockResolvedValueOnce({ sha256: 'a'.repeat(64), manifest: { id: 'demo' }, files: [] })
      .mockResolvedValueOnce(publishResult);

    await inspectLocalArtifact('C:\\private\\demo.lfplugin');
    await publishLocalArtifact('C:\\private\\demo.lfplugin', {
      sourceKind: 'LOCAL_ARTIFACT',
      sourceLabel: 'C:\\private\\demo.lfplugin',
    });

    expect(tauriInvokeMock).toHaveBeenNthCalledWith(1, 'inspect_lfplugin_v4', {
      artifactPath: 'C:\\private\\demo.lfplugin',
    });
    expect(tauriInvokeMock.mock.calls[1]?.[0]).toBe('publish_local_artifact');
    expect(tauriInvokeMock.mock.calls[1]?.[1]).toMatchObject({
      input: {
        artifactPath: 'C:\\private\\demo.lfplugin',
        sourceKind: 'LOCAL_ARTIFACT',
        sourceLabel: '本地 .lfplugin 制品',
      },
    });
  });

  it('allows workspace provenance overrides without sending the workspace path', async () => {
    tauriInvokeMock.mockResolvedValue(publishResult);

    await publishDraftWorkspace(workspace, {
      packageId: publishResult.package.id,
      sourceKind: 'EXTERNAL_TOOL',
      sourceLabel: '/Users/demo/private-workspace',
    });

    expect(tauriInvokeMock.mock.calls[0]?.[0]).toBe('publish_draft_workspace');
    expect(tauriInvokeMock.mock.calls[0]?.[1]).toMatchObject({
      input: {
        workspaceId: workspace.workspaceId,
        packageId: publishResult.package.id,
        sourceKind: 'EXTERNAL_TOOL',
        sourceLabel: '外部开发工具',
      },
    });
    expect(JSON.stringify(tauriInvokeMock.mock.calls[0]?.[1])).not.toContain(workspace.path);

    await publishDraftWorkspace(workspace, undefined, {
      packageId: publishResult.package.id,
      sourceKind: 'LOCAL_ARTIFACT',
      sourceLabel: 'Manual artifact import',
    });
    expect(tauriInvokeMock.mock.calls[1]?.[1]).toMatchObject({
      input: {
        packageId: publishResult.package.id,
        sourceKind: 'LOCAL_ARTIFACT',
        sourceLabel: 'Manual artifact import',
      },
    });
  });
});

describe('binary workspace round trip', () => {
  beforeEach(() => {
    tauriInvokeMock.mockReset();
  });

  it('loads tagged binary files into the draft plugin unchanged', async () => {
    tauriInvokeMock.mockResolvedValueOnce([
      { path: 'manifest.json', content: JSON.stringify({ description: 'demo', entry: 'ui/index.html' }), binary: false },
      { path: 'ui/index.html', content: '<main>demo</main>', binary: false },
      { path: 'assets/logo.png', content: 'AP8DBA==', binary: true },
    ]);

    const plugin = await loadDraftWorkspacePlugin(workspace);

    expect(tauriInvokeMock).toHaveBeenCalledWith('read_draft_workspace_files', {
      workspaceId: workspace.workspaceId,
    });
    expect(plugin.files).toContainEqual({ path: 'assets/logo.png', content: 'AP8DBA==', binary: true });
    expect(plugin._meta).toMatchObject({ sourceKind: 'EXTERNAL_TOOL', sourceLabel: 'Cursor workspace' });
  });

  it('new creator workspaces get explicit release provenance defaults', async () => {
    tauriInvokeMock.mockResolvedValueOnce({
      ...workspace,
      sourceKind: 'LINGFANG_CREATOR',
      sourceLabel: '灵枋创建器',
    });

    await createDraftWorkspace({
      title: 'Creator Demo',
      manifestId: 'creator.demo',
      version: '0.1.0',
      runtime: 'client',
    });

    expect(tauriInvokeMock).toHaveBeenCalledWith('create_draft_workspace', {
      input: {
        title: 'Creator Demo',
        manifestId: 'creator.demo',
        version: '0.1.0',
        runtime: 'client',
        sourceKind: 'LINGFANG_CREATOR',
        sourceLabel: '灵枋创建器',
      },
    });
  });

  it('creates a separate workflow draft for upgrade adoption and never mutates the release API', async () => {
    const currentTarget = { package_id: 'package-image', release_id: 'release-image-1', sha256: 'a'.repeat(64), action_id: 'render', action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64) };
    const definition = { definition_version: '1', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, output_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, nodes: [{ node_id: 'image', declared_version_range: '^1.0.0', target: currentTarget, depends_on: [], input_bindings: [], retry_limit: 0 }], output_bindings: [] };
    const sourceFiles = [
      { path: 'manifest.json', content: JSON.stringify({ id: 'workflow.demo', name: 'Workflow', version: '1.0.0', runtime_type: 'workflow', entry: 'workflow.json' }), binary: false },
      { path: 'workflow.json', content: JSON.stringify(definition), binary: false },
    ];
    const upgradedWorkspace = { ...workspace, currentVersion: '1.0.1', runtime: 'workflow' as const };
    tauriInvokeMock.mockImplementation(async (command: string) => {
      if (command === 'create_draft_workspace') return upgradedWorkspace;
      if (command === 'list_draft_workspaces') return [upgradedWorkspace];
      if (command === 'sync_draft_workspace_metadata') return upgradedWorkspace;
      if (command === 'read_draft_workspace_files') return sourceFiles.map((file) => file.path === 'manifest.json' ? { ...file, content: JSON.stringify({ id: 'workflow.demo', name: 'Workflow', version: '1.0.1', runtime_type: 'workflow', entry: 'workflow.json' }) } : file);
      return undefined;
    });

    const draft = await createWorkflowUpgradeDraft({ id: 'workflow-release', name: 'Workflow', version: '1.0.0', entry: 'workflow.json', runtime_type: 'workflow', releaseId: 'workflow-release', releaseSha256: 'f'.repeat(64), files: sourceFiles }, [{ node_id: 'image', declared_version_range: '^1.0.0', current_version: '1.0.0', current_target: currentTarget, suggested_version: '1.2.0', suggested_target: { ...currentTarget, release_id: 'release-image-2', sha256: 'c'.repeat(64), action_surface_sha256: 'd'.repeat(64) }, reason: 'compatible' }]);

    expect(draft.draft).toBe(true);
    expect(tauriInvokeMock).toHaveBeenCalledWith('create_draft_workspace', { input: expect.objectContaining({ manifestId: 'workflow.demo', version: '1.0.1', runtime: 'workflow' }) });
    const writeCall = tauriInvokeMock.mock.calls.find(([command]) => command === 'write_plugin_files');
    const writtenWorkflow = writeCall?.[1]?.files.find((file: { path: string }) => file.path === 'workflow.json');
    expect(JSON.parse(writtenWorkflow.content).nodes[0]).toMatchObject({ declared_version_range: '^1.0.0', target: { release_id: 'release-image-2' } });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('writes text in one batch and binary files through the byte command', async () => {
    tauriInvokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_draft_workspaces') return [workspace];
      if (command === 'sync_draft_workspace_metadata') return workspace;
      return undefined;
    });

    await persistDraftWorkspace({
      preferredWorkspaceId: workspace.workspaceId,
      title: workspace.title,
      manifestId: workspace.manifestId,
      version: workspace.currentVersion,
      runtime: workspace.runtime,
      sourceKind: workspace.sourceKind,
      sourceLabel: workspace.sourceLabel,
      files: [
        { path: 'manifest.json', content: '{}' },
        { path: 'assets/logo.png', content: 'AP8DBA==', binary: true },
      ],
    });

    expect(tauriInvokeMock).toHaveBeenCalledWith('write_plugin_files', {
      pluginId: workspace.workspaceId,
      files: [{ path: 'manifest.json', content: '{}' }],
    });
    expect(tauriInvokeMock).toHaveBeenCalledWith('write_plugin_file_bytes', {
      pluginId: workspace.workspaceId,
      path: 'assets/logo.png',
      contentBase64: 'AP8DBA==',
    });
    expect(tauriInvokeMock).toHaveBeenCalledWith('sync_draft_workspace_metadata', {
      workspaceId: workspace.workspaceId,
      conversationId: undefined,
      sourceKind: 'EXTERNAL_TOOL',
      sourceLabel: 'Cursor workspace',
    });
  });
});

describe('marketplace partial success orchestration', () => {
  beforeEach(() => apiMock.mockReset());

  it('retains the immutable team release and retries only marketplace submission', async () => {
    const publishTeam = vi.fn().mockResolvedValue(publishResult);
    apiMock
      .mockRejectedValueOnce(new Error('review service unavailable'))
      .mockResolvedValueOnce({
        package: publishResult.package,
        releases: [{ ...publishResult.release, marketReviewStatus: 'DRAFT' }],
      });
    const phases: string[] = [];

    const failed = await publishPluginRelease({
      target: 'marketplace',
      publishTeam,
      priceCents: 500,
      onState: (state) => phases.push(state.phase),
    });

    expect(failed).toMatchObject({
      phase: 'market_failed',
      priceCents: 500,
      result: publishResult,
      error: 'review service unavailable',
    });
    expect(publishTeam).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['uploading', 'team_published', 'submitting_market', 'market_failed']);
    expect(apiMock).toHaveBeenCalledWith(
      `/api/plugin-releases/${publishResult.release.id}/submit-marketplace`,
      { method: 'POST', body: { priceCents: 500 } },
    );

    apiMock.mockResolvedValueOnce({
      release: { ...publishResult.release, marketReviewStatus: 'PENDING' },
    });
    const retried = await retryMarketplaceSubmission(failed);

    expect(retried.phase).toBe('done');
    expect(retried.result?.release.marketReviewStatus).toBe('PENDING');
    expect(publishTeam).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenLastCalledWith(
      `/api/plugin-releases/${publishResult.release.id}/submit-marketplace`,
      { method: 'POST', body: { priceCents: 500 } },
    );
    expect(apiMock).toHaveBeenCalledTimes(3);
  });

  it('reconciles a lost submit response when package detail is already pending', async () => {
    const pendingRelease = { ...publishResult.release, marketReviewStatus: 'PENDING' };
    apiMock
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ package: publishResult.package, releases: [pendingRelease] });

    const state = await publishPluginRelease({
      target: 'marketplace',
      publishTeam: async () => publishResult,
      priceCents: 1200,
    });

    expect(state.phase).toBe('done');
    expect(state.result?.release).toMatchObject({
      id: publishResult.release.id,
      marketReviewStatus: 'PENDING',
    });
  });

  it('normalizes source labels without carrying an absolute local path', () => {
    expect(normalizePluginProvenance({
      sourceKind: 'EXTERNAL_TOOL',
      sourceLabel: '/Users/demo/private-plugin',
    })).toEqual({ sourceKind: 'EXTERNAL_TOOL', sourceLabel: '外部开发工具' });
  });
});
