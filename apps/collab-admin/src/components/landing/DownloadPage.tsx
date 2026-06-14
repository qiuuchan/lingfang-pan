// 独立全屏下载页。
// 从 /api/releases/latest 取最新版本，展示各平台下载卡片。
// 顶栏：返回首页 + logo。窄列居中内容。API 不可用时优雅降级。
import { useEffect, useState } from 'react';
import { getLatestRelease, formatSize, PLATFORM_META, type Release, type ReleaseAsset } from '@/lib/releases';

type Platform = keyof typeof PLATFORM_META;

function PlatformIcon({ platform }: { platform: Platform }) {
  if (platform === 'WINDOWS') {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 5.5L10.5 4.5v7H3v-6zM3 12.5h7.5v7L3 18.5v-6zM11.5 4.3L21 3v8.5h-9.5V4.3zM11.5 12.5H21V21l-9.5-1.3v-7.2z" />
      </svg>
    );
  }
  if (platform === 'DARWIN') {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M16.4 12.9c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.8-3.5.8-.7 0-1.8-.8-3-.8-1.5 0-2.9.9-3.7 2.3-1.6 2.7-.4 6.7 1.1 8.9.7 1.1 1.6 2.3 2.8 2.3 1.1 0 1.5-.7 2.8-.7 1.3 0 1.7.7 2.8.7 1.2 0 1.9-1.1 2.6-2.2.8-1.2 1.2-2.4 1.2-2.5-.1 0-2.4-.9-2.4-3.5zM14.2 6c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.5.6-1 1.6-.9 2.6 1 .1 2-.5 2.5-1.2z" />
      </svg>
    );
  }
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C7 2 5 3.5 5 6v3h7v1H4.5C2.5 10 2 12.5 2 14s.5 4 2.5 4H6v-2.5c0-1.9 1.6-3.5 3.5-3.5h5c1.7 0 3-1.3 3-3V6c0-2.5-2.5-4-5.5-4zm-3 3.5a1 1 0 110 2 1 1 0 010-2z" />
      <path d="M22 12h-7v1h6.5c1.5 0 2.5-.5 2.5-.5s0 1.5-2.5 1.5H15v2.5c0 1.9-1.6 3.5-3.5 3.5h-5c-1.7 0-3 1.3-3 3V22s0 2 5.5 2 5.5-2 5.5-2v-2.5c0-1.9 1.6-3.5 3.5-3.5h5c1.7 0 3-1.3 3-3v-5c0 .5-1 1.5-2.5 1.5zM14.5 19a1 1 0 110 2 1 1 0 010-2z" />
    </svg>
  );
}

type Status = 'loading' | 'ready' | 'error';

