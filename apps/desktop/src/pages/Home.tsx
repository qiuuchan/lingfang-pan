// Home.tsx — 首页（Task 2：居中搜索 + 最近使用插件，参考 lingfang-v4 EmptyState）。
//
// 设计：垂直水平居中的极简落地——大号搜索框（点击/回车唤起 CommandPalette）+「最近使用」
// 插件胶囊（取自固定插件 pinnedPlugins）+ 创建插件入口。移除原首页的市场推荐列表
// （市场发现统一走 CommandPalette / 市场页，首页聚焦「快速到达」而非「浏览」）。
import { useApp } from '@/App';
import type { LoadedPlugin } from '@/lib/types';
import { SearchIcon, PlusIcon, SparklesIcon } from 'lucide-react';

export function Home() {
  const { openSearch, pinnedPlugins, setView, setRunningPlugin, session } = useApp();
  // 最近使用：固定插件取前 6 个（胶囊一行排得下，多了换行）。
  const recent = pinnedPlugins.slice(0, 6);
  const greeting = greet(session.displayName);

  return (
    // min-h 用 calc 撑满主体可视高（视口高 - TitleBar h-9 2.25rem - 滚动容器 py-6 3rem），
    // 使 items-center / justify-center 真正生效（原 h-full 因父级 max-w-6xl 无明确高度而解析为 auto，垂直居中失效）。
    <div className="flex min-h-[calc(100dvh-5.25rem)] w-full flex-col items-center justify-center px-6 py-10">
      {/* 问候 + 副标题 */}
      <div className="mb-7 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{greeting}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">今天想用什么工具？</p>
      </div>

      {/* 居中大搜索框：点击唤起搜索悬浮窗（与 Ctrl+K / 侧栏搜索按钮同源）。 */}
      <button
        type="button"
        onClick={openSearch}
        className="group flex w-full max-w-xl items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3.5 text-left text-sm text-muted-foreground shadow-sm transition-all hover:border-primary/40 hover:shadow-md"
      >
        <SearchIcon className="size-4 shrink-0 transition-colors group-hover:text-primary" />
        <span className="flex-1">搜插件、搜功能，或描述你想创建的工具…</span>
        <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Ctrl K</kbd>
      </button>

      {/* 最近使用插件 */}
      {recent.length > 0 && (
        <div className="mt-6 flex w-full max-w-xl flex-col items-center gap-2">
          <span className="text-xs text-muted-foreground/70">最近使用</span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {recent.map((p: LoadedPlugin) => (
              <button
                key={p.id}
                onClick={() => { setRunningPlugin(p); setView('plugins'); }}
                className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:text-primary"
                title={p.name}
              >
                <SparklesIcon className="size-3 text-primary/70" />
                <span className="max-w-[10rem] truncate">{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 创建插件入口（与右下角 FAB 互补，文字链形式）。 */}
      <button
        type="button"
        onClick={() => setView('creator')}
        className="mt-8 flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        <PlusIcon className="size-3" />
        或创建一个新插件
      </button>
    </div>
  );
}

// 按当前小时给出问候语，避免「Hello」式英文模板感。
function greet(name: string | null): string {
  const hour = new Date().getHours();
  const who = name ? `，${name}` : '';
  if (hour < 6) return `夜深了${who}`;
  if (hour < 12) return `早上好${who}`;
  if (hour < 14) return `中午好${who}`;
  if (hour < 18) return `下午好${who}`;
  return `晚上好${who}`;
}
