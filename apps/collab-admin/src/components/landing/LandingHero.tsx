// 落地页 Hero：产品官网主视觉。
// 左侧为商业定位文案 + 双 CTA，右侧为 PluginManuscript 签名演示。
// 版本徽标从 /api/releases/latest 取，无版本时隐藏；点击跳转更新日志页。

import { useEffect, useState } from 'react';
import { getLatestRelease } from '@/lib/releases';
import { PluginManuscript } from './PluginManuscript';

interface HeroProps {
  onLogin: () => void;
  onNavigateDownload: () => void;
  onNavigateChangelog: () => void;
}

export function LandingHero({ onLogin, onNavigateDownload, onNavigateChangelog }: HeroProps) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    getLatestRelease().then((r) => {
      if (!aborted) setVersion(r?.version ?? null);
    });
    return () => { aborted = true; };
  }, []);

  return (
    <section className="relative pt-32 pb-20 sm:pt-40 sm:pb-28 overflow-hidden" id="lf-top">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
          {/* 左侧文案 */}
          <div className="max-w-xl">
            {/* 版本徽标 */}
            <div className="lf-animate-rise" style={{ animationDelay: '0ms' }}>
              <button
                onClick={onNavigateChangelog}
                className="group inline-flex items-center gap-2.5 rounded-full border px-4 py-1.5 text-sm transition-colors hover:border-[var(--lf-accent)]"
                style={{ borderColor: 'var(--lf-border-bright)', backgroundColor: 'var(--lf-bg-card)', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <span className="relative flex h-2 w-2">
                  <span
                    className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
                    style={{ backgroundColor: 'var(--lf-accent)' }}
                  />
                  <span
                    className="relative inline-flex h-2 w-2 rounded-full"
                    style={{ backgroundColor: 'var(--lf-accent)' }}
                  />
                </span>
                <span style={{ color: 'var(--lf-fg-muted)' }}>最新版本</span>
                {version && (
                  <span className="lf-mono font-medium" style={{ color: 'var(--lf-accent)' }}>
                    v{version}
                  </span>
                )}
                <svg
                  className="transition-transform group-hover:translate-x-0.5"
                  style={{ color: 'var(--lf-fg-subtle)' }}
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                >
                  <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <h1
              className="lf-display lf-animate-rise mt-8 text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight leading-[1.08]"
              style={{ animationDelay: '80ms' }}
            >
              用一句话，
              <br />
              <span style={{ color: 'var(--lf-accent)' }}>造一个插件</span>
            </h1>

            <p
              className="lf-animate-rise mt-6 text-lg sm:text-xl leading-relaxed"
              style={{ animationDelay: '160ms', color: 'var(--lf-fg-muted)' }}
            >
              LingFang 让企业团队用自然语言描述需求，AI 自动生成可运行的插件。
              无需专业开发背景，把每个人的业务经验变成可复用的数字能力。
            </p>

            <div
              className="lf-animate-rise mt-9 flex flex-wrap items-center gap-3"
              style={{ animationDelay: '240ms' }}
            >
              <button onClick={onNavigateDownload} className="lf-btn-primary text-base">
                下载客户端
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button onClick={onLogin} className="lf-btn-secondary text-base">
                管理员入口
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <p
              className="lf-animate-rise mt-5 text-sm"
              style={{ animationDelay: '300ms', color: 'var(--lf-fg-subtle)' }}
            >
              支持 Windows、macOS 与 Linux，开箱即用。
            </p>
          </div>

          {/* 右侧签名组件 */}
          <div className="lf-animate-rise" style={{ animationDelay: '320ms' }}>
            <PluginManuscript />
          </div>
        </div>
      </div>
    </section>
  );
}
