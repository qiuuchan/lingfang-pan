// 落地页页脚（无 GitHub / 外部仓库链接）。
const STATIC_NAV = [
  { label: '功能', href: '#lf-features' },
  { label: '架构', href: '#lf-architecture' },
];

export function LandingFooter({
  onNavigateDownload,
  onNavigateChangelog,
}: {
  onNavigateDownload: () => void;
  onNavigateChangelog: () => void;
}) {
  // 年份用构建期常量：避免 SSR/CSR 时间漂移。这里取固定 2026（项目起始年）。
  const year = 2026;
  return (
    <footer className="border-t py-12" style={{ borderTopColor: 'var(--lf-border)' }}>
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-col items-start justify-between gap-8 sm:flex-row">
          <div className="max-w-sm">
            <div className="flex items-center gap-2.5">
              <span
                className="lf-mono inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-bold"
                style={{ borderColor: 'var(--lf-accent)', color: 'var(--lf-accent)' }}
              >
                L
              </span>
              <span className="font-semibold tracking-tight">LingFang</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--lf-fg-muted)' }}>
              用自然语言生成插件。可自托管，契约先行。
            </p>
          </div>

          <nav className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm sm:grid-cols-3">
            {STATIC_NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="transition-colors hover:text-[var(--lf-fg)]"
                style={{ color: 'var(--lf-fg-muted)' }}
              >
                {item.label}
              </a>
            ))}
            <button
              onClick={onNavigateDownload}
              className="justify-self-start transition-colors hover:text-[var(--lf-fg)]"
              style={{ color: 'var(--lf-fg-muted)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              下载
            </button>
            <button
              onClick={onNavigateChangelog}
              className="justify-self-start transition-colors hover:text-[var(--lf-fg)]"
              style={{ color: 'var(--lf-fg-muted)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              更新日志
            </button>
          </nav>
        </div>

        <div
          className="mt-10 flex flex-col items-start justify-between gap-3 border-t pt-6 sm:flex-row sm:items-center"
          style={{ borderColor: 'var(--lf-border)' }}
        >
          <p className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
            // 用 Tauri · NestJS · React · Prisma 构建
          </p>
          <p className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
            © {year} LingFang. MIT License.
          </p>
        </div>
      </div>
    </footer>
  );
}
