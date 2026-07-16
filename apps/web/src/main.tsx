import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { MarketplaceDiscoveryHome as DiscoveryHome, MarketplaceOrderListItem, MarketplaceOwnerQuality, PublicPluginCard as Card, PublicPluginDetail as Detail } from '@lingfang/contract';
import { CloudTrialPanel } from './CloudTrialPanel';
import { loadCatalog, loadDiscoveryHome, loadPluginDetail } from './cloud-trial';
import { SessionBar } from './SessionBar';
import { campaignIdFromSearch, loadCampaignAttributionToken, loadOwnerQuality, loadWebOrders, purchaseWebPlugin, submitQualityAppeal } from './marketplace-commerce';
import { ClientSandboxPreview } from './ClientSandboxPreview';
import { OwnerQualityPanel } from './OwnerQualityPanel';
import { WebApiError } from './api';
import './style.css';

function Markdown({ source }: { source: string }) {
  const blocks = source.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return <div className="markdown">{blocks.map((block, index) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(block);
    if (heading) { const Tag = `h${heading[1].length}` as 'h1'|'h2'|'h3'; return <Tag key={index}>{heading[2]}</Tag>; }
    if (block.startsWith('```')) return <pre key={index}><code>{block.replace(/^```[^\n]*\n?|```$/g, '')}</code></pre>;
    return <p key={index}>{block}</p>;
  })}</div>;
}

