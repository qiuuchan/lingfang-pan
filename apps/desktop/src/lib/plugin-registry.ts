import { Channel, isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type {
  DraftWorkspace,
  LocalPluginInstallation,
  MarketplaceListingProjection,
  MarketplaceOwnerQuality,
  PluginCatalogItem,
  PluginManagementItem,
  PluginPackageDetail,
  PluginPackageSummary,
  PluginReleaseSourceKind,
  PluginReleaseDetail,
  PluginReleaseSummary,
} from '@lingfang/contract';
import { api, apiBase, errorMessage, getAuthToken, tauriInvoke } from '@/lib/api';
import type { DraftFile, LoadedPlugin } from '@/lib/types';
import type { WorkflowUpgradeSuggestion } from '@lingfang/contract';
import { applyWorkflowUpgradeSuggestions } from '@/lib/workflow-runtime';
import { conversationKey, selectedConversationKey } from '@/lib/plugin-creator/creator-session';
import {
  isPluginSourceKind,
  normalizePluginProvenance,
  sanitizePluginSourceLabel,
  type PluginProvenance,
} from '@/lib/plugin-provenance';
import { readWorkspaceFiles as readTaggedWorkspaceFiles, writeWorkspaceFiles } from '@/lib/plugin-status';

export type RegistryCatalogItem = PluginCatalogItem;
export type RegistryPackage = PluginPackageSummary;
export type RegistryRelease = PluginReleaseSummary;
export type RegistryReleaseDetail = PluginReleaseDetail;
export type RegistryManagementItem = PluginManagementItem;
export type RegistryPackageDetail = PluginPackageDetail;
export type RegistryListing = MarketplaceListingProjection;
export type RegistryOwnerQuality = MarketplaceOwnerQuality;
export type RegistryPackageStatus = RegistryPackage['governanceStatus'];
export type RegistryReleaseStatus = RegistryRelease['status'];
export type RegistrySourceKind = PluginReleaseSourceKind;
export type Installation = LocalPluginInstallation;
export type Workspace = DraftWorkspace;
export type { MarketplaceListingProjection, PluginManagementItem, PluginPackageDetail, PluginReleaseSourceKind } from '@lingfang/contract';
export type { PluginProvenance } from '@/lib/plugin-provenance';
export { DEFAULT_SOURCE_LABELS, normalizePluginProvenance } from '@/lib/plugin-provenance';
export const INSTALLATIONS_CHANGED_EVENT = 'lf:plugin-installations-changed';

function normalizeWorkspace(workspace: Workspace): Workspace {
  const sourceKind = isPluginSourceKind(workspace.sourceKind) ? workspace.sourceKind : 'UNKNOWN';
  return { ...workspace, sourceKind, sourceLabel: sanitizePluginSourceLabel(workspace.sourceLabel) };
}

export type PluginArtifactInspection = {
  sha256: string;
  sizeBytes: number;
  uncompressedSizeBytes: number;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; sizeBytes: number }>;
};

export type RegistryPublishResult = {
  package: RegistryPackage;
  release: RegistryRelease;
};

function notifyInstallationsChanged() {
  window.dispatchEvent(new CustomEvent(INSTALLATIONS_CHANGED_EVENT));
}

export type TransferProgress = {
  stage: 'inspecting' | 'packing' | 'downloading' | 'verifying' | 'installing' | 'uploading' | 'finished';
  message: string;
  transferred: number;
  total: number | null;
};

