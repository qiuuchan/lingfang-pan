// CommandPalette.tsx — 全局搜索悬浮窗（Task 6，参考 lingfang-v4 CommandPalette）。
//
// 触发：侧边栏顶部「搜索」按钮 或 Ctrl/Cmd+K 快捷键（App.tsx 注册）。
// 交互：全屏遮罩 backdrop-blur + 顶部居中浮层；Esc 关闭、方向键导航、Enter 执行。
// 结果分组：已安装（固定插件）→ 市场（后端搜索）→ 动作（页面跳转）→ 创建（引导新建）。
//
// 与 v4 差异：main 无 setDetailPlugin，市场结果跳插件工作台「市场插件」tab；动作集合对齐 main 的 View 枚举；
// 类型 SearchResult/SearchResultGroup 本地定义（v4 放 types.ts，此处自洽避免污染主类型）。
import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '@/App';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SearchIcon } from 'lucide-react';
import type { LoadedPlugin, View } from '@/lib/types';
import { listMarketplaceRegistry, type RegistryCatalogItem } from '@/lib/plugin-registry';
import type { PluginCenterTab } from '@/pages/plugins/PluginCenterBody';

export type SearchResultGroup = 'installed' | 'market' | 'action' | 'create';

export interface SearchResult {
  id: string;
  title: string;
  description?: string;
  group: SearchResultGroup;
  badge?: string;
  actionLabel?: string;
  action: () => void;
}

