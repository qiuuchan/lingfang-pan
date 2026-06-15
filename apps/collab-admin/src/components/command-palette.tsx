import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CornerDownLeftIcon, SearchIcon } from 'lucide-react';
import { NAV_GROUPS, NAV_ITEMS } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import type { View } from '@/lib/types';

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (view: View) => void;
};

// 组C：Cmd+K / Ctrl+K 快捷搜索面板。
// 仅按视图名过滤（不做数据检索，复杂度可控），命中后跳转对应 View。
// 动画用 framer-motion 的 AnimatePresence 做遮罩淡入 + 面板缩放/位移。
export function CommandPalette({ open, onOpenChange, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 过滤结果：query 为空时展示全部（分组保留）；非空时跨分组模糊匹配视图名。
  const matchedGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV_GROUPS;
    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.view.toLowerCase().includes(q) ||
          group.title.toLowerCase().includes(q),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  // 扁平化的命中项，用于键盘上下键导航索引。
  const flatMatched = useMemo(
    () => matchedGroups.flatMap((group) => group.items),
    [matchedGroups],
  );

  // 打开时聚焦输入框 + 重置状态；关闭时清空 query。
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // 延迟一帧聚焦，等 motion 动画挂载完成。
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // 活跃索引越界保护：过滤结果变化时重置到首项。
  useEffect(() => {
    if (activeIndex >= flatMatched.length) setActiveIndex(0);
  }, [flatMatched.length, activeIndex]);

  // 活跃项滚入可视区（键盘导航时）。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const choose = useCallback(
    (view: View) => {
      onSelect(view);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatMatched.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = flatMatched[activeIndex];
      if (target) choose(target.view);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  let runningIndex = -1;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[15vh]">
          {/* 遮罩：点击关闭 */}
          <motion.div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => onOpenChange(false)}
          />
          {/* 面板：缩放 + 轻微上移进入 */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="快捷搜索"
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-xl"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onKeyDown={onKeyDown}
          >
            {/* 搜索输入 */}
            <div className="flex items-center gap-3 border-b px-4">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                placeholder="搜索功能页面…"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-block">
                ESC
              </kbd>
            </div>

            {/* 结果列表 */}
            <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2">
              {flatMatched.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  未找到匹配的页面
                </div>
              ) : (
                matchedGroups.map((group) => (
                  <div key={group.title} className="mb-1">
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
                      {group.title}
                    </div>
                    {group.items.map((item) => {
                      runningIndex += 1;
                      const idx = runningIndex;
                      const Icon = item.icon;
                      const isActive = idx === activeIndex;
                      return (
                        <button
                          key={item.view}
                          data-cmd-index={idx}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={() => choose(item.view)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors',
                            isActive
                              ? 'bg-accent text-accent-foreground'
                              : 'text-foreground hover:bg-accent/60',
                          )}
                        >
                          <Icon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="flex-1">{item.label}</span>
                          {isActive && (
                            <CornerDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* 底部提示栏 */}
            <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border bg-background px-1 py-0.5">↑</kbd>
                <kbd className="rounded border bg-background px-1 py-0.5">↓</kbd>
                选择
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border bg-background px-1 py-0.5">↵</kbd>
                跳转
              </span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// 注册全局 Cmd+K / Ctrl+K 快捷键：在组件树外部挂一次即可，返回当前 open 态 + 切换函数。
// 用法：const { open, setOpen } = useCommandPalette();
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Mac: Cmd+K，Win/Linux: Ctrl+K；忽略输入法组合态。
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return { open, setOpen };
}

// NAV_ITEMS 重导出，便于外部按需取扁平列表（如未来统计视图数）。
export { NAV_ITEMS };