type TransferEvent =
  | { event: 'Stage'; data: { stage: TransferProgress['stage']; message: string } }
  | { event: 'Started'; data: { totalBytes: number | null } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

type InstalledPayload = {
  installation: Installation;
  manifest: Record<string, unknown>;
  entryContent: string;
  readmeMarkdown: string;
};

function connection() {
  const base = apiBase();
  if (!base) throw new Error('尚未配置后端服务地址');
  const token = getAuthToken();
  if (!token) throw new Error('登录状态已失效');
  return { base, token };
}

function progressChannel(onProgress?: (progress: TransferProgress) => void) {
  const channel = new Channel<TransferEvent>();
  let stage: TransferProgress['stage'] = 'downloading';
  let message = '';
  let transferred = 0;
  let total: number | null = null;
  channel.onmessage = (event) => {
    if (event.event === 'Stage') {
      stage = event.data.stage;
      message = event.data.message;
    } else if (event.event === 'Started') {
      total = event.data.totalBytes;
      transferred = 0;
    } else if (event.event === 'Progress') {
      transferred += event.data.chunkLength;
      if (stage === 'packing') stage = 'uploading';
    } else {
      stage = 'finished';
      message = '操作完成';
    }
    onProgress?.({ stage, message, transferred, total });
  };
  return channel;
}

/**
 * Open the native .lfplugin picker. Browser-only development and tests return
 * null so callers can keep a manual-path fallback without triggering a Tauri
 * error toast.
 */
export async function selectPluginArtifact(): Promise<string | null> {
  if (!isTauri()) return null;
  const options = {
    multiple: false as const,
    directory: false as const,
    filters: [{ name: 'LingFang Plugin', extensions: ['lfplugin'] }],
  };
  try {
    const selected = await openDialog(options);
    const path = Array.isArray(selected) ? selected[0] : selected;
    return typeof path === 'string' && path.trim() ? path : null;
  } catch (caught) {
    throw new Error(errorMessage(caught, '选择插件制品失败'));
  }
}

export function inspectLocalArtifact(artifactPath: string): Promise<PluginArtifactInspection> {
  return tauriInvoke<PluginArtifactInspection>('inspect_lfplugin_v4', { artifactPath });
}

export async function listInstallations(): Promise<Installation[]> {
  return tauriInvoke<Installation[]>('list_plugin_installations');
}

export async function listTeamRegistry(): Promise<RegistryCatalogItem[]> {
  const response = await api<{ items: RegistryCatalogItem[] }>('/api/plugin-registry/team');
  return response.items;
}

export async function listMarketplaceRegistry(): Promise<RegistryCatalogItem[]> {
  const response = await api<{ items: RegistryCatalogItem[] }>('/api/plugin-registry/marketplace');
  return response.items;
}

export async function listPluginManagement(): Promise<RegistryManagementItem[]> {
  const response = await api<{ items: RegistryManagementItem[] }>('/api/plugin-registry/manage');
  return response.items;
}

export function getPluginPackageDetail(packageId: string): Promise<RegistryPackageDetail> {
  return api<RegistryPackageDetail>(`/api/plugin-packages/${encodeURIComponent(packageId)}`);
}

export function getPluginReleaseDetail(releaseId: string): Promise<{ release: PluginReleaseDetail }> {
  return api(`/api/plugin-releases/${encodeURIComponent(releaseId)}`);
}

export function getMarketplaceOwnerQuality(packageId: string): Promise<RegistryOwnerQuality> {
  return api(`/api/plugin-packages/${encodeURIComponent(packageId)}/quality`);
}

export function submitMarketplaceQualityAppeal(packageId: string, body: string): Promise<unknown> {
  return api(`/api/plugin-packages/${encodeURIComponent(packageId)}/quality-appeals`, {
    method: 'POST',
    body: { body },
  });
}

export async function submitReleaseToMarketplace(
  releaseId: string,
  priceCents?: number,
): Promise<{ release: RegistryRelease }> {
  return api(`/api/plugin-releases/${encodeURIComponent(releaseId)}/submit-marketplace`, {
    method: 'POST',
    body: priceCents === undefined ? {} : { priceCents },
  });
}

export async function withdrawMarketplaceSubmission(
  releaseId: string,
  reason?: string,
): Promise<{ release: RegistryRelease }> {
  return api(`/api/plugin-releases/${encodeURIComponent(releaseId)}/withdraw-marketplace`, {
    method: 'POST',
    body: reason?.trim() ? { reason: reason.trim() } : {},
  });
}

export function updatePluginPackageStatus(
  packageId: string,
  status: RegistryPackageStatus,
): Promise<{ package: RegistryPackage; listing: RegistryListing | null }> {
  return api(`/api/plugin-packages/${encodeURIComponent(packageId)}/status`, {
    method: 'PATCH',
    body: { status },
  });
}

export function updatePluginReleaseStatus(
  releaseId: string,
  status: RegistryReleaseStatus,
): Promise<{ release: RegistryRelease; listing: RegistryListing | null }> {
  return api(`/api/plugin-releases/${encodeURIComponent(releaseId)}/status`, {
    method: 'PATCH',
    body: { status },
  });
}

export function updateOwnerMarketplaceStatus(
  packageId: string,
  status: 'ACTIVE' | 'DELISTED',
  reason?: string,
): Promise<{ packageId: string; listing: RegistryListing }> {
  return api(`/api/plugin-packages/${encodeURIComponent(packageId)}/marketplace-status`, {
    method: 'PATCH',
    body: { status, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
  });
}

export type PluginPublishTarget = 'team' | 'marketplace';
export type PluginPublishPhase =
  | 'idle'
  | 'uploading'
  | 'team_published'
  | 'submitting_market'
  | 'done'
  | 'team_failed'
  | 'market_failed';

export type PluginPublishState = {
  target: PluginPublishTarget;
  phase: PluginPublishPhase;
  priceCents?: number;
  result?: RegistryPublishResult;
  error?: string;
};

export type PluginPublishAction =
  | { type: 'start_upload' }
  | { type: 'team_published'; result: RegistryPublishResult }
  | { type: 'start_market_submission' }
  | { type: 'market_submitted'; result: RegistryPublishResult }
  | { type: 'complete' }
  | { type: 'team_failed'; error: string }
  | { type: 'market_failed'; error: string };

export function createPluginPublishState(target: PluginPublishTarget, priceCents?: number): PluginPublishState {
  return { target, phase: 'idle', priceCents };
}

export function pluginPublishReducer(
  state: PluginPublishState,
  action: PluginPublishAction,
): PluginPublishState {
  switch (action.type) {
    case 'start_upload':
      return { target: state.target, phase: 'uploading', priceCents: state.priceCents };
    case 'team_published':
      return { ...state, phase: 'team_published', result: action.result, error: undefined };
    case 'start_market_submission':
      if (!state.result) return state;
      return { ...state, phase: 'submitting_market', error: undefined };
    case 'market_submitted':
      return { ...state, phase: 'done', result: action.result, error: undefined };
    case 'complete':
      if (!state.result) return state;
      return { ...state, phase: 'done', error: undefined };
    case 'team_failed':
      return { target: state.target, phase: 'team_failed', priceCents: state.priceCents, error: action.error };
    case 'market_failed':
      if (!state.result) return state;
      return { ...state, phase: 'market_failed', error: action.error };
  }
}

function publishStateEmitter(
  target: PluginPublishTarget,
  priceCents?: number,
  onState?: (state: PluginPublishState) => void,
) {
  let state = createPluginPublishState(target, priceCents);
  return {
    dispatch(action: PluginPublishAction) {
      state = pluginPublishReducer(state, action);
      onState?.(state);
      return state;
    },
  };
}

async function reconcileMarketplaceSubmission(
  published: RegistryPublishResult,
): Promise<RegistryPublishResult | null> {
  try {
    const detail = await getPluginPackageDetail(published.package.id);
    const release = detail.releases.find((item) => item.id === published.release.id);
    if (!release || (release.marketReviewStatus !== 'PENDING' && release.marketReviewStatus !== 'APPROVED')) {
      return null;
    }
    return { package: detail.package, release };
  } catch {
    return null;
  }
}

async function submitMarketplaceOrReconcile(
  published: RegistryPublishResult,
  priceCents?: number,
): Promise<RegistryPublishResult> {
  try {
    const submitted = await submitReleaseToMarketplace(published.release.id, priceCents);
    return { ...published, release: submitted.release };
  } catch (caught) {
    const reconciled = await reconcileMarketplaceSubmission(published);
    if (reconciled) return reconciled;
    throw caught;
  }
}

/**
 * Publish the immutable team release first, then optionally submit that exact
 * release to marketplace review. A marketplace error returns market_failed
 * with the release retained, making a retry incapable of re-uploading it.
 */
export async function publishPluginRelease(options: {
  target: PluginPublishTarget;
  publishTeam: () => Promise<RegistryPublishResult>;
  priceCents?: number;
  onState?: (state: PluginPublishState) => void;
}): Promise<PluginPublishState> {
  const state = publishStateEmitter(options.target, options.priceCents, options.onState);
  state.dispatch({ type: 'start_upload' });
  let published: RegistryPublishResult;
  try {
    published = await options.publishTeam();
  } catch (caught) {
    return state.dispatch({ type: 'team_failed', error: errorMessage(caught, '发布团队版本失败') });
  }
  state.dispatch({ type: 'team_published', result: published });
  if (options.target === 'team') return state.dispatch({ type: 'complete' });
  state.dispatch({ type: 'start_market_submission' });
  try {
    const submitted = await submitMarketplaceOrReconcile(published, options.priceCents);
    return state.dispatch({ type: 'market_submitted', result: submitted });
  } catch (caught) {
    return state.dispatch({ type: 'market_failed', error: errorMessage(caught, '团队版本已发布，但提交市场审核失败') });
  }
}

/** Retry only the review submission retained by a market_failed state. */
export async function retryMarketplaceSubmission(
  failed: PluginPublishState,
  priceCents?: number,
  onState?: (state: PluginPublishState) => void,
): Promise<PluginPublishState> {
  if (failed.phase !== 'market_failed' || !failed.result) {
    throw new Error('当前发布状态没有可重试的市场提审');
  }
  let state = pluginPublishReducer(failed, { type: 'start_market_submission' });
  onState?.(state);
  const effectivePriceCents = priceCents ?? failed.priceCents;
  try {
    const submitted = await submitMarketplaceOrReconcile(failed.result, effectivePriceCents);
    state = pluginPublishReducer(state, { type: 'market_submitted', result: submitted });
  } catch (caught) {
    state = pluginPublishReducer(state, {
      type: 'market_failed',
      error: errorMessage(caught, '重试提交市场审核失败'),
    });
  }
  onState?.(state);
  return state;
}

export async function loadInstalledPlugin(installationId: string): Promise<LoadedPlugin> {
  const payload = await tauriInvoke<InstalledPayload>('load_installed_plugin', { installationId });
  return installedPayloadToPlugin(payload, payload.installation.activeRelease);
}

export async function previewPendingInstalledPlugin(installationId: string): Promise<LoadedPlugin> {
  const payload = await tauriInvoke<InstalledPayload>('preview_pending_installed_plugin', { installationId });
  const release = payload.installation.pendingRelease;
  if (!release) throw new Error('安装项没有待激活版本');
  return installedPayloadToPlugin(payload, release, release.releaseId);
}

export async function activatePendingClientPlugin(installationId: string): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('activate_pending_client_plugin', { installationId });
  notifyInstallationsChanged();
  return installation;
}

export function requiresRunnerActivation(runtime: LoadedPlugin['runtime_type']): boolean {
  return runtime === 'client' || runtime === 'cloud';
}

export async function discardPendingPluginUpdate(installationId: string, reason?: string): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('discard_pending_plugin_update', { installationId, reason });
  notifyInstallationsChanged();
  return installation;
}

