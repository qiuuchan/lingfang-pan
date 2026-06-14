// 落地页 Hero：产品定位大标题 + 终端式代码块 + 双 CTA（登录管理端 / 去下载页）。
// 版本徽标从 /api/releases/latest 取（降级：无版本时隐藏）；点击徽标跳转到独立更新日志页。
import { useEffect, useState } from 'react';
import { getLatestRelease } from '@/lib/releases';

interface HeroProps {
  onLogin: () => void;
  onNavigateDownload: () => void;
  onNavigateChangelog: () => void;
}

export function LandingHero({ onLogin, onNavigateDownload, onNavigateChangelog }: HeroProps) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getLatestRelease().then((r) => setVersion(r?.version ?? null));
  }, []);

  return (
    <section className="relative pt-32 pb-24 sm:pt-40 sm:pb-32 overflow-hidden" id="lf-top">
      <div className="mx-auto max-w-6xl px-6">
        {/* 版本徽标 */}
        <div className="lf-animate-rise flex justify-center mb-8" style={{ animationDelay: '0ms' }}>
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

        {/* 主标题 */}
        <h1
          className="lf-animate-rise text-center text-5xl sm:text-7xl font-bold tracking-tight leading-[1.05]"
          style={{ animationDelay: '80ms' }}
        >
          用自然语言，
          <br />
          <span className="lf-text-gradient">生成可运行的插件</span>
        </h1>

        {/* 副标题 */}
        <p
          className="lf-animate-rise mx-auto mt-7 max-w-2xl text-center text-lg sm:text-xl leading-relaxed"
          style={{ animationDelay: '160ms', color: 'var(--lf-fg-muted)' }}
        >
          用 AI 无代码生成插件 —— 自然语言描述需求，AI 流式生成可运行插件，独立环境即时预览，发布到市场。
        </p>

        {/* CTA */}
        <div className="lf-animate-rise mt-10 flex flex-wrap justify-center gap-3" style={{ animationDelay: '240ms' }}>
          <button onClick={onLogin} className="lf-btn-primary text-base">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            登录管理端
          </button>
          <button onClick={onNavigateDownload} className="lf-btn-secondary text-base">
            下载客户端
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* 终端式代码块 */}
        <div className="lf-animate-rise mx-auto mt-16 max-w-2xl" style={{ animationDelay: '320ms' }}>
          <div className="lf-card overflow-hidden shadow-2xl shadow-black/40">
            <div
              className="flex items-center gap-2 px-4 py-3 border-b"
              style={{ borderColor: 'var(--lf-border)', backgroundColor: 'var(--lf-bg-elevated)' }}
            >
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="lf-mono ml-2 text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                lingfang — bash
              </span>
            </div>
            <div className="lf-mono p-5 text-sm leading-relaxed">
              <div>
                <span style={{ color: 'var(--lf-fg-subtle)' }}>$</span>{' '}
                <span style={{ color: 'var(--lf-cyan)' }}>lingfang</span>{' '}
                <span style={{ color: 'var(--lf-accent)' }}>generate</span>
              </div>
              <div className="mt-2" style={{ color: 'var(--lf-fg-muted)' }}>▸ 描述你想要的插件：</div>
              <div style={{ color: 'var(--lf-fg)' }}>  一个团队周报汇总插件，读取各成员</div>
              <div style={{ color: 'var(--lf-fg)' }}>  待办，用 LLM 生成结构化周报</div>
              <div className="mt-3" style={{ color: 'var(--lf-fg-muted)' }}>
                ▸ 生成中<span style={{ color: 'var(--lf-accent)' }}>▌</span>
              </div>
              <div className="mt-2" style={{ color: 'var(--lf-fg-muted)' }}>
                <span style={{ color: 'var(--lf-accent)' }}>✓</span> 解析需求{' '}
                <span className="lf-animate-blink">▌</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
