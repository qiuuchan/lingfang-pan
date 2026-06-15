// 落地页拓扑区：取代旧 LandingArchitecture 的「单后端一个平台」section。
//
// 设计要点（详见子任务 design.md）：
//  - 删掉 architecture 的标题/技术栈矩阵/ASCII topology，保留「系统拓扑」可视化，重做为 SVG 三节点。
//  - 三节点：desktop / admin → collab-api → PostgreSQL；契约（Zod）作为独立横条侧标，不塞进 SVG。
//  - 流动光点用纯 CSS @keyframes lf-flow（offset-path 沿连线），不用 framer-motion repeat:Infinity
//    （主线程开销 + SVG transform 跨浏览器兼容坑）；入场用落地页既有的 lf-animate-rise stagger。
//  - 光点只动 transform/opacity，发光用静态 <radialGradient>，禁 filter:drop-shadow/blur（深色页掉帧源）。
//  - 移动端（md 以下）隐藏 SVG 换纵向卡片栈，避免 viewBox 文字挤到不可读。

// SVG 节点定义：viewBox 0 0 900 360。坐标与下方 <path> 连线、lf-flow offset-path 一致。
// 节点用圆角矩形 + 居中文字；desktop/admin 上层并排，collab-api 中层，PostgreSQL 下层。
const NODES = [
  { id: 'desktop', x: 70, y: 40, w: 300, h: 80, label: 'desktop', sub: 'Tauri 2 · React', color: 'var(--lf-accent)' },
  { id: 'admin', x: 530, y: 40, w: 300, h: 80, label: 'admin', sub: 'React · shadcn/ui', color: 'var(--lf-accent)' },
  { id: 'collab-api', x: 300, y: 160, w: 300, h: 80, label: 'collab-api', sub: 'NestJS · /api · :3000', color: 'var(--lf-accent-bright)' },
  { id: 'postgres', x: 300, y: 280, w: 300, h: 60, label: 'PostgreSQL', sub: 'lingfang_collab', color: 'var(--lf-fg)' },
] as const;

// 连线 path（贝塞尔曲线）：desktop/admin → collab-api，collab-api → postgres。
// 这些 path 的 d 值同时用于流动光点的 offset-path（lf-flow 沿 path 流动）。
// desktop(220,120) → collab-api 顶边中心(450,160)；admin(680,120) → collab-api 顶边右段。
const FLOW_PATHS = [
  'M220,120 C 220,140 450,140 450,160', // desktop → collab-api
  'M680,120 C 680,140 450,140 450,160', // admin → collab-api
];

// 移动端纵向栈节点（与 SVG 信息等价，去掉动画，省电 + 适配窄屏）。
const STACK = [
  { label: 'desktop', sub: 'Tauri 2 · React', color: 'var(--lf-accent)' },
  { label: 'admin', sub: 'React · shadcn/ui', color: 'var(--lf-accent)' },
  { label: 'collab-api', sub: 'NestJS · /api · :3000', color: 'var(--lf-accent-bright)' },
  { label: 'PostgreSQL', sub: 'lingfang_collab', color: 'var(--lf-fg)' },
] as const;