export function DownloadPage({ onBack }: { onBack: () => void }) {
  const [release, setRelease] = useState<Release | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let aborted = false;
    getLatestRelease()
      .then((data) => {
        if (!aborted) {
          setRelease(data);
          setStatus(data ? 'ready' : 'error');
        }
      })
      .catch(() => {
        if (!aborted) setStatus('error');
      });
    return () => {
      aborted = true;
    };
  }, []);

  // 按平台去重，每个平台取第一个 asset。
  const assetsByPlatform = (release?.assets ?? []).reduce<Record<Platform, ReleaseAsset | undefined>>(
    (acc, asset) => {
      const p = asset.platform as Platform;
      if (!acc[p] && p in PLATFORM_META) acc[p] = asset;
      return acc;
    },
    {} as Record<Platform, ReleaseAsset | undefined>,
  );

  const platforms = Object.keys(PLATFORM_META) as Platform[];

  return (
    <div className="landing-scope lf-noise">
      <div className="lf-grid-bg" />
      <div className="lf-glow" />
      <div className="lf-content">
        {/* 顶栏 */}
        <header className="lf-page-topbar">
          <button onClick={onBack} className="lf-back-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            返回首页
          </button>
          <div className="flex items-center gap-2">
            <span
              className="lf-mono inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-bold"
              style={{ borderColor: 'var(--lf-accent)', color: 'var(--lf-accent)' }}
            >
              L
            </span>
            <span className="text-sm font-semibold tracking-tight">LingFang</span>
          </div>
        </header>

        {/* 内容 */}
        <div className="lf-changelog-wrap">
          <div className="lf-changelog-inner">
            <div>
              <span className="lf-section-label">download</span>
              <h1 className="mt-3 text-4xl sm:text-5xl font-bold tracking-tight">获取 LingFang</h1>
              <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
                最新稳定版的各平台安装包。点击对应平台下载，客户端支持后续自动更新检查。
              </p>
            </div>

            <div className="mt-10">
              <div className="lf-card p-7 sm:p-9">
                {/* 版本信息头 */}
                <div
                  className="flex flex-wrap items-end justify-between gap-4 border-b pb-5"
                  style={{ borderColor: 'var(--lf-border)' }}
                >
                  <div>
                    <div className="lf-mono text-xs uppercase tracking-wider" style={{ color: 'var(--lf-accent)' }}>
                      stable channel
                    </div>
                    {status === 'ready' && release ? (
                      <>
                        <div className="mt-1 flex items-baseline gap-3">
                          <span className="lf-mono text-3xl font-bold">v{release.version}</span>
                          {release.title && <span style={{ color: 'var(--lf-fg-muted)' }}>{release.title}</span>}
                        </div>
                        {release.publishedAt && (
                          <div className="lf-mono mt-1 text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                            发布于 {new Date(release.publishedAt).toISOString().slice(0, 10)}
                          </div>
                        )}
                      </>
                    ) : status === 'loading' ? (
                      <div className="mt-2 h-8 w-32 animate-pulse rounded" style={{ backgroundColor: 'var(--lf-bg-hover)' }} />
                    ) : (
                      <div className="mt-1">
                        <span className="lf-mono text-2xl" style={{ color: 'var(--lf-fg-muted)' }}>
                          暂无可用版本
                        </span>
                        <p className="mt-1 text-sm" style={{ color: 'var(--lf-fg-subtle)' }}>
                          后端 /api/releases 暂未返回数据，请确认 collab-api 已启动并 seed 版本。
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* 平台下载卡片 */}
                <div className="mt-6 grid gap-4 sm:grid-cols-3">
                  {platforms.map((platform) => {
                    const asset = assetsByPlatform[platform];
                    const meta = PLATFORM_META[platform];
                    const available = status === 'ready' && !!asset;
                    return (
                      <a
                        key={platform}
                        href={available ? asset!.url : undefined}
                        target={available ? '_blank' : undefined}
                        rel={available ? 'noopener noreferrer' : undefined}
                        aria-disabled={!available}
                        className={`group relative flex flex-col rounded-lg border p-5 transition-all ${
                          available
                            ? 'hover:border-[var(--lf-accent)] hover:bg-[var(--lf-bg-hover)] cursor-pointer'
                            : 'opacity-60 cursor-not-allowed'
                        }`}
                        style={{
                          borderColor: available ? 'var(--lf-border-bright)' : 'var(--lf-border)',
                          backgroundColor: 'var(--lf-bg-elevated)',
                        }}
                      >
                        <div className="flex items-center justify-between" style={{ color: 'var(--lf-fg-muted)' }}>
                          <PlatformIcon platform={platform} />
                          {available && (
                            <svg
                              className="transition-all group-hover:text-[var(--lf-accent)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                              style={{ color: 'var(--lf-fg-subtle)' }}
                              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                            >
                              <path d="M7 17L17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                        <div className="mt-3 font-semibold">{meta.label}</div>
                        <div className="lf-mono mt-0.5 text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                          {meta.arch} · {meta.ext}
                        </div>
                        {available && asset!.sizeBytes ? (
                          <div className="lf-mono mt-3 text-xs" style={{ color: 'var(--lf-accent)' }}>
                            {formatSize(asset!.sizeBytes)}
                          </div>
                        ) : available ? (
                          <div className="lf-mono mt-3 text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>—</div>
                        ) : (
                          <div className="lf-mono mt-3 text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                            {status === 'loading' ? '加载中…' : '即将推出'}
                          </div>
                        )}
                      </a>
                    );
                  })}
                </div>

                {status === 'ready' && release && (
                  <p className="lf-mono mt-5 text-xs leading-relaxed" style={{ color: 'var(--lf-fg-subtle)' }}>
                    # 所有产物均提供签名校验，客户端可离线验签后安装。
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
