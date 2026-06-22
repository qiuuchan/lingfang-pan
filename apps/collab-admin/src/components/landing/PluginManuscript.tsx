// 落地页核心签名组件：「Plugin Manuscript」
//
// 把「一句话生成插件」的过程具象成一份正在书写的文稿：
//  1. 自然语言需求逐字出现在稿纸顶部
//  2. AI 思考中（模拟）
//  3. 插件清单（manifest + files + capabilities）逐项浮现
//  4. 最后落下一枚朱砂印章，表示「已发布」
//
// 设计意图：让访问者一眼理解 LingFang 的核心转换——自然语言 → 结构化插件。

import { useEffect, useState } from 'react';

const PROMPT_TEXT = '帮我做一个团队周报汇总插件，读取各成员待办，用 LLM 生成结构化周报。';
const MANIFEST_LINES = [
  { prefix: 'name:', value: 'weekly-report' },
  { prefix: 'runtime:', value: 'nodejs' },
  { prefix: 'capabilities:', value: '[read-todos, llm-summarize]' },
  { prefix: 'files:', value: 'index.ts, manifest.json' },
];

export function PluginManuscript() {
  const [phase, setPhase] = useState<'prompt' | 'thinking' | 'manifest' | 'seal'>('prompt');
  const [typed, setTyped] = useState('');
  const [manifestIndex, setManifestIndex] = useState(-1);
  const [sealVisible, setSealVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // phase 1: 逐字输入需求
      for (let i = 0; i <= PROMPT_TEXT.length; i++) {
        if (cancelled) return;
        setTyped(PROMPT_TEXT.slice(0, i));
        await wait(45);
      }

      // phase 2: 思考中
      setPhase('thinking');
      await wait(900);

      // phase 3: 清单逐项浮现
      setPhase('manifest');
      for (let i = 0; i < MANIFEST_LINES.length; i++) {
        if (cancelled) return;
        setManifestIndex(i);
        await wait(350);
      }
      await wait(400);

      // phase 4: 盖章
      setPhase('seal');
      setSealVisible(true);
    }

    // 组件挂载后稍等再开始，避免与 Hero 入场动画抢注意力
    const timer = setTimeout(() => {
      run();
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="lf-card lf-manuscript relative overflow-hidden bg-[var(--lf-bg-elevated)]">
      {/* 稿纸顶栏 */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b"
        style={{ borderColor: 'var(--lf-border)' }}
      >
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: 'var(--lf-fg-subtle)' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: 'var(--lf-border-bright)' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: 'var(--lf-border)' }} />
        </div>
        <span className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
          plugin.manuscript
        </span>
      </div>

      <div className="p-6 sm:p-7">
        {/* 自然语言输入区 */}
        <div className="space-y-3">
          <span className="lf-section-label" style={{ fontSize: '0.7rem' }}>request</span>
          <div className="min-h-[3.5rem] text-base sm:text-lg leading-relaxed" style={{ color: 'var(--lf-fg)' }}>
            {typed}
            {phase === 'prompt' && <span className="lf-animate-blink" style={{ color: 'var(--lf-accent)' }}>▌</span>}
          </div>
        </div>

        {/* 思考中提示 */}
        {phase !== 'prompt' && (
          <div className="mt-5 flex items-center gap-2 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
            <span className="relative flex h-2 w-2">
              <span
                className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
                style={{ backgroundColor: 'var(--lf-accent)' }}
              />
              <span
                className="relative inline-flex h-full w-2 rounded-full"
                style={{ backgroundColor: 'var(--lf-accent)' }}
              />
            </span>
            <span className="lf-mono">LingFang Agent 正在解析需求…</span>
          </div>
        )}

        {/* 生成的清单 */}
        {phase === 'manifest' || phase === 'seal' ? (
          <div className="mt-6 rounded-xl border p-4 lf-mono text-sm" style={{ borderColor: 'var(--lf-border)', backgroundColor: 'var(--lf-bg-card)' }}>
            <div className="space-y-2.5">
              {MANIFEST_LINES.map((line, index) => (
                <div
                  key={line.prefix}
                  className="flex items-baseline gap-2"
                  style={{
                    opacity: index <= manifestIndex ? 1 : 0,
                    transform: index <= manifestIndex ? 'translateY(0)' : 'translateY(4px)',
                    transition: 'opacity 0.35s ease, transform 0.35s ease',
                    transitionDelay: `${index * 60}ms`,
                  }}
                >
                  <span style={{ color: 'var(--lf-fg-subtle)', minWidth: '6.5rem' }}>{line.prefix}</span>
                  <span style={{ color: index === 0 ? 'var(--lf-accent)' : 'var(--lf-fg)' }}>{line.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 朱砂印章 */}
        {sealVisible && (
          <div className="lf-seal-stamp absolute right-6 bottom-6 sm:right-8 sm:bottom-8 flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-lg border-2"
            style={{
              borderColor: 'var(--lf-accent)',
              color: 'var(--lf-accent)',
              backgroundColor: 'rgba(199, 62, 29, 0.06)',
            }}
          >
            <div className="text-center leading-none">
              <div className="text-[10px] sm:text-xs lf-mono opacity-80">PUBLISHED</div>
              <div className="mt-1 text-lg sm:text-xl font-bold">印</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
