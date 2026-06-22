// 落地页产品流程区：从自然语言到可用插件的三步工作流。
// 用清晰的顺序（而非装饰性编号）说明用户如何完成一次插件创建。

import { MessageSquare, Cpu, Rocket } from 'lucide-react';

const STEPS = [
  {
    id: 'describe',
    label: '描述需求',
    description: '用日常语言告诉 AI 你想要什么："帮我做一个团队周报汇总插件"，就像和同事交代任务一样简单。',
    Icon: MessageSquare,
  },
  {
    id: 'generate',
    label: 'AI 生成',
    description: 'LingFang Agent 自动解析意图，生成插件清单、代码与能力声明，并在沙箱中运行验证。',
    Icon: Cpu,
  },
  {
    id: 'publish',
    label: '发布使用',
    description: '通过平台审核后插件即可上架市场，团队成员一键安装，把你的经验变成组织的标准能力。',
    Icon: Rocket,
  },
] as const;

export function LandingWorkflow() {
  return (
    <section
      id="lf-workflow"
      className="py-20 sm:py-28"
      style={{
        borderTop: '1px solid var(--lf-border)',
        scrollMarginTop: '4rem',
      }}
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <span className="lf-section-label">workflow</span>
          <h2 className="lf-display mt-3 text-4xl sm:text-5xl font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>
            三步，把一句话变成能力
          </h2>
          <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
            不需要写代码，也不需要写需求文档。描述、生成、发布，业务人员也能独立完成。
          </p>
        </div>

        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.id}>
              <div className="lf-card p-6 h-full">
                <div className="flex items-start gap-4">
                  <div
                    className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                    style={{ backgroundColor: 'rgba(199, 62, 29, 0.08)', color: 'var(--lf-accent)' }}
                  >
                    <step.Icon size={24} strokeWidth={1.6} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                        step {index + 1}
                      </span>
                    </div>
                    <h3 className="lf-display mt-1 text-lg font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>
                      {step.label}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--lf-fg-muted)' }}>
                      {step.description}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
