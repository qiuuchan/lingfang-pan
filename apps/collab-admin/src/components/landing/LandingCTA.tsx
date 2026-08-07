// 落地页底部转化区：在 Footer 之前提供第二个明确的行动入口。

interface CTAProps {
  onLogin: () => void;
  onNavigateDownload: () => void;
}

export function LandingCTA({ onLogin, onNavigateDownload }: CTAProps) {
  return (
    <section className="py-20 sm:py-28" style={{ borderTop: '1px solid var(--lf-border)' }}>
      <div className="mx-auto max-w-6xl px-6">
        <div
          className="lf-card px-6 py-14 sm:px-16 sm:py-16 text-center"
          style={{ backgroundColor: 'var(--lf-bg-elevated)' }}
        >
          <h2
            className="lf-display text-3xl sm:text-4xl font-semibold tracking-tight"
            style={{ color: 'var(--lf-fg)' }}
          >
            让团队开始构建自己的 AI 插件库
          </h2>
          <p className="mt-4 mx-auto max-w-2xl text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
            下载桌面端，几分钟内创建你的第一个插件；已是平台管理员？直接登录管理后台。
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button onClick={onNavigateDownload} className="lf-btn-primary text-base">
              下载客户端
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              onClick={onLogin}
              className="lf-icon-btn"
              aria-label="管理员入口"
              title="管理员入口"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
