// 落地页顶部导航（logo + 锚点 + 登录按钮）。
// 「下载」「更新日志」均不再是同页锚点（已独立为全屏页），点击触发回调切换状态机视图。
// 无 GitHub 链接（按需求移除外部仓库引用）。
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
      className="fixed top-0 inset-x-0 z-50 backdrop-blur-md border-b"
      style={{
        backgroundColor: 'rgba(15, 20, 25, 0.72)',
        borderBottomColor: 'var(--lf-border)',
      }}
    >
      <nav className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
        <a href="#lf-top" className="flex items-center gap-2.5 group">
          <span
            className="lf-mono inline-flex h-8 w-8 items-center justify-center rounded-md border text-sm font-bold transition-shadow group-hover:shadow-[0_0_16px_-2px_var(--lf-accent-glow)]"
            style={{ borderColor: 'var(--lf-accent)', color: 'var(--lf-accent)' }}
          >
            L
          </span>
          <span className="font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>LingFang</span>
        </a>

        <div className="hidden md:flex items-center gap-7 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
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
      className="lf-mono inline-flex items-center justify-center rounded-md border font-bold"
      style={{
        height: size,
        width: size,
        fontSize: size * 0.5,
        borderColor: 'var(--lf-accent)',
        color: 'var(--lf-accent)',
      }}
    >
      L
    </span>
  );
}