function installedPayloadToPlugin(
  payload: InstalledPayload,
  release: Installation['activeRelease'],
  pendingReleaseId?: string,
): LoadedPlugin {
  const manifest = payload.manifest;
  const entry = String(manifest.entry || 'ui/index.html');
  const runtime = String(manifest.runtime_type || 'client') as LoadedPlugin['runtime_type'];
  const manifestFile: DraftFile = { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) };
  return {
    id: payload.installation.installationId,
    installationId: payload.installation.installationId,
    packageId: payload.installation.packageId,
    releaseId: release.releaseId,
    releaseSha256: release.sha256,
    installationOrigin: payload.installation.origin,
    pendingActivation: pendingReleaseId ? { releaseId: pendingReleaseId } : undefined,
    name: String(manifest.name || payload.installation.packageId),
    description: String(manifest.description || ''),
    readmeMarkdown: payload.readmeMarkdown || '',
    version: release.version,
    entry,
    runtime_type: runtime,
    source: payload.installation.origin === 'builtin' ? 'builtin' : 'installed',
    builtin: payload.installation.protected,
    manifest,
    files: [manifestFile, { path: entry, content: payload.entryContent }],
  };
}

export async function downloadRelease(
  item: RegistryCatalogItem,
  origin: 'team' | 'marketplace',
  onProgress?: (progress: TransferProgress) => void,
): Promise<Installation> {
  const { base, token } = connection();
  const installation = await tauriInvoke<Installation>('download_plugin_release', {
    input: {
      apiBase: base,
      authToken: token,
      packageId: item.package.id,
      releaseId: item.latestRelease.id,
      sha256: item.latestRelease.sha256,
      origin,
    },
    onEvent: progressChannel(onProgress),
  });
  notifyInstallationsChanged();
  return installation;
}

