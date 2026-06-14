// 落地页功能区：三大核心能力卡片（对齐 README）。
const FEATURES = [
  {
    id: 'generate',
    title: 'AI 插件生成',
    tag: 'generate',
    description:
      '自然语言描述需求，AI 流式生成可运行插件。对话式迭代修改，沙箱即时预览，一键发布到市场。',
    points: ['SSE 流式生成，实时展示推理过程', '对话式迭代已生成的插件', '沙箱即时预览，所见即所得'],
    icon: 'spark',
  },
  {
    id: 'market',
    title: '市场与经济',
    tag: 'marketplace',
    description:
      '搜索 / 评分 / 安装插件，钱包余额体系，付费插件购买结算。内置文件管理器、系统信息、待办事项三个插件。',
    points: ['钱包余额与单事务结算', '评分与安装统计', '付费插件购买流程'],
    icon: 'store',
  },
  {
    id: 'collab',
    title: '多租户协作',
    tag: 'collab',
    description:
      '团队管理（管理员 / 成员角色），团队管理员申请审批流程，团队共享余额及流水记录。',
    points: ['RBAC 角色权限', '团队管理员审批', '共享余额与流水'],
    icon: 'team',
  },
] as const;

const ICONS: Record<string, string> = {
  spark:
    '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" stroke-linejoin="round"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" stroke-linejoin="round"/>',
  store:
    '<path d="M4 7h16l-1 3H5L4 7z" stroke-linejoin="round"/><path d="M5 10v9h14v-9" stroke-linecap="round"/><path d="M9 14h6" stroke-linecap="round"/>',
  team:
    '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="11" r="2.5"/><path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" stroke-linecap="round"/><path d="M15 19c0-2 1.5-3.5 3.5-3.5S22 17 22 19" stroke-linecap="round"/>',
};

export function LandingFeatures() {
  return (
    <section className="py-24 sm:py-32" id="lf-features" style={{ scrollMarginTop: '4rem' }}>
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <span className="lf-section-label">capabilities</span>
          <h2 className="mt-3 text-4xl sm:text-5xl font-bold tracking-tight">一套平台，三重能力</h2>
          <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
            从一句话需求到上线市场，再到团队协作分发 —— LingFang 把插件生命周期的每一环都串了起来。
          </p>
        </div>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {FEATURES.map((feature) => (
            <article key={feature.id} className="lf-card p-6 flex flex-col group">
              <div className="flex items-center justify-between">
                <div
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg border transition-colors group-hover:border-[var(--lf-accent)] group-hover:shadow-[0_0_20px_-6px_var(--lf-accent-glow)]"
                  style={{
                    borderColor: 'var(--lf-border-bright)',
                    backgroundColor: 'var(--lf-bg-elevated)',
                    color: 'var(--lf-accent)',
                  }}
                >
                  <svg
                    width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                    dangerouslySetInnerHTML={{ __html: ICONS[feature.icon] }}
                  />
                </div>
                <span className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
                  {feature.tag}
                </span>
              </div>

              <h3 className="mt-5 text-xl font-semibold tracking-tight">{feature.title}</h3>
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
