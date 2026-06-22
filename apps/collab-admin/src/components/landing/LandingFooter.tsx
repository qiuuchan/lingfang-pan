// 落地页页脚：纸稿主题下的极简页脚。
// 无 GitHub / 外部仓库链接；文档等未提供入口以禁用占位展示。

import { useEffect, useState } from 'react';
import { getLatestRelease } from '@/lib/releases';

/** 列定义：标题 + 项列表。 */
type FooterItem =
  | { kind: 'anchor'; label: string; href: string }
  | { kind: 'button'; label: string; onClick: () => void }
  | { kind: 'disabled'; label: string };

function FooterLink({ item }: { item: FooterItem }) {
  const baseCls = 'text-sm transition-colors';
  const hoverCls = 'hover:text-[var(--lf-fg)]';
  if (item.kind === 'anchor') {
    return (
      <a
        href={item.href}
        className={`${baseCls} ${hoverCls}`}
        style={{ color: 'var(--lf-fg-muted)' }}
      >
        {item.label}
      </a>
    );
  }
  if (item.kind === 'button') {
    return (
      <button
        onClick={item.onClick}
        className={`${baseCls} ${hoverCls} justify-self-start text-left`}
        style={{ color: 'var(--lf-fg-muted)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        {item.label}
      </button>
    );
  }
  return (
    <span
      aria-disabled="true"
      className={`${baseCls} cursor-not-allowed`}
      style={{ color: 'var(--lf-fg-subtle)', opacity: 0.6 }}
    >
      {item.label}
    </span>
  );
}

function FooterCol({ title, items }: { title: string; items: FooterItem[] }) {
  return (
    <div className="space-y-3">
      <span className="lf-section-label" style={{ fontSize: '0.75rem' }}>{title}</span>
      <div className="space-y-2">
        {items.map((item) => (
          <FooterLink key={item.label} item={item} />
        ))}
      </div>
    </div>
  );
}

export function LandingFooter({
  onNavigateDownload,
  onNavigateChangelog,
}: {
  onNavigateDownload: () => void;
  onNavigateChangelog: () => void;
}) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    getLatestRelease().then((r) => {
      if (!aborted) setVersion(r?.version ?? null);
    });
    return () => { aborted = true; };
  }, []);

  const year = 2026;

  return (
    <footer className="relative" style={{ borderTop: '1px solid var(--lf-border)' }}>
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          {/* 品牌列 */}
          <div className="max-w-sm">
            <div className="flex items-center gap-2.5">
              <span
                className="lf-display inline-flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-bold"
                style={{ borderColor: 'var(--lf-accent)', color: 'var(--lf-accent)' }}
              >
                灵
              </span>
              <span className="lf-display font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>LingFang</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--lf-fg-muted)' }}>
              用自然语言生成插件。可自托管，契约先行。
            </p>
            {version && (
              <div className="mt-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
                style={{ borderColor: 'var(--lf-border-bright)', backgroundColor: 'var(--lf-bg-card)' }}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span
                    className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
                    style={{ backgroundColor: 'var(--lf-accent)' }}
                  />
                  <span
                    className="relative inline-flex h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: 'var(--lf-accent)' }}
                  />
                </span>
                <span style={{ color: 'var(--lf-fg-muted)' }}>当前版本</span>
                <span className="lf-mono font-medium" style={{ color: 'var(--lf-accent)' }}>v{version}</span>
              </div>
            )}
          </div>

          <FooterCol
            title="产品"
            items={[
              { kind: 'anchor', label: '功能', href: '#lf-features' },
              { kind: 'button', label: '下载', onClick: onNavigateDownload },
              { kind: 'button', label: '更新日志', onClick: onNavigateChangelog },
            ]}
          />

          <FooterCol
            title="资源"
            items={[
              { kind: 'disabled', label: '使用文档' },
              { kind: 'disabled', label: '插件开发' },
              { kind: 'disabled', label: 'API 参考' },
            ]}
          />

          <FooterCol
            title="关于"
            items={[
              { kind: 'disabled', label: '技术栈' },
              { kind: 'disabled', label: 'License' },
              { kind: 'disabled', label: '联系维护者' },
            ]}
          />
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
