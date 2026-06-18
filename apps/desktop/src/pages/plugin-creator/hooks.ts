import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, tauriInvoke } from '@/lib/api';
import { buildAssistantProviderCatalog, readRecent, writeRecent, PROVIDERS, safePluginId, type ProviderId } from '@/lib/plugin-draft';
import { toUploadError, type CreatorError } from '@/lib/creator-error';
import { yuanToCents } from '@/lib/money';
import { loadMentionablePlugins, type AttachedPluginRef } from '@/lib/plugin-creator/session-helpers';
import { scanPluginStatus, type LocalPluginStatus } from '@/lib/plugin-status';
import type { DraftFile, LoadedPlugin, View } from '@/lib/types';
import { loadPlugins } from '../plugins-runtime';

type PluginManifestView = {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime_type: string;
  entry: string;
  visibility: string;
  capabilities: unknown;
};

export function useProviderCatalog(modelConfigVersion: number) {
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const [model, setModel] = useState<string>(PROVIDERS[0].models[0] || '');
  const [providers, setProviders] = useState(PROVIDERS);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ provider?: string; defaultModels?: string[] } | null>('/api/llm/active-provider').catch(() => null),
      api<{ binding?: { modelOverride?: string[] | null } } | null>('/api/llm/binding').catch(() => null),
    ])
      .then(([activeProvider, binding]) => {
        if (cancelled) return;
        const catalog = buildAssistantProviderCatalog({
          activeProvider,
          binding: binding?.binding ?? null,
        });
        setProviders(catalog.providers);
        setProvider((current) => catalog.providers.some((item) => item.id === current) ? current : catalog.providers[0]?.id || PROVIDERS[0].id);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [modelConfigVersion]);

  const providerInfo = useMemo(
    () => providers.find((item) => item.id === provider) || providers[0],
    [provider, providers],
  );

  useEffect(() => {
    setModel(providerInfo.models[0]);
  }, [providerInfo.id, providerInfo.models]);

  return { provider, setProvider, model, setModel, providers, providerInfo };
}

export function useMentionablePlugins() {
  const [mentionablePlugins, setMentionablePlugins] = useState<AttachedPluginRef[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const teamRes = await loadPlugins().catch(() => ({ plugins: [], error: '' }));
      if (cancelled) return;
      const mentionable = await loadMentionablePlugins(teamRes.plugins);
      if (!cancelled) setMentionablePlugins(mentionable);
    })();
    return () => { cancelled = true; };
  }, []);

  return mentionablePlugins;
}

export function useCurrentPluginStatus(
  pluginId: string | null,
  streaming: boolean,
  filesLength: number,
) {
  const [pluginStatus, setPluginStatus] = useState<LocalPluginStatus | null>(null);

  useEffect(() => {
    if (!pluginId) {
      setPluginStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const items = await scanPluginStatus();
        if (!cancelled) setPluginStatus(items.find((item) => item.id === pluginId) ?? null);
      } catch {
        if (!cancelled) setPluginStatus(null);
      }
    })();
    return () => { cancelled = true; };
  }, [pluginId, streaming, filesLength]);

  return pluginStatus;
}