export async function importLocalArtifact(artifactPath: string): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('install_plugin_artifact', {
    input: {
      artifactPath,
      expectedSha256: null,
      packageId: null,
      releaseId: null,
      origin: 'local',
      protected: false,
    },
  });
  notifyInstallationsChanged();
  return installation;
}

export async function publishLocalArtifact(
  artifactPath: string,
  options: Partial<PluginProvenance> & { packageId?: string } = {},
  onProgress?: (progress: TransferProgress) => void,
): Promise<RegistryPublishResult> {
  const { base, token } = connection();
  const provenance = normalizePluginProvenance(options, 'LOCAL_ARTIFACT');
  return tauriInvoke<RegistryPublishResult>('publish_local_artifact', {
    input: {
      apiBase: base,
      authToken: token,
      artifactPath,
      packageId: options.packageId || undefined,
      sourceKind: provenance.sourceKind,
      sourceLabel: provenance.sourceLabel,
    },
    onEvent: progressChannel(onProgress),
  });
}

export async function buyMarketplacePackage(packageId: string, expectedPriceVersion: string): Promise<void> {
  if (!/^pv1\.[A-Za-z0-9_-]{43}$/.test(expectedPriceVersion)) throw new Error('市场价格版本无效，请刷新插件目录后重试');
  await api(`/api/plugin-packages/${packageId}/purchase`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { expectedPriceVersion },
  });
}

