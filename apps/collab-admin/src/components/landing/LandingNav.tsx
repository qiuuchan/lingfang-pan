// 落地页顶部导航：产品官网顶栏，含主题切换（浅色/深色/跟随系统）。
// 「下载」「更新日志」「管理员入口」均触发自 App.tsx 的状态机切换。

import type { ReactNode } from 'react';
import { Sun, Moon, Monitor, ShieldCheck } from 'lucide-react';
import { useTheme, type ThemeMode } from '@/lib/theme';

interface NavProps {
  onLogin: () => void;
  onNavigateDownload: () => void;
  onNavigateChangelog: () => void;
}

const NAV = (onNavigateDownload: () => void, onNavigateChangelog: () => void) => [
  { label: '功能', href: '#lf-features', onClick: undefined },
  { label: '下载', href: undefined, onClick: onNavigateDownload },
  { label: '更新日志', href: undefined, onClick: onNavigateChangelog },
];

const THEME_CYCLE: ThemeMode[] = ['light', 'dark', 'system'];
const THEME_ICONS: Record<ThemeMode, ReactNode> = {
  light: <Sun size={18} />,
  dark: <Moon size={18} />,
  system: <Monitor size={18} />,
};
const THEME_LABELS: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

export function LandingNav({ onLogin, onNavigateDownload, onNavigateChangelog }: NavProps) {
  const { mode, setTheme } = useTheme();

  function cycleTheme() {
    const nextIndex = (THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length;
    setTheme(THEME_CYCLE[nextIndex]);
  }

  return (
    <header className="lf-nav">
      <nav className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
        <a href="#lf-top" className="flex items-center gap-2.5 group">
          <LandingLogo size={32} />
          <span
            className="lf-display font-semibold tracking-tight"
            style={{ color: 'var(--lf-fg)' }}
          >
            LingFang
          </span>
        </a>

        <div
          className="hidden md:flex items-center gap-8 text-sm"
          style={{ color: 'var(--lf-fg-muted)' }}
        >
          {NAV(onNavigateDownload, onNavigateChangelog).map((item) =>
            item.onClick ? (
              <button
                key={item.label}
                onClick={item.onClick}
                className="transition-colors hover:text-[var(--lf-fg)]"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {item.label}
              </button>
            ) : (
              <a
                key={item.label}
                href={item.href}
                className="transition-colors hover:text-[var(--lf-fg)]"
                style={{ color: 'inherit' }}
              >
                {item.label}
              </a>
            )
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={cycleTheme}
            className="lf-icon-btn"
            aria-label={`当前主题：${THEME_LABELS[mode]}，点击切换`}
            title={`当前主题：${THEME_LABELS[mode]}`}
          >
            {THEME_ICONS[mode]}
          </button>
          <button
            onClick={onLogin}
            className="lf-icon-btn"
            aria-label="管理员入口"
            title="管理员入口"
          >
            <ShieldCheck size={18} />
          </button>
        </div>
      </nav>
    </header>
  );
}

export function LandingLogo({ size = 32 }: { size?: number }): ReactNode {
  return (
    <span
      className="lf-display inline-flex items-center justify-center rounded-lg border font-bold transition-shadow group-hover:shadow-[0_0_16px_-2px_var(--lf-accent-glow)]"
      style={{
        height: size,
        width: size,
        fontSize: size * 0.48,
        borderColor: 'var(--lf-accent)',
        color: 'var(--lf-accent)',
      }}
    >
      灵
    </span>
  );
}
