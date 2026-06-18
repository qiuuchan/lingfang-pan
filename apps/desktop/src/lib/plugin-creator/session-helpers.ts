import { apiBase, getAuthToken } from '@/lib/api';
import { scanPluginStatus } from '@/lib/plugin-status';
import type { LoadedPlugin } from '@/lib/types';

export interface AttachedPluginRef {
  id: string;
  name: string;
  summary: string;
}

export function pluginManifestSummary(plugin: LoadedPlugin): string {
  const manifestFile = plugin.files?.find((file) => file.path === 'manifest.json');
  if (!manifestFile) return `${plugin.name}（无 manifest）`;
  try {
    const manifest = JSON.parse(manifestFile.content);
    const caps = Array.isArray(manifest.capabilities)
      ? manifest.capabilities.map((cap: { kind?: string }) => cap.kind).filter(Boolean).join('/')
      : '';
    return `${manifest.runtime_type || 'client'}, entry=${manifest.entry || 'ui/index.html'}${caps ? `, capabilities: ${caps}` : ''}`;
  } catch {
    return `${plugin.name}（manifest 解析失败）`;
  }
}

export async function loadMentionablePlugins(teamPlugins: LoadedPlugin[]): Promise<AttachedPluginRef[]> {
  const localItems = await scanPluginStatus().catch(() => []);
  const team = teamPlugins
    .filter((plugin) => plugin.source === 'team')
    .map((plugin) => ({ id: plugin.id, name: plugin.name, summary: pluginManifestSummary(plugin) }));
  const local = localItems.map((item) => ({
    id: item.id,
    name: item.name,
    summary: `${item.runtime || 'client'}, entry=${item.entry || 'ui/index.html'}`,
  }));
  return uniquePluginRefs([...team, ...local]);
}

function uniquePluginRefs(plugins: AttachedPluginRef[]): AttachedPluginRef[] {
  const seen = new Set<string>();
  return plugins.filter((plugin) => (seen.has(plugin.id) ? false : (seen.add(plugin.id), true)));
}

export function promptWithAttachedPlugins(rawText: string, plugins: AttachedPluginRef[]): string {
  if (plugins.length === 0) return rawText;
  const refs = plugins.slice(0, 5).map((plugin) => `- ${plugin.name}（${plugin.summary}）`).join('\n');
  return `[引用插件参考]\n${refs}\n[/引用插件参考]\n${rawText}`;
}

export function buildSdkConfig() {
  const backendUrl = apiBase();
  const authToken = getAuthToken();
  if (!backendUrl || !authToken) return undefined;
  return { backendUrl, authToken };
}
