// 落地页架构区：用一行极简的「节点 → 节点」卡片表达三端共享同一后端。
// 相比旧版 SVG 拓扑，新版更克制，避免与 Hero 的 PluginManuscript 抢夺注意力。

import { Monitor, LayoutDashboard, Server, Database } from 'lucide-react';

const NODES = [
  { id: 'desktop', label: 'desktop', sub: 'Tauri 2 · React', Icon: Monitor },
  { id: 'admin', label: 'admin', sub: 'React · shadcn/ui', Icon: LayoutDashboard },
  { id: 'collab-api', label: 'collab-api', sub: 'NestJS · /api', Icon: Server },
  { id: 'postgres', label: 'PostgreSQL', sub: 'lingfang_collab', Icon: Database },
] as const;

export function LandingTopology() {
  return (
    <section
      id="lf-topology"
      className="py-20 sm:py-28"
      style={{
        borderTop: '1px solid var(--lf-border)',
        scrollMarginTop: '4rem',
      }}
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <span className="lf-section-label">system</span>
          <h2 className="lf-display mt-3 text-4xl sm:text-5xl font-semibold tracking-tight" style={{ color: 'var(--lf-fg)' }}>
            三端，一套契约
          </h2>
          <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
            桌面端、管理端与后端共用同一份 Zod 契约，数据落到同一个 PostgreSQL。
            改一处，三端一致。
          </p>
        </div>

        {/* 架构卡片流 */}
        <div className="mt-14">
          <div className="hidden md:flex items-center justify-between gap-3">
            {NODES.map((node, index) => (
              <div key={node.id} className="flex items-center gap-3">
                <div
                  className="lf-card flex items-center gap-4 px-5 py-4 min-w-[10rem]"
                  style={{
                    backgroundColor: node.id === 'collab-api' ? 'var(--lf-bg-elevated)' : 'var(--lf-bg-card)',
                  }}
                >
                  <node.Icon size={20} strokeWidth={1.6} style={{ color: node.id === 'collab-api' ? 'var(--lf-accent)' : 'var(--lf-fg-muted)' }} />
                  <div>
                    <div className="lf-mono text-sm font-semibold" style={{ color: 'var(--lf-fg)' }}>{node.label}</div>
                    <div className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>{node.sub}</div>
                  </div>
                </div>
                {index < NODES.length - 1 && (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--lf-fg-subtle)" strokeWidth="1.5">
                    <path d="M5 12h14M14 7l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            ))}
          </div>

          {/* 移动端纵向栈 */}
          <div className="md:hidden space-y-3">
            {NODES.map((node, index) => (
              <div key={node.id}>
                <div
                  className="lf-card flex items-center gap-4 px-5 py-4"
                  style={{
                    backgroundColor: node.id === 'collab-api' ? 'var(--lf-bg-elevated)' : 'var(--lf-bg-card)',
                  }}
                >
                  <node.Icon size={20} strokeWidth={1.6} style={{ color: node.id === 'collab-api' ? 'var(--lf-accent)' : 'var(--lf-fg-muted)' }} />
                  <div>
                    <div className="lf-mono text-sm font-semibold" style={{ color: 'var(--lf-fg)' }}>{node.label}</div>
                    <div className="lf-mono text-xs" style={{ color: 'var(--lf-fg-subtle)' }}>{node.sub}</div>
                  </div>
                </div>
                {index < NODES.length - 1 && (
                  <div className="flex justify-center py-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--lf-fg-subtle)" strokeWidth="1.5">
                      <path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 契约侧标 */}
          <div className="mt-6 lf-card flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:gap-4">
            <span className="lf-section-label shrink-0">contract</span>
            <span className="lf-mono text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
              <span style={{ color: 'var(--lf-accent)' }}>packages/contract</span> · Zod · TypeScript —— 前后端单一事实来源
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