export function useStickyChatScroll(deps: readonly unknown[]) {
  const chatRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const handleChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
  };

  useEffect(() => {
    if (stickToBottomRef.current) {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
    }
    // deps are controlled by the caller to avoid exposing page-specific state here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { chatRef, handleChatScroll };
}

export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

export function usePluginUpload(input: {
  files: DraftFile[];
  manifest: PluginManifestView;
  tenantId: string | null;
  pluginIdRef: { current: string | null };
  setPluginId: (pluginId: string | null) => void;
  setRunningPlugin: (plugin: LoadedPlugin | null) => void;
  setView: (view: View) => void;
  setLiveError: (error: CreatorError) => void;
}) {
  const [uploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cloudPlugin, setCloudPlugin] = useState<LoadedPlugin | null>(null);
  const [namingOpen, setNamingOpen] = useState(false);
  const [namingValue, setNamingValue] = useState('');
  const [namingPriceYuan, setNamingPriceYuan] = useState('');
  const [namingLoading, setNamingLoading] = useState(false);

  function pushRecent(plugin: LoadedPlugin) {
    const prev = readRecent(input.tenantId);
    const next = [plugin, ...prev.filter((item) => item.id !== plugin.id)];
    writeRecent(input.tenantId, next.slice(0, 8));
  }

  function uploadCloud() {
    if (!input.files.length) return;
    setNamingValue(input.manifest.name || '');
    setNamingPriceYuan('');
    setNamingOpen(true);
  }

  async function doUpload() {
    const name = namingValue.trim();
    if (!name) return toast.error('请填写插件名称');
    const priceCents = parsePriceCents(namingPriceYuan);
    if (priceCents === null) return;

    setNamingLoading(true);
    try {
      await renameLocalPluginDir(input.pluginIdRef, input.setPluginId, name);
      const uploadManifest = cloudUploadManifest(input.manifest, name);
      const result = await api<{ plugin: LoadedPlugin; deduplicated?: boolean }>('/api/plugins/upload', {
        method: 'POST',
        body: { manifest: uploadManifest, files: input.files, priceCents },
      });
      const plugin = { ...result.plugin, files: input.files, manifest: uploadManifest, source: 'team' as const };
      setCloudPlugin(plugin);
      pushRecent(plugin);
      setNamingOpen(false);
      toast.success(result.deduplicated ? '团队共享中已有相同插件' : '已上传到团队共享');
    } catch (error) {
      const creatorError = toUploadError(error, 'upload');
      input.setLiveError(creatorError);
      toast.error(creatorError.title);
    } finally {
      setNamingLoading(false);
    }
  }

  async function submitMarketplace() {
    if (!cloudPlugin) return toast.error('先上传到团队共享');
    setSubmitting(true);
    try {
      const result = await api<{ plugin: LoadedPlugin }>(`/api/plugins/${cloudPlugin.id}/submit-marketplace`, {
        method: 'POST',
        body: { priceCents: 0 },
      });
      const plugin = { ...cloudPlugin, ...result.plugin, source: 'team' as const };
      setCloudPlugin(plugin);
      pushRecent(plugin);
      toast.success('已提交插件市场审核');
    } catch (error) {
      const creatorError = toUploadError(error, 'submit');
      input.setLiveError(creatorError);
      toast.error(creatorError.title);
    } finally {
      setSubmitting(false);
    }
  }

  function runPlugin(plugin: LoadedPlugin) {
    input.setRunningPlugin(plugin);
    input.setView('plugins');
  }

  return {
    uploading,
    submitting,
    cloudPlugin,
    setCloudPlugin,
    namingOpen,
    namingValue,
    namingPriceYuan,
    namingLoading,
    setNamingOpen,
    setNamingValue,
    setNamingPriceYuan,
    uploadCloud,
    doUpload,
    submitMarketplace,
    runPlugin,
  };
}

function parsePriceCents(priceYuan: string): number | null {
  if (!priceYuan.trim()) return 0;
  try {
    return yuanToCents(priceYuan);
  } catch (error) {
    toast.error((error as Error).message || '定价格式非法');
    return null;
  }
}

async function renameLocalPluginDir(
  pluginIdRef: { current: string | null },
  setPluginId: (pluginId: string | null) => void,
  name: string,
) {
  const oldId = pluginIdRef.current;
  if (!oldId) return;
  const safeNew = safePluginId(name);
  if (!safeNew || safeNew === oldId) return;
  try {
    const renamed = await tauriInvoke<string>('rename_plugin_dir', { oldId, newId: safeNew, title: name });
    setPluginId(renamed);
    pluginIdRef.current = renamed;
  } catch (error) {
    toast.error(`命名持久化目录失败：${(error as Error).message || error}（仍将以上传名展示）`);
  }
}

function cloudUploadManifest(manifest: PluginManifestView, name: string) {
  return {
    id: manifest.id,
    name,
    version: manifest.version,
    description: manifest.description,
    runtime_type: manifest.runtime_type,
    entry: manifest.entry,
    visibility: manifest.visibility,
    capabilities: manifest.capabilities,
  };
}
