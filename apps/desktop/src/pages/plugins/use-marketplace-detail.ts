import { useState } from 'react';
import { toast } from 'sonner';
import { api, type ApiError } from '@/lib/api';
import { installMarketplacePluginPackage } from '@/lib/plugin-installation';
import type { MarketPlugin } from './MarketplacePluginsSection';

export function friendlyMarketplaceError(error: ApiError): string {
  if (error.code === 'insufficient_balance') return '余额不足，去「账户设置 → 钱包」查看余额';
  if (error.code === 'payment_required') return '该插件为付费插件，请先购买';
  return error.message;
}

export function useMarketplaceDetail({
  openWallet,
  plugin,
  onReload,
}: {
  openWallet: () => void;
  plugin: MarketPlugin;
  onReload: (plugin: MarketPlugin) => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [buying, setBuying] = useState(false);
  const [rating, setRating] = useState(false);
  const [score, setScore] = useState('5');
  const [comment, setComment] = useState('');
  const reload = () => reloadMarketplacePlugin(plugin.id, onReload);
  const buy = () => buyMarketplacePlugin({ openWallet, plugin, reload, setBuying });
  const install = () => installMarketplacePlugin({ plugin, reload, setInstalling });
  const rate = () => rateMarketplacePlugin({ comment, plugin, reload, score, setComment, setRating });

  return { buying, comment, install, installing, buy, rate, rating, score, setComment, setScore };
}

async function reloadMarketplacePlugin(pluginId: string, onReload: (plugin: MarketPlugin) => void) {
  onReload(await api<MarketPlugin>(`/api/marketplace/plugins/${pluginId}`));
}

async function buyMarketplacePlugin({
  openWallet,
  plugin,
  reload,
  setBuying,
}: {
  openWallet: () => void;
  plugin: MarketPlugin;
  reload: () => Promise<void>;
  setBuying: (buying: boolean) => void;
}) {
  setBuying(true);
  try {
    await api('/api/wallet/purchase', { method: 'POST', body: { plugin_id: plugin.id } });
    toast.success('购买成功 ✓');
    await reload();
  } catch (e) {
    showPurchaseError(e as ApiError, openWallet);
  } finally {
    setBuying(false);
  }
}

async function installMarketplacePlugin({
  plugin,
  reload,
  setInstalling,
}: {
  plugin: MarketPlugin;
  reload: () => Promise<void>;
  setInstalling: (installing: boolean) => void;
}) {
  setInstalling(true);
  try {
    await installMarketplacePluginPackage(plugin.id);
    toast.success('已安装，可在「本地插件」运行');
    await reload();
  } catch (e) {
    toast.error(friendlyMarketplaceError(e as ApiError));
  } finally {
    setInstalling(false);
  }
}

async function rateMarketplacePlugin({
  comment,
  plugin,
  reload,
  score,
  setComment,
  setRating,
}: {
  comment: string;
  plugin: MarketPlugin;
  reload: () => Promise<void>;
  score: string;
  setComment: (comment: string) => void;
  setRating: (rating: boolean) => void;
}) {
  setRating(true);
  try {
    await api('/api/marketplace/rate', { method: 'POST', body: { plugin_id: plugin.id, score: parseInt(score), comment } });
    setComment('');
    await reload();
    toast.success('评分已提交');
  } catch (e) {
    toast.error((e as ApiError).message);
  } finally {
    setRating(false);
  }
}

function showPurchaseError(error: ApiError, openWallet: () => void) {
  if (error.code !== 'insufficient_balance') {
    toast.error(friendlyMarketplaceError(error));
    return;
  }
  toast.error('余额不足', { action: { label: '去钱包', onClick: openWallet } });
}
