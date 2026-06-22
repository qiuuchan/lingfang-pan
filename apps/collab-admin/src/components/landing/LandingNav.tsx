// 落地页顶部导航：纸稿主题下的极简顶栏。
// 「下载」「更新日志」触发自 App.tsx 的状态机切换；「功能」锚点到首页区块。

import type { ReactNode } from 'react';

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

export function LandingNav({ onLogin, onNavigateDownload, onNavigateChangelog }: NavProps) {
  return (
    <header
      className="fixed top-0 inset-x-0 z-50 border-b"
      style={{
        backgroundColor: 'rgba(244, 243, 240, 0.78)',
        borderBottomColor: 'var(--lf-border)',
        backdropFilter: 'blur(14px)',
      }}
    >
      <nav className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
        <a href="#lf-top" className="flex items-center gap-2.5 group">
          <LandingLogo size={32} />
          <span className="lf-display font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>LingFang</span>
        </a>

        <div className="hidden md:flex items-center gap-8 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
          {NAV(onNavigateDownload, onNavigateChangelog).map((item) =>
            item.onClick ? (
              <button
                key={item.label}
                onClick={item.onClick}
                className="transition-colors hover:text-[var(--lf-fg)]"
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit' }}
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
            ),
          )}
        </div>

        <button onClick={onLogin} className="lf-btn-primary text-sm">
          登录管理端
        </button>
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
