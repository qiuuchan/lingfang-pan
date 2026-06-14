// 独立全屏更新日志页。
// 从 /api/releases 取版本列表，渲染时间线（notes markdown 极简渲染：## / - / > / **bold** / `code`）。
// 顶栏：返回首页 + logo。窄列居中内容。
import { useEffect, useState, type ReactNode } from 'react';
import { listReleases, formatDate, type Release } from '@/lib/releases';

function renderNotes(md: string): ReactNode[] {
  const lines = md.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    const trimmed = line.trim();
    const inline = (text: string): ReactNode => {
      const parts: ReactNode[] = [];
      const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      let key = 0;
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
        const token = match[0];
        if (token.startsWith('**')) {
          parts.push(
            <strong key={key++} className="font-semibold" style={{ color: 'var(--lf-fg)' }}>
              {token.slice(2, -2)}
            </strong>,
          );
        } else {
          parts.push(
            <code
              key={key++}
              className="lf-mono rounded px-1.5 py-0.5 text-[0.85em]"
              style={{ backgroundColor: 'var(--lf-bg-elevated)', color: 'var(--lf-accent)' }}
            >
              {token.slice(1, -1)}
            </code>,
          );
        }
        lastIndex = match.index + token.length;
      }
      if (lastIndex < text.length) parts.push(text.slice(lastIndex));
      return parts;
    };

    if (trimmed.startsWith('## ')) {
      return (
        <h4 key={i} className="lf-mono text-base font-semibold mt-2" style={{ color: 'var(--lf-fg)' }}>
          {inline(trimmed.slice(3))}
        </h4>
      );
    }
    if (trimmed.startsWith('- ')) {
      return (
        <div key={i} className="flex gap-2 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
          <span style={{ color: 'var(--lf-accent)' }}>›</span>
          <span>{inline(trimmed.slice(2))}</span>
        </div>
      );
    }
    if (trimmed.startsWith('> ')) {
      return (
        <blockquote
          key={i}
          className="border-l-2 pl-3 text-xs italic"
          style={{ borderColor: 'var(--lf-border-bright)', color: 'var(--lf-fg-subtle)' }}
        >
          {inline(trimmed.slice(2))}
        </blockquote>
      );
    }
    return (
      <p key={i} className="text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
        {inline(trimmed)}
      </p>
    );
  });
}

export function ChangelogPage({ onBack }: { onBack: () => void }) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    listReleases('STABLE', 20)
      .then((r) => {
        setReleases(r);
        if (r.length > 0) setExpanded(r[0].id);
      })
      .catch(() => setReleases([]))
      .finally(() => setLoading(false));
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
              {loading ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-16 animate-pulse rounded-lg" style={{ backgroundColor: 'var(--lf-bg-card)' }} />
                  ))}
                </div>
              ) : releases.length === 0 ? (
                <div className="lf-card p-8 text-center">
                  <div className="lf-mono text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
                    // 暂无已发布版本
                  </div>
                  <p className="mt-2 text-sm" style={{ color: 'var(--lf-fg-subtle)' }}>
                    版本发布后此处自动展示时间线。
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
                              <div className="space-y-1.5">{renderNotes(release.notes)}</div>
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