export function LandingTopology() {
  return (
    <section
      id="lf-topology"
      className="py-20 sm:py-28"
      style={{
        // 顶部渐变分隔（非硬 border），与 Hero 终端代码块视觉衔接。
        borderTop: '1px solid transparent',
        borderImage: 'linear-gradient(to right, transparent, var(--lf-border), transparent) 1',
        scrollMarginTop: '4rem',
      }}
    >
      <div className="mx-auto max-w-6xl px-6">
        {/* 区块标题：与 Hero/Features 的 lf-section-label 呼应 */}
        <div className="lf-animate-rise max-w-2xl">
          <span className="lf-section-label">system — topology</span>
          <h2 className="mt-3 text-4xl sm:text-5xl font-bold tracking-tight">三端，一套契约</h2>
          <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
            桌面端与管理端共享同一个 collab-api，落到同一份 PostgreSQL，契约由 Zod 单一来源驱动。
          </p>
        </div>

        {/* 桌面端：SVG 三节点 + 流动光点（md 以上才显示，移动端隐藏换纵向栈） */}
        <div className="lf-animate-rise hidden md:block mt-14" style={{ animationDelay: '100ms' }}>
          <div className="lf-card overflow-hidden">
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
              <span className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>system — topology</span>
            </div>

            {/* SVG：定义渐变（光点静态发光） + 节点 + 连线 + 流动光点 */}
            <svg viewBox="0 0 900 360" className="w-full h-auto" role="img" aria-label="系统拓扑：桌面端与管理端共享 collab-api 与 PostgreSQL">
              <defs>
                {/* 光点静态发光填充（不用动态 filter，避免掉帧） */}
                <radialGradient id="lf-flow-grad" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="var(--lf-accent-bright)" stopOpacity="1" />
                  <stop offset="100%" stopColor="var(--lf-accent)" stopOpacity="0" />
                </radialGradient>
              </defs>

              {/* 连线（静态 path，光点沿其流动） */}
              {FLOW_PATHS.map((d, i) => (
                <path
                  key={`line-${i}`}
                  d={d}
                  fill="none"
                  stroke="var(--lf-border-bright)"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                  opacity="0.6"
                />
              ))}
              {/* collab-api → postgres 连线（直线） */}
              <line x1="450" y1="240" x2="450" y2="280" stroke="var(--lf-border-bright)" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />

              {/* 流动光点：沿 FLOW_PATHS 流动，两段错峰。
                  offset-path 取值见 landing.css 的 .lf-flow-a / .lf-flow-b（path 必须与此处 d 完全一致）。
                  每段含发光底（静态 radialGradient）+ 实心点两个 circle，共享同一动画（仅半径/填充不同）。 */}
              {FLOW_PATHS.map((d, i) => (
                <g key={`dot-${i}`}>
                  <circle r="7" fill="url(#lf-flow-grad)" className={i === 0 ? 'lf-flow-a lf-flow-glow' : 'lf-flow-b lf-flow-glow'} />
                  <circle r="3" fill="var(--lf-accent-bright)" className={i === 0 ? 'lf-flow-a lf-flow-dot' : 'lf-flow-b lf-flow-dot'} />
                </g>
              ))}

              {/* 节点：圆角矩形 + 标签 + 副标题 */}
              {NODES.map((node) => (
                <g key={node.id}>
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.w}
                    height={node.h}
                    rx="10"
                    fill="var(--lf-bg-elevated)"
                    stroke={node.color}
                    strokeWidth="1.5"
                  />
                  <text
                    x={node.x + node.w / 2}
                    y={node.y + node.h / 2 - 4}
                    textAnchor="middle"
                    className="lf-mono"
                    fontSize="18"
                    fontWeight="600"
                    fill={node.color}
                  >
                    {node.label}
                  </text>
                  <text
                    x={node.x + node.w / 2}
                    y={node.y + node.h / 2 + 18}
                    textAnchor="middle"
                    className="lf-mono"
                    fontSize="12"
                    fill="var(--lf-fg-muted)"
                  >
                    {node.sub}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        </div>

        {/* 移动端：纵向卡片栈（无动画，省电；md:hidden） */}
        <div className="md:hidden mt-10 space-y-2">
          {STACK.map((item, i) => (
            <div key={item.label}>
              <div
                className="lf-card flex items-center justify-between p-4"
                style={{ borderColor: item.color }}
              >
                <span className="lf-mono font-semibold" style={{ color: item.color }}>{item.label}</span>
                <span className="lf-mono text-xs" style={{ color: 'var(--lf-fg-muted)' }}>{item.sub}</span>
              </div>
              {i < STACK.length - 1 && (
                <div className="flex justify-center py-1">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--lf-fg-subtle)" strokeWidth="2">
                    <path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 契约侧标：独立横条卡片，不塞进 SVG（避免 SVG 内中英文混排 + 小字号糊） */}
        <div className="lf-animate-rise mt-6 lf-card flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:gap-4" style={{ animationDelay: '200ms' }}>
          <span className="lf-section-label shrink-0">contract</span>
          <span className="lf-mono text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
            <span style={{ color: 'var(--lf-accent)' }}>packages/contract</span> · Zod · TypeScript —— 前后端单一事实来源
          </span>
        </div>
      </div>
    </section>
  );
}
