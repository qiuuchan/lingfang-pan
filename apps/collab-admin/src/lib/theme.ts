import { useCallback, useEffect, useState } from 'react';

// 平台设置页主题切换所需的状态类型：亮 / 暗 / 跟随系统。
export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'lf:collab-admin:theme';

function readStored(): ThemeMode {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

// 将 ThemeMode 解析为实际生效的 'light' | 'dark'：system 时跟随 prefers-color-scheme。
function resolveApplied(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

// 在 <html> 上切换 .dark class。切换前临时挂 theme-transition 平滑过渡，切换后移除以恢复性能。
function applyTheme(mode: ThemeMode) {
  const applied = resolveApplied(mode);
  const root = document.documentElement;
  document.body.classList.add('theme-transition');
  root.classList.toggle('dark', applied === 'dark');
  // 过渡动画时长 200ms（见 index.css），动画结束后移除临时 class。
  window.setTimeout(() => document.body.classList.remove('theme-transition'), 220);
}

// 初始化主题：在应用挂载前同步执行，避免首屏亮暗闪烁（FOUC）。
// App.tsx 的模块顶层调用此函数一次；后续切换通过 useTheme 提供的 setTheme。
export function initTheme() {
  applyTheme(readStored());
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => readStored());

  // 监听系统主题变化：仅当用户选择 system 时才同步更新生效主题。
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (readStored() === 'system') applyTheme('system');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const setTheme = useCallback((next: ThemeMode) => {
    setMode(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  }, []);

  return { mode, setTheme };
}
