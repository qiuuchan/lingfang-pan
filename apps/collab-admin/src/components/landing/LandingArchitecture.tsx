// 落地页架构区：技术栈矩阵 + ASCII 系统拓扑。
const STACK = [
  { layer: '桌面客户端', tech: 'Tauri 2 · React', note: '原生窗口 · 自定义标题栏 · 内置插件独立环境' },
  { layer: '统一后端', tech: 'NestJS 11 · Prisma 7', note: '/api 前缀 · Swagger · PostgreSQL' },
  { layer: '管理端 / 官网', tech: 'React · shadcn/ui', note: '落地页 + 用户 · 团队 · 插件 · 审批 · 审计' },
  { layer: '共享契约', tech: 'Zod · TypeScript', note: '前后端单一事实来源' },
] as const;

export function LandingArchitecture() {
  return (
    <section
      className="py-24 sm:py-32 border-t"
      id="lf-architecture"
      style={{ scrollMarginTop: '4rem', borderTopColor: 'var(--lf-border)' }}
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <span className="lf-section-label">architecture</span>
          <h2 className="mt-3 text-4xl sm:text-5xl font-bold tracking-tight">单后端，一个平台</h2>
          <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
            契约先行，不重复造轮子。Zod schema 是所有实现的唯一事实来源，三端共享同一套后端。
          </p>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-2">
          {STACK.map((item, idx) => (
            <div key={item.layer} className="lf-card p-6 flex items-start gap-5">
              <span className="lf-mono text-sm mt-1" style={{ color: 'var(--lf-fg-subtle)' }}>
                {String(idx).padStart(2, '0')}
              </span>
              <div className="flex-1">
                <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--lf-fg-subtle)' }}>
                  {item.layer}
                </div>
                <div className="lf-mono mt-1.5 text-lg font-semibold">{item.tech}</div>
                <div className="mt-2 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
                  {item.note}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 lf-card overflow-hidden">
          <div
            className="flex items-center gap-2 px-4 py-2.5 border-b"
            style={{ borderColor: 'var(--lf-border)', backgroundColor: 'var(--lf-bg-elevated)' }}
          >
            <svg
              style={{ color: 'var(--lf-fg-subtle)' }}
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M9 3v18" />
            </svg>
            <span className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>
              system — topology
            </span>
          </div>
          <pre
            className="lf-mono overflow-x-auto p-6 text-xs leading-relaxed"
            style={{ color: 'var(--lf-fg-muted)' }}
          >
            <span style={{ color: 'var(--lf-fg-subtle)' }}>┌─────────────────────────────────────────────────────────┐</span>
            {'\n'}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>  <span style={{ color: 'var(--lf-accent)' }}>desktop</span>  Tauri 2 · React          <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>  <span style={{ color: 'var(--lf-cyan)' }}>admin</span>   React · shadcn/ui        <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>
            {'\n'}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>└──────────────┬──────────────────────────┬─────────────────┘</span>
            {'\n'}
            {'               '}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>
            {'                           '}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>
            {'\n'}
            {'               '}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>▼</span>
            {'                           '}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>▼</span>
            {'\n'}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>┌─────────────────────────────────────────────────────────┐</span>
            {'\n'}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>  <span style={{ color: 'var(--lf-accent)' }}>collab-api</span>  NestJS · /api · Swagger    <span style={{ color: 'var(--lf-fg-subtle)' }}>:3000 │</span>
            {'\n'}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>  插件生成 · LLM 代理 · 市场 · 钱包 · 多团队 · 角色权限    <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>
            {'\n'}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>└──────────────────────────────┬──────────────────────────┘</span>
            {'\n'}
            {'                               '}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>│</span>
            {'\n'}
            {'                               '}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>▼</span>
            {'\n'}
            {'                    '}
            <span style={{ color: 'var(--lf-accent)' }}>PostgreSQL</span>  <span>lingfang_collab</span>
            {'\n'}
            {'                               '}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>▲</span>
            {'\n'}
            {'                    '}
            <span style={{ color: 'var(--lf-fg-subtle)' }}>契约：</span>
            <span style={{ color: 'var(--lf-accent)' }}>packages/contract</span> <span style={{ color: 'var(--lf-fg-subtle)' }}>(Zod)</span>
          </pre>
        </div>
      </div>
    </section>
  );
}
