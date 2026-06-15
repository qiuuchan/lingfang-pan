// 落地页页脚（无 GitHub / 外部仓库链接，Gitee 是私有仓库不放公开社交入口）。
// 多列结构：品牌列（logo + slogan + 版本徽标）+ 产品列 + 资源列 + 关于列。
// 版本徽标从 /api/releases/latest 取（降级：无版本时隐藏），复用 Hero 的 ping 点 + 版本号模式。
// 禁用项（文档/协议占位）用 aria-disabled + opacity + cursor-not-allowed，非可点死链。
import { useEffect, useState } from 'react';
import { getLatestRelease } from '@/lib/releases';

/** 列定义：标题 + 项列表。项分三类——锚点链接、回调按钮、禁用占位。 */
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
        className={`${baseCls} ${hoverCls} justify-self-start`}
        style={{ color: 'var(--lf-fg-muted)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        {item.label}
      </button>
    );
  }
  // 禁用占位（文档/协议等尚未提供的入口，用 aria-disabled 不可点，非死链）。
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
      <span className="lf-section-label">{title}</span>
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

  // 版本徽标：从 /api/releases/latest 取（与 Hero 同源）。组件卸载后不 setState（aborted 标志）。
  useEffect(() => {
    let aborted = false;
    getLatestRelease().then((r) => {
      if (!aborted) setVersion(r?.version ?? null);
    });
    return () => { aborted = true; };
  }, []);

  // 年份用构建期常量：避免 SSR/CSR 时间漂移。这里取固定 2026（项目起始年）。
  const year = 2026;

  return (
    <footer className="relative">
      {/* 顶部渐变分隔（非硬 border，与上方 section 视觉衔接） */}
      <div
        style={{
          height: 1,
          background: 'linear-gradient(to right, transparent, var(--lf-border-bright), transparent)',
        }}
      />
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          {/* 品牌列 */}
          <div className="max-w-sm">
            <div className="flex items-center gap-2.5">
              <span
                className="lf-mono inline-flex h-8 w-8 items-center justify-center rounded-md border text-sm font-bold"
                style={{ borderColor: 'var(--lf-accent)', color: 'var(--lf-accent)' }}
              >
                L
              </span>
              <span className="font-semibold tracking-tight">LingFang</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--lf-fg-muted)' }}>
              用自然语言生成插件。可自托管，契约先行。
            </p>
            {/* 版本徽标（复用 Hero ping 点 + 版本号模式，无版本时隐藏） */}
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

          {/* 产品列 */}
          <FooterCol
            title="产品"
            items={[
              { kind: 'anchor', label: '功能', href: '#lf-features' },
              { kind: 'button', label: '下载', onClick: onNavigateDownload },
              { kind: 'button', label: '更新日志', onClick: onNavigateChangelog },
            ]}
          />

          {/* 资源列（文档尚未提供，禁用占位） */}
          <FooterCol
            title="资源"
            items={[
              { kind: 'disabled', label: '使用文档' },
              { kind: 'disabled', label: '插件开发' },
              { kind: 'disabled', label: 'API 参考' },
            ]}
          />

          {/* 关于列 */}
          <FooterCol
            title="关于"
            items={[
              { kind: 'disabled', label: '技术栈' },
              { kind: 'disabled', label: 'License' },
              { kind: 'disabled', label: '联系维护者' },
            ]}
          />
        </div>

        {/* 底部版权条 */}
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