export async function startInstalledPlugin(
  plugin: LoadedPlugin,
  registryAccessGranted: boolean,
): Promise<{ pid: number; started_at: string }> {
  const { base, token } = connection();
  return tauriInvoke('start_installed_plugin', {
    installationId: plugin.installationId || plugin.id,
    registryAccessGranted,
    apiBase: base,
    authToken: token,
  });
}

export async function stopInstalledPlugin(installationId: string): Promise<void> {
  await tauriInvoke('stop_installed_plugin', { installationId });
}

export async function rollbackInstallation(installationId: string): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('rollback_plugin_installation', { installationId });
  notifyInstallationsChanged();
  return installation;
}

export async function uninstallInstallation(installationId: string): Promise<void> {
  await tauriInvoke('uninstall_plugin_installation', { installationId });
  notifyInstallationsChanged();
}

export async function listDraftWorkspaces(): Promise<Workspace[]> {
  const workspaces = await tauriInvoke<Workspace[]>('list_draft_workspaces');
  return workspaces.map(normalizeWorkspace);
}

export async function createDraftWorkspace(input: {
  title: string;
  manifestId: string;
  version: string;
  runtime: 'client' | 'cloud' | 'nodejs' | 'python' | 'workflow';
  conversationId?: string | null;
  sourceKind?: PluginReleaseSourceKind;
  sourceLabel?: string;
}): Promise<Workspace> {
  const provenance = normalizePluginProvenance(input, 'LINGFANG_CREATOR');
  const workspace = await tauriInvoke<Workspace>('create_draft_workspace', {
    input: { ...input, ...provenance },
  });
  return normalizeWorkspace(workspace);
}

