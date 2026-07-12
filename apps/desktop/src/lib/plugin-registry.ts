import { Channel } from '@tauri-apps/api/core';
import type {
  DraftWorkspace,
  LocalPluginInstallation,
  PluginCatalogItem,
  PluginPackageSummary,
  PluginReleaseSummary,
} from '@lingfang/contract';
import { api, apiBase, getAuthToken, tauriInvoke } from '@/lib/api';
import type { DraftFile, LoadedPlugin } from '@/lib/types';
import { conversationKey, selectedConversationKey } from '@/lib/plugin-creator/creator-session';

export type RegistryCatalogItem = PluginCatalogItem;
export type RegistryPackage = PluginPackageSummary;
export type RegistryRelease = PluginReleaseSummary;
export type Installation = LocalPluginInstallation;
export type Workspace = DraftWorkspace;
export const INSTALLATIONS_CHANGED_EVENT = 'lf:plugin-installations-changed';

function notifyInstallationsChanged() {
  window.dispatchEvent(new CustomEvent(INSTALLATIONS_CHANGED_EVENT));
}

export type TransferProgress = {
  stage: 'packing' | 'downloading' | 'verifying' | 'installing' | 'uploading' | 'finished';
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
    installationOrigin: payload.installation.origin,
    pendingActivation: pendingReleaseId ? { releaseId: pendingReleaseId } : undefined,
    name: String(manifest.name || payload.installation.packageId),
    description: String(manifest.description || ''),
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

export async function buyMarketplacePackage(packageId: string): Promise<void> {
  await api(`/api/plugin-packages/${packageId}/purchase`, { method: 'POST' });
}

export async function startInstalledPlugin(
  plugin: LoadedPlugin,
  teamAccessGranted: boolean,
): Promise<{ pid: number; started_at: string }> {
  const { base, token } = connection();
  return tauriInvoke('start_installed_plugin', {
    installationId: plugin.installationId || plugin.id,
    teamAccessGranted,
    apiBase: base,
    authToken: token,
  });
}

export async function checkRuntimeAccess(packageId: string): Promise<void> {
  await api(`/api/plugin-packages/${packageId}/runtime-access`, { method: 'POST' });
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
  return tauriInvoke<Workspace[]>('list_draft_workspaces');
}

export async function createDraftWorkspace(input: {
  title: string;
  manifestId: string;
  version: string;
  runtime: 'client' | 'cloud' | 'nodejs' | 'python';
  conversationId?: string | null;
}): Promise<Workspace> {
  return tauriInvoke('create_draft_workspace', { input });
}

export async function deleteDraftWorkspace(workspaceId: string): Promise<void> {
  await tauriInvoke('delete_draft_workspace', { workspaceId });
}

export async function importDraftWorkspace(artifactPath: string): Promise<Workspace> {
  return tauriInvoke('import_draft_workspace', { artifactPath });
}

export async function copyInstallationToDraft(installationId: string): Promise<Workspace> {
  return tauriInvoke('copy_installation_to_draft_workspace', { installationId });
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

export async function publishDraftWorkspace(
  workspace: Workspace,
  onProgress?: (progress: TransferProgress) => void,
): Promise<{ package: RegistryPackage; release: RegistryRelease }> {
  const { base, token } = connection();
  return tauriInvoke('publish_draft_workspace', {
    input: {
      apiBase: base,
      authToken: token,
      workspaceId: workspace.workspaceId,
      packageId: undefined,
    },
    onEvent: progressChannel(onProgress),
  });
}

export async function loadDraftWorkspacePlugin(workspace: Workspace): Promise<LoadedPlugin> {
  const paths = await tauriInvoke<string[]>('list_plugin_files', { pluginId: workspace.workspaceId });
  const files = await Promise.all(paths.map(async (path) => ({
    path,
    content: await tauriInvoke<string>('read_local_plugin_file', { pluginId: workspace.workspaceId, file: path }),
  })));
  const manifestFile = files.find((file) => file.path === 'manifest.json');
  const manifest = manifestFile ? JSON.parse(manifestFile.content) as Record<string, unknown> : {};
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
      conversationId: workspace.conversationId || undefined,
    },
  };
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
  runtime: 'client' | 'cloud' | 'nodejs' | 'python';
  conversationId?: string | null;
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
    });
  }
  await tauriInvoke('write_plugin_files', {
    pluginId: workspace.workspaceId,
    files: input.files,
  });
  return tauriInvoke('sync_draft_workspace_metadata', {
    workspaceId: workspace.workspaceId,
    conversationId: input.conversationId,
  });
}
