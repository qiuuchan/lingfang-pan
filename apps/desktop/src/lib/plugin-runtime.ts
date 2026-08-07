import type { DraftFile, LoadedPlugin } from '@/lib/types';

export type PluginRuntimeType = NonNullable<LoadedPlugin['runtime_type']>;

const RUNTIME_TYPES = new Set<PluginRuntimeType>([
  'client',
  'nodejs',
  'python',
  'cloud',
  'workflow',
]);

function normalizeRuntime(value: unknown): PluginRuntimeType | null {
  if (typeof value !== 'string') return null;
  const runtime = value.toLowerCase();
  return RUNTIME_TYPES.has(runtime as PluginRuntimeType) ? (runtime as PluginRuntimeType) : null;
}

function runtimeFromManifestObject(value: unknown): PluginRuntimeType | null {
  if (!value || typeof value !== 'object') return null;
  const manifest = value as { runtime_type?: unknown; runtimeType?: unknown };
  return normalizeRuntime(manifest.runtime_type) ?? normalizeRuntime(manifest.runtimeType);
}

function runtimeFromManifestFile(files: DraftFile[] | undefined): PluginRuntimeType | null {
  const manifestFile = files?.find((file) => file.path === 'manifest.json');
  if (!manifestFile) return null;
  try {
    return runtimeFromManifestObject(JSON.parse(manifestFile.content));
  } catch {
    return null;
  }
}

export function resolvePluginRuntime(
  plugin: Pick<LoadedPlugin, 'files' | 'manifest' | 'runtime_type'>
): PluginRuntimeType {
  return (
    runtimeFromManifestObject(plugin.manifest) ??
    runtimeFromManifestFile(plugin.files) ??
    normalizeRuntime(plugin.runtime_type) ??
    'client'
  );
}