const GROUPS: { key: SearchResultGroup; label: string }[] = [
  { key: 'installed', label: '已安装' },
  { key: 'market', label: '市场' },
  { key: 'action', label: '动作' },
  { key: 'create', label: '创建' },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setView, setRunningPlugin, pinnedPlugins, session, openPluginCenter } = useApp();
  const [marketCatalog, setMarketCatalog] = useState<RegistryCatalogItem[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时重置 + 聚焦。
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setMarketCatalog([]);
      setFocusIndex(0);
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      void listMarketplaceRegistry()
        .then(setMarketCatalog)
        .catch(() => {
          /* 市场不可达时仍保留本地插件与动作搜索。 */
        });
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // 动作集合（按角色过滤 team-admin / review）。
  const actions = useCallback((): SearchResult[] => {
    const go = (v: View, title: string, description: string): SearchResult => ({
      id: `action-${v}`,
      title,
      description,
      group: 'action',
      action: () => {
        setRunningPlugin(null);
        setView(v);
        onClose();
      },
      actionLabel: '前往',
    });
    // 插件中心 / 市场进入主区插件工作台运行页（带初始 tab）。
    const openCenter = (
      tab: PluginCenterTab,
      title: string,
      description: string
    ): SearchResult => ({
      id: `action-plugin-center-${tab}`,
      title,
      description,
      group: 'action',
      action: () => {
        openPluginCenter(tab);
        onClose();
      },
      actionLabel: '前往',
    });
    const list: SearchResult[] = [
      go('home', '首页', '推荐插件与搜索'),
      go('creator', '创建插件', '用 AI 生成新插件'),
      openCenter('installed', '已安装插件', '本机可运行插件'),
      openCenter('team', '团队插件库', '团队已发布版本'),
      openCenter('market', '插件市场', '浏览发现插件'),
      go('draft-plugins', '草稿管理', '管理插件开发工作区'),
      go('settings', '设置', '通用、模型与计费、插件、更新'),
      go('team-wallet', '团队钱包', '团队余额与灵石'),
    ];
    if (session.role === 'TEAM_ADMIN') list.push(go('team-admin', '团队管理', '成员/角色/审批'));
    if (session.isPlatformAdmin) list.push(go('review', '审核中心', '插件审核与发布'));
    return list;
  }, [session.role, session.isPlatformAdmin, setRunningPlugin, setView, openPluginCenter, onClose]);

  // 合并搜索结果。
  const recompute = useCallback(
    (q: string, market: RegistryCatalogItem[]) => {
      const lower = q.toLowerCase();
      const installed: SearchResult[] = pinnedPlugins
        .filter((p) => p.name.toLowerCase().includes(lower))
        .slice(0, 5)
        .map((p: LoadedPlugin) => ({
          id: `installed-${p.id}`,
          title: p.name,
          description: '已安装',
          group: 'installed',
          action: () => {
            setRunningPlugin(p);
            onClose();
          },
          actionLabel: '打开',
        }));

      const installedPackageIds = new Set(pinnedPlugins.map((p) => p.packageId).filter(Boolean));
      const marketHits: SearchResult[] = market
        .filter((item) => {
          if (installedPackageIds.has(item.package.id)) return false;
          const searchable = [
            item.package.name,
            item.package.description,
            item.package.manifestId,
            item.latestRelease.version,
          ];
          return searchable.some(
            (value) => typeof value === 'string' && value.toLowerCase().includes(lower)
          );
        })
        .slice(0, 5)
        .map((item) => ({
          id: `market-${item.package.id}`,
          title: item.package.name,
          description: item.package.description || item.package.manifestId,
          group: 'market',
          badge: (item.priceCents || 0) === 0 ? '免费' : undefined,
          action: () => {
            openPluginCenter('market');
            onClose();
          },
          actionLabel: '前往',
        }));

      const acts = actions().filter(
        (a) =>
          a.title.toLowerCase().includes(lower) ||
          (a.description?.toLowerCase().includes(lower) ?? false)
      );

      const create: SearchResult[] = [];
      if (q.trim().length >= 3) {
        create.push({
          id: 'create-new',
          title: '创建插件',
          group: 'create',
          description: `没找到「${q.trim()}」？让 AI 创建一个新插件`,
          action: () => {
            setView('creator');
            onClose();
          },
          actionLabel: '创建',
        });
      }

      const merged = [...installed, ...marketHits, ...acts, ...create];
      setResults(merged);
      setFocusIndex(0);
    },
    [pinnedPlugins, actions, setRunningPlugin, openPluginCenter, onClose]
  );

  // Registry catalog 不提供搜索接口；目录只拉取一次，输入时与本地结果一起即时过滤。
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    recompute(query, marketCatalog);
  }, [marketCatalog, query, recompute]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[focusIndex]) {
      e.preventDefault();
      results[focusIndex].action();
    }
  };

  if (!open) return null;

  let runningIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      {/* 遮罩：背景模糊（Task 6 要求）。 */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      {/* 浮层。 */}
      <div
        className="relative w-full max-w-xl overflow-hidden rounded-xl border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜插件、搜功能，或描述你想创建的工具…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
          />
          <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>

        {results.length > 0 ? (
          <div className="max-h-[50vh] overflow-y-auto p-2">
            {GROUPS.map((group) => {
              const groupResults = results.filter((r) => r.group === group.key);
              if (groupResults.length === 0) return null;
              return (
                <div key={group.key} className="mb-1">
                  <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    {group.label}
                  </div>
                  {groupResults.map((r) => {
                    const idx = runningIndex++;
                    const focused = idx === focusIndex;
                    return (
                      <button
                        key={r.id}
                        onClick={r.action}
                        onMouseEnter={() => setFocusIndex(idx)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                          focused ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{r.title}</div>
                          {r.description && (
                            <div className="truncate text-xs text-muted-foreground">
                              {r.description}
                            </div>
                          )}
                        </div>
                        {r.badge && (
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                            {r.badge}
                          </span>
                        )}
                        {r.actionLabel && (
                          <kbd
                            className={cn(
                              'shrink-0 rounded border px-1.5 py-0.5 text-[10px]',
                              focused
                                ? 'border-primary/30 text-primary'
                                : 'border-border text-muted-foreground'
                            )}
                          >
                            {r.actionLabel}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : query.trim().length >= 3 ? (
          <div className="p-6 text-center">
            <p className="mb-3 text-sm text-muted-foreground">没找到匹配「{query.trim()}」的插件</p>
            <Button
              onClick={() => {
                setView('creator');
                onClose();
              }}
            >
              创建插件草稿
            </Button>
          </div>
        ) : (
          <div className="p-6 text-center text-sm text-muted-foreground">
            输入关键词搜索插件，或按{' '}
            <kbd className="rounded border bg-muted px-1 text-[10px]">↑↓</kbd> 选择动作。
          </div>
        )}
      </div>
    </div>
  );
}