function Catalog() {
  const [data, setData] = useState<{ items: Card[] } | null>(null);
  const [home, setHome] = useState<DiscoveryHome | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [runtime, setRuntime] = useState('ALL');
  useEffect(() => { Promise.all([loadCatalog(), loadDiscoveryHome()]).then(([page, discovery]) => { setData(page); setHome(discovery); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, []);
  const sections = home ? [
    { key: 'featured', title: '精选', items: home.featured },
    { key: 'popular', title: '分类热门', items: home.category_popular },
    { key: 'quality', title: '近期优质', items: home.recent_quality },
  ].filter((section) => section.items.length > 0) : [];
  const filter = (items: Card[]) => items.filter((item) => (!query.trim() || `${item.name} ${item.summary} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase())) && (runtime === 'ALL' || item.runtime_type === runtime));
  return <main><header><span>LINGFANG</span><h1>插件中心</h1><p>发现经过审核、可追溯版本的团队插件。</p><a href="/orders">我的订单</a></header><section className="catalog-filters" aria-label="目录筛选"><input aria-label="搜索插件" placeholder="搜索名称、简介或分类" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="运行时筛选" value={runtime} onChange={(e) => setRuntime(e.target.value)}><option value="ALL">全部运行时</option><option value="client">Client</option><option value="cloud">Cloud</option><option value="nodejs">Node.js</option><option value="python">Python</option></select></section>{error && <div className="error">{error}</div>}{sections.map((section) => <section className="catalog-section" key={section.key}><h2>{section.title}</h2><div className="grid">{filter(section.items).map((item) => <PluginCard item={item} key={item.package_id}/>)}</div></section>)}{sections.length === 0 && <section className="grid">{filter(data?.items ?? []).map((item) => <PluginCard item={item} key={item.package_id}/>)}</section>}</main>;
}

function PluginCard({ item }: { item: Card }) {
  const tier = ({ LISTED: '已上架', QUALITY: '优质', FEATURED: '精选' } as const)[item.quality_tier];
  return <a className="card" href={`/plugins/${item.package_id}`}><div className="tags"><b>{tier}</b><span>{item.category}</span><span>{item.runtime_type}</span></div><h2>{item.name}</h2><p>{item.summary || '暂无简介'}</p><small>v{item.version} · 安装 {item.install_count} · {formatPrice(item.effective_price_cents ?? item.base_price_cents)}</small></a>;
}

function PreviewPage({ item }: { item: Detail }) {
  if (item.preview_mode === 'CLOUD_TRIAL') return <CloudTrialPanel detail={item} />;
  if (item.preview_mode === 'CLIENT_SANDBOX') return <ClientSandboxPreview detail={item} />;
  return <section className="preview" data-mode={item.preview_mode}><h2>仅支持桌面运行</h2><p>该插件需要 {item.runtime_type} 本地运行时，Web 端不会执行代码或伪造输出。</p><a className="button" href={`lingfang://plugins/${encodeURIComponent(item.package_id)}`}>在桌面端打开</a></section>;
}

function DetailPage({ id, preview }: { id: string; preview: boolean }) {
  const [item, setItem] = useState<Detail | null>(null);
  const [ownerQuality, setOwnerQuality] = useState<MarketplaceOwnerQuality | null>(null);
  const [error, setError] = useState('');
  const [purchaseState, setPurchaseState] = useState('');
  const [campaignToken, setCampaignToken] = useState('');
  const campaignId = campaignIdFromSearch(location.search);
  useEffect(() => {
    loadPluginDetail(id).then(setItem).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    loadOwnerQuality(id).then(setOwnerQuality).catch((cause) => {
      if (!(cause instanceof WebApiError) || ![401, 403, 404].includes(cause.status)) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [id]);
  if (error) return <main><div className="error">{error}</div></main>;
  if (!item) return <main><p aria-live="polite">加载插件信息…</p></main>;
  if (preview) return <main><a href={`/plugins/${id}`}>← 返回详情</a><header><h1>{item.name} · 在线预览</h1><p>根据发行版 runtime 使用真实 Cloud Trial、安全浏览器沙箱或桌面承接。</p></header><PreviewPage item={item}/></main>;
  const detail = item;
  const price = detail.effective_price_cents ?? detail.base_price_cents;
  async function acquire() {
    setPurchaseState(price === 0 ? '获取中…' : '购买中…');
    try {
      let token = campaignToken;
      if (campaignId && !token) {
        const attribution = await loadCampaignAttributionToken(campaignId, detail.package_id);
        token = attribution.campaign_token;
        setCampaignToken(token);
      }
      await purchaseWebPlugin(detail, { campaignToken: token || undefined });
      setPurchaseState(price === 0 ? '已获取，可在桌面端下载' : '购买成功，可在桌面端下载');
    } catch (cause) {
      setPurchaseState(cause instanceof Error ? cause.message : (price === 0 ? '获取失败' : '购买失败'));
    }
  }
  return <main><a href="/plugins">← 返回插件中心</a><header><div className="tags"><b>{item.quality_tier}</b><span>{item.preview_mode}</span>{campaignId && <span>Campaign</span>}</div><h1>{item.name}</h1><p>{item.summary}</p><div className="actions"><a className="button" href={`/plugins/${id}/preview${location.search}`}>{item.preview_mode === 'STATIC_DESKTOP' ? '查看运行方式' : '查看在线预览'}</a><button className="button" disabled={purchaseState.endsWith('中…')} onClick={() => void acquire()}>{price === 0 ? '免费获取' : `购买 ${formatPrice(price)}`}</button></div>{purchaseState && <p aria-live="polite">{purchaseState}</p>}</header><div className="layout"><article><Markdown source={item.readme_markdown}/></article><aside><h3>价格</h3><p>{formatPrice(price)}</p><h3>版本</h3><p>{item.version}</p><h3>运行时</h3><p>{item.runtime_type}</p><h3>兼容性</h3><p>{item.compatibility.web_compatible ? '支持 Web' : '需要桌面端'}</p>{item.preview_actions.length > 0 && <><h3>可试跑 Action</h3><p>{item.preview_actions.map((action) => action.name).join('、')}</p></>}</aside></div>{ownerQuality && <OwnerQualityPanel quality={ownerQuality} onAppeal={(body) => submitQualityAppeal(id, body).then(() => undefined)} />}</main>;
}

function OrdersPage() {
  const [items, setItems] = useState<MarketplaceOrderListItem[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { loadWebOrders().then(setItems).catch((cause) => setError(cause instanceof Error ? cause.message : '订单加载失败')); }, []);
  return <main><a href="/plugins">← 返回插件中心</a><header><h1>我的插件订单</h1><p>显示当前团队的许可订单、结算与退款状态。</p></header>{error && <div className="error">{error}</div>}<section className="orders">{items.map((item) => <article className="card" key={item.id}><h2>{item.package_name}</h2><p>{formatPrice(item.price_cents)} · {orderStatus(item.status)}</p><small>{formatDate(item.created_at)}{item.refundable_until ? ` · 退款申请截止 ${formatDate(item.refundable_until)}` : ''}</small></article>)}{!error && items.length === 0 && <p>当前团队暂无插件订单。</p>}</section></main>;
}

function formatPrice(cents: number) { return cents === 0 ? '免费' : `¥${(cents / 100).toFixed(2)}`; }
function formatDate(value: unknown) { const date = new Date(String(value || '')); return Number.isFinite(date.getTime()) ? date.toLocaleString() : ''; }
function orderStatus(value: string) { return ({ PENDING_SETTLEMENT: '待结算', REFUND_REQUESTED: '退款审核中', SETTLED: '已结算', REFUNDED: '已退款' } as Record<string, string>)[value] ?? value; }

function App() { const parts = location.pathname.split('/').filter(Boolean); return <><SessionBar/>{parts[0] === 'orders' ? <OrdersPage/> : parts[0] !== 'plugins' || !parts[1] ? <Catalog/> : <DetailPage id={parts[1]} preview={parts[2] === 'preview'}/>}</>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