export async function deleteDraftWorkspace(workspaceId: string): Promise<void> {
  await tauriInvoke('delete_draft_workspace', { workspaceId });
}

export async function importDraftWorkspace(artifactPath: string): Promise<Workspace> {
  return normalizeWorkspace(await tauriInvoke<Workspace>('import_draft_workspace', { artifactPath }));
}

export async function copyInstallationToDraft(installationId: string): Promise<Workspace> {
  return normalizeWorkspace(await tauriInvoke<Workspace>('copy_installation_to_draft_workspace', { installationId }));
}

export function deleteLocalCreatorConversation(
  conversationId: string | null,
  userId: string | null,
  tenantId: string | null,
): void {
  if (!conversationId) return;
  const conversationsKey = conversationKey(userId, tenantId);
  const selectedKey = selectedConversationKey(userId, tenantId);
  try {
    const raw = localStorage.getItem(conversationsKey);
    const conversations = raw ? JSON.parse(raw) as unknown : [];
    if (Array.isArray(conversations)) {
      localStorage.setItem(
        conversationsKey,
        JSON.stringify(conversations.filter((item) => !item || typeof item !== 'object' || (item as { id?: unknown }).id !== conversationId)),
      );
    }
    if (localStorage.getItem(selectedKey) === conversationId) localStorage.removeItem(selectedKey);
  } catch {
    // Workspace deletion remains authoritative even if legacy conversation data is malformed.
  }
}

export type PublishWorkspaceOptions = Partial<PluginProvenance> & { packageId?: string };

export function publishDraftWorkspace(
  workspace: Workspace,
  onProgress?: (progress: TransferProgress) => void,
  options?: PublishWorkspaceOptions,
): Promise<RegistryPublishResult>;
export function publishDraftWorkspace(
  workspace: Workspace,
  options?: PublishWorkspaceOptions,
  onProgress?: (progress: TransferProgress) => void,
): Promise<RegistryPublishResult>;
export async function publishDraftWorkspace(
  workspace: Workspace,
  optionsOrProgress?: PublishWorkspaceOptions | ((progress: TransferProgress) => void),
  progressOrOptions?: PublishWorkspaceOptions | ((progress: TransferProgress) => void),
): Promise<RegistryPublishResult> {
  const { base, token } = connection();
  const options = typeof optionsOrProgress === 'object' && optionsOrProgress !== null
    ? optionsOrProgress
    : (typeof progressOrOptions === 'object' && progressOrOptions !== null ? progressOrOptions : {});
  const onProgress = typeof optionsOrProgress === 'function'
    ? optionsOrProgress
    : (typeof progressOrOptions === 'function' ? progressOrOptions : undefined);
  const provenance = normalizePluginProvenance({
    sourceKind: options.sourceKind ?? workspace.sourceKind,
    sourceLabel: options.sourceLabel ?? workspace.sourceLabel,
  }, workspace.sourceKind || 'UNKNOWN');
  return tauriInvoke<RegistryPublishResult>('publish_draft_workspace', {
    input: {
      apiBase: base,
      authToken: token,
      workspaceId: workspace.workspaceId,
      packageId: options.packageId || undefined,
      sourceKind: provenance.sourceKind,
      sourceLabel: provenance.sourceLabel,
    },
    onEvent: progressChannel(onProgress),
  });
}

export function readWorkspaceFiles(workspaceId: string): Promise<DraftFile[]> {
  return readTaggedWorkspaceFiles(workspaceId);
}

