import { api as defaultApi } from '@/lib/api';
import { writePluginFiles as defaultWritePluginFiles } from '@/lib/plugin-status';
import type { DraftFile, LoadedPlugin } from '@/lib/types';

type ApiFn = <T = unknown>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>;
type WritePluginFilesFn = (pluginId: string, files: DraftFile[]) => Promise<void>;

type PluginInstallationDeps = {
  api?: ApiFn;
  writePluginFiles?: WritePluginFilesFn;
};

function pluginFiles(plugin: LoadedPlugin | undefined): DraftFile[] {
  return Array.isArray(plugin?.files) ? plugin.files : [];
}

function pluginManifestFile(plugin: LoadedPlugin): DraftFile | null {
  if (!plugin.manifest || typeof plugin.manifest !== 'object') return null;
  return {
    path: 'manifest.json',
    content: JSON.stringify(plugin.manifest, null, 2),
  };
}

export function pluginPackageFiles(plugin: LoadedPlugin): DraftFile[] {
  const files = pluginFiles(plugin);
  const manifestFile = pluginManifestFile(plugin);
  if (!manifestFile) return files;
  return [manifestFile, ...files.filter((file) => file.path !== 'manifest.json')];
}

export async function ensurePluginPackagePersisted(
  plugin: LoadedPlugin,
  writePluginFiles: WritePluginFilesFn = defaultWritePluginFiles,
): Promise<void> {
  const rawFiles = pluginFiles(plugin);
  if (!rawFiles.length) {
    throw new Error('后端未返回插件文件，无法写入本地插件目录。');
  }
  if (!rawFiles.some((file) => file.path !== 'manifest.json')) {
    throw new Error('后端未返回插件入口文件，无法写入本地插件目录。');
  }
  const files = pluginPackageFiles(plugin);
  if (!files.some((file) => file.path === 'manifest.json')) {
    throw new Error('后端未返回 manifest.json，无法写入本地插件目录。');
  }
  await writePluginFiles(plugin.id, files);
}

export async function installMarketplacePluginPackage(
  pluginId: string,
  deps: PluginInstallationDeps = {},
): Promise<LoadedPlugin> {
  const api = deps.api ?? defaultApi;
  const writePluginFiles = deps.writePluginFiles ?? defaultWritePluginFiles;

  await api('/api/marketplace/install', {
    method: 'POST',
    body: { plugin_id: pluginId },
  });

  const result = await api<{ plugins: LoadedPlugin[] }>('/api/plugins/available');
  const plugin = result.plugins.find((item) => item.id === pluginId);
  if (!plugin) {
    throw new Error('安装已记录，但 /api/plugins/available 未返回该插件。');
  }
  await ensurePluginPackagePersisted(plugin, writePluginFiles);
  return plugin;
}
