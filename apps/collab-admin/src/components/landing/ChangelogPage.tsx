// 独立全屏更新日志页。
// 从 /api/changelog（Gitee release 标准化）取版本列表，渲染时间线。
// notes markdown 渲染用 lib/markdown.tsx 的共享 renderMarkdown（与下载页 release notes 同源）。
// 顶栏：返回首页 + logo。窄列居中内容。降级（degraded=true）时顶部显示橙色横幅但不阻断时间线。
import { useEffect, useState } from 'react';
import { listChangelog, formatDate, type ChangelogEntry } from '@/lib/releases';
import { renderMarkdown } from '@/lib/markdown';

type Status = 'loading' | 'ready';

export function ChangelogPage({ onBack }: { onBack: () => void }) {
  const [releases, setReleases] = useState<ChangelogEntry[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [degradedMessage, setDegradedMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    listChangelog()
      .then((resp) => {
        if (aborted) return;
        setReleases(resp.releases);
        setDegraded(resp.degraded);
        setDegradedMessage(resp.degraded ? (resp.message ?? null) : null);
        if (resp.releases.length > 0) setExpanded(resp.releases[0].id);
      })
      .catch(() => {
        // 网络层兜底（listChangelog 内部已 catch，此处双保险）。
        if (!aborted) setReleases([]);
      })
      .finally(() => {
        if (!aborted) setStatus('ready');
      });
    return () => {
      aborted = true;
    };
  }, []);

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
              <span className="lf-section-label">changelog</span>
              <h1 className="mt-3 text-4xl sm:text-5xl font-bold tracking-tight">更新日志</h1>
              <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
                每一次发布都记录在案。点击展开查看版本的完整变更说明。
              </p>
            </div>

            <div className="mt-10">
              {/* 降级横幅：degraded=true 时显示，不阻断时间线渲染（若有缓存 releases 仍展示）。 */}
              {status === 'ready' && degraded && degradedMessage && (
                <div
                  className="mb-4 flex items-start gap-2.5 rounded-lg border p-3 text-sm"
                  style={{
                    borderColor: 'rgba(245, 158, 11, 0.4)',
                    backgroundColor: 'rgba(245, 158, 11, 0.08)',
                    color: 'var(--lf-fg-muted)',
                  }}
                >
                  <svg
                    className="mt-0.5 shrink-0"
                    style={{ color: '#f59e0b' }}
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  >
                    <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{degradedMessage}</span>
                </div>
              )}

              {status === 'loading' ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-16 animate-pulse rounded-lg" style={{ backgroundColor: 'var(--lf-bg-card)' }} />
                  ))}
                </div>
              ) : releases.length === 0 ? (
                <div className="lf-card p-8 text-center">
                  <div className="lf-mono text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
                    // 暂无更新日志
                  </div>
                  <p className="mt-2 text-sm" style={{ color: 'var(--lf-fg-subtle)' }}>
                    管理端配置 Gitee 更新日志源后，此处自动展示版本时间线。
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {releases.map((release) => {
                    const isOpen = expanded === release.id;
                    const hasNotes = release.notes && release.notes.trim().length > 0;
                    return (
                      <article
                        key={release.id}
                        className="lf-card overflow-hidden"
                        style={isOpen ? { borderColor: 'var(--lf-border-bright)' } : undefined}
                      >
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : release.id)}
                          className="flex w-full items-center gap-4 px-5 py-4 text-left"
                          aria-expanded={isOpen}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                        >
                          <span
                            className="lf-mono inline-flex shrink-0 items-center rounded-md border px-2.5 py-1 text-sm font-medium"
                            style={
                              release.isLatest
                                ? { borderColor: 'var(--lf-accent)', color: 'var(--lf-accent)' }
                                : { borderColor: 'var(--lf-border-bright)', color: 'var(--lf-fg-muted)' }
                            }
                          >
                            v{release.version}
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              {release.title && <span className="truncate text-sm font-medium">{release.title}</span>}
                              {release.isLatest && (
                                <span
                                  className="lf-mono rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                                  style={{ backgroundColor: 'rgba(59,130,246,0.12)', color: 'var(--lf-accent)' }}
                                >
                                  latest
                                </span>
                              )}
                            </div>
                            {release.publishedAt && (
                              <div className="lf-mono mt-0.5 text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                                {formatDate(release.publishedAt)}
                              </div>
                            )}
                          </div>

                          <svg
                            className="shrink-0 transition-transform"
                            style={{ color: 'var(--lf-fg-subtle)', transform: isOpen ? 'rotate(90deg)' : 'none' }}
                            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                          >
                            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>

                        {isOpen && (
                          <div className="border-t px-5 py-4" style={{ borderColor: 'var(--lf-border)' }}>
                            {hasNotes ? (
                              <div className="space-y-1.5">{renderMarkdown(release.notes)}</div>
                            ) : (
                              <div className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                                // 本版本无更新说明
                              </div>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
