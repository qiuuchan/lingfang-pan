// 落地页功能区：四大核心能力卡片。
// 从生成、市场、协作到治理，覆盖企业引入 AI 插件的完整链路。

import { Sparkles, Store, Users, ShieldCheck } from 'lucide-react';

const FEATURES = [
  {
    id: 'generate',
    title: 'AI 插件生成',
    tag: 'generate',
    description:
      '业务人员用自然语言描述需求，AI 自动生成功能完整的可运行插件。流式输出、对话式迭代、即时预览，让创意快速落地。',
    points: ['自然语言驱动，零代码门槛', '多轮对话迭代已生成插件', '内置沙箱即时预览运行效果'],
    Icon: Sparkles,
  },
  {
    id: 'market',
    title: '插件市场',
    tag: 'marketplace',
    description:
      '团队沉淀的插件可上架内部市场，按使用场景检索、评分与复用。支持付费结算与余额管理，让优质能力流动起来。',
    points: ['内部市场搜索、评分、安装', '钱包余额与付费插件结算', '内置实用插件开箱即用'],
    Icon: Store,
  },
  {
    id: 'collab',
    title: '团队协作',
    tag: 'teams',
    description:
      '按团队组织成员与插件权限，支持团队管理员审批、共享余额与明细记录。让插件从个人工具升级为组织能力。',
    points: ['多团队隔离与成员管理', '团队管理员申请与审批', '共享余额与流水明细'],
    Icon: Users,
  },
  {
    id: 'governance',
    title: '安全与治理',
    tag: 'governance',
    description:
      '平台级角色权限、插件审核流程与操作审计，确保 AI 生成的能力在企业内部安全可控地发布与使用。',
    points: ['RBAC 角色权限控制', '插件提交与平台审核', '全量操作审计日志'],
    Icon: ShieldCheck,
  },
] as const;

export function LandingFeatures() {
  return (
    <section className="py-24 sm:py-32" id="lf-features" style={{ scrollMarginTop: '4rem' }}>
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <span className="lf-section-label">capabilities</span>
          <h2 className="lf-display mt-3 text-4xl sm:text-5xl font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>
            从想法到能力，只需一套平台
          </h2>
          <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
            LingFang 把插件的生成、分发、协作与治理串成完整闭环，让团队里的每个人都能参与构建企业专属 AI 能力。
          </p>
        </div>

        <div className="mt-14 grid gap-5 md:grid-cols-2">
          {FEATURES.map((feature) => (
            <article key={feature.id} className="lf-card p-6 flex flex-col group">
              <div className="flex items-center justify-between">
                <div
                  className="inline-flex h-11 w-11 items-center justify-center rounded-xl border transition-colors group-hover:border-[var(--lf-accent)]"
                  style={{
                    borderColor: 'var(--lf-border-bright)',
                    backgroundColor: 'var(--lf-bg-elevated)',
                    color: 'var(--lf-accent)',
                  }}
                >
                  <feature.Icon size={22} strokeWidth={1.6} />
                </div>
                <span className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                  {feature.tag}
                </span>
              </div>

              <h3 className="lf-display mt-5 text-xl font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed flex-1" style={{ color: 'var(--lf-fg-muted)' }}>
                {feature.description}
              </p>

              <ul className="mt-5 space-y-2 border-t pt-5" style={{ borderColor: 'var(--lf-border)' }}>
                {feature.points.map((point) => (
                  <li key={point} className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
                    <svg
                      className="mt-0.5 shrink-0"
                      style={{ color: 'var(--lf-accent)' }}
                      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    >
                      <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {point}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