export async function loadDraftWorkspacePlugin(workspace: Workspace): Promise<LoadedPlugin> {
  const files = await readWorkspaceFiles(workspace.workspaceId);
  const manifestFile = files.find((file) => file.path === 'manifest.json');
  const manifest = manifestFile && !manifestFile.binary ? JSON.parse(manifestFile.content) as Record<string, unknown> : {};
  return {
    id: workspace.workspaceId,
    name: workspace.title,
    description: String(manifest.description || ''),
    version: workspace.currentVersion,
    entry: String(manifest.entry || 'ui/index.html'),
    runtime_type: workspace.runtime,
    source: 'installed',
    draft: true,
    local: true,
    manifest,
    files,
    _meta: {
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      source: 'workspace',
      sourceKind: workspace.sourceKind,
      sourceLabel: workspace.sourceLabel,
      conversationId: workspace.conversationId || undefined,
    },
  };
}

export async function createWorkflowUpgradeDraft(
  plugin: LoadedPlugin,
  suggestions: WorkflowUpgradeSuggestion[],
): Promise<LoadedPlugin> {
  if (plugin.runtime_type !== 'workflow' || !plugin.files?.length) throw new Error('当前工作流没有可复制的发行版文件');
  const manifestFile = plugin.files.find((file) => file.path === 'manifest.json' && !file.binary);
  if (!manifestFile) throw new Error('当前工作流缺少 manifest.json');
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(manifestFile.content) as Record<string, unknown>; }
  catch { throw new Error('当前工作流 manifest.json 无法解析'); }
  const manifestId = String(manifest.id || '').trim();
  if (!manifestId) throw new Error('当前工作流 manifest ID 无效');
  const adopted = applyWorkflowUpgradeSuggestions(plugin.files, plugin.entry, suggestions);
  const workspace = await createDraftWorkspace({
    title: `${plugin.name} 升级草稿`,
    manifestId,
    version: adopted.version,
    runtime: 'workflow',
    sourceKind: 'LINGFANG_CREATOR',
    sourceLabel: '工作流升级建议',
  });
  try {
    const synced = await persistDraftWorkspace({
      preferredWorkspaceId: workspace.workspaceId,
      title: workspace.title,
      manifestId,
      version: adopted.version,
      runtime: 'workflow',
      sourceKind: 'LINGFANG_CREATOR',
      sourceLabel: '工作流升级建议',
      files: adopted.files,
    });
    return loadDraftWorkspacePlugin(synced);
  } catch (error) {
    await deleteDraftWorkspace(workspace.workspaceId).catch(() => undefined);
    throw error;
  }
}

export async function exportDraftWorkspace(workspaceId: string): Promise<string> {
  const result = await tauriInvoke<{ artifactPath: string }>('pack_draft_workspace', { workspaceId });
  return result.artifactPath;
}

export async function persistDraftWorkspace(input: {
  preferredWorkspaceId?: string;
  title: string;
  manifestId: string;
  version: string;
  runtime: 'client' | 'cloud' | 'nodejs' | 'python' | 'workflow';
  conversationId?: string | null;
  sourceKind?: PluginReleaseSourceKind;
  sourceLabel?: string;
  files: DraftFile[];
}): Promise<Workspace> {
  const workspaces = await listDraftWorkspaces();
  let workspace = workspaces.find((item) => item.workspaceId === input.preferredWorkspaceId)
    || workspaces.find((item) => item.manifestId === input.manifestId);
  if (!workspace) {
    workspace = await createDraftWorkspace({
      title: input.title,
      manifestId: input.manifestId,
      version: input.version,
      runtime: input.runtime,
      conversationId: input.conversationId,
      sourceKind: input.sourceKind,
      sourceLabel: input.sourceLabel,
    });
  }
  await writeWorkspaceFiles(workspace.workspaceId, input.files);
  const provenance = normalizePluginProvenance({
    sourceKind: input.sourceKind ?? workspace.sourceKind,
    sourceLabel: input.sourceLabel ?? workspace.sourceLabel,
  }, workspace.sourceKind || 'LINGFANG_CREATOR');
  const synced = await tauriInvoke<Workspace>('sync_draft_workspace_metadata', {
    workspaceId: workspace.workspaceId,
    conversationId: input.conversationId,
    sourceKind: provenance.sourceKind,
    sourceLabel: provenance.sourceLabel,
  });
  return normalizeWorkspace(synced);
}
