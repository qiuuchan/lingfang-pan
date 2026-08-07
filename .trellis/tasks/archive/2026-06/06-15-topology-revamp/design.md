# 设计：删 architecture 区 + 拓扑动画重构

## 一、改动范围

```
删除：LandingArchitecture.tsx
新增：LandingTopology.tsx
改动：Landing.tsx（import + section 顺序）
      LandingNav.tsx（删架构 nav 项）
      LandingFooter.tsx（删架构死链 —— 多列重构归 footer-revamp 子任务，本任务仅删项）
      landing.css（lf-flow keyframe + reduce 显式降级）
```

> 注意：LandingFooter 的「架构」项删除归本任务（避免死链），多列美化重构归 `footer-revamp` 子任务。两者改同一文件，本任务先做（删项），footer-revamp 在干净基础上重构。

## 二、section 顺序

`Landing.tsx` 改为：Hero → Topology → Features → Footer。

理由：topology 是「系统是什么」的总览，紧承 Hero 终端代码块氛围；Features 是「能力是什么」的展开。动画区放前面承接 Hero，避免 Features 三卡片后突然动画区打断节奏。

## 三、LandingTopology 组件结构

```tsx
<section
  id="lf-topology"
  className="py-20 sm:py-28"
  style={{
    borderTop: '1px solid transparent',
    borderImage: 'linear-gradient(to right, transparent, var(--lf-border), transparent) 1',
    scrollMarginTop: '4rem', // 与 fixed nav h-16(4rem) 对齐
  }}
>
  <div className="mx-auto max-w-6xl px-6">
    {/* 区块标题 */}
    <div className="max-w-2xl">
      <span className="lf-section-label">system — topology</span>
      <h2 className="mt-3 text-4xl sm:text-5xl font-bold tracking-tight">三端，一套契约</h2>
      <p className="mt-4 text-lg" style={{ color: 'var(--lf-fg-muted)' }}>
        桌面 / 管理端共享同一个 collab-api，落到同一份 PostgreSQL，契约由 Zod 单一来源驱动。
      </p>
    </div>

    {/* 桌面端：SVG 三节点 + 流动光点（一次性入场用 StaggerContainer） */}
    <div className="hidden md:block mt-14">
      <StaggerContainer>{/* SVG，见 §四 */}</StaggerContainer>
    </div>

    {/* 移动端：纵向卡片栈（无动画，省电） */}
    <div className="md:hidden mt-10 space-y-3">
      {/* desktop/admin lf-card → ▼ → collab-api lf-card → ▼ → PostgreSQL lf-card */}
    </div>

    {/* 契约侧标：独立横条卡片，不塞进 SVG（避免 SVG 内中英文混排糊） */}
    <div className="mt-6 lf-card flex items-center gap-4 p-5">
      <span className="lf-section-label">contract</span>
      <span className="lf-mono text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
        packages/contract · Zod · TypeScript —— 前后端单一事实来源
      </span>
    </div>
  </div>
</section>
```

## 四、SVG 拓扑实现（不掉帧要点）

**viewBox**：`0 0 900 360`，节点用 `<rect rx>` 圆角框，连线用 `<path>`，光点沿 path 流动。

**配色**：

- desktop / admin 节点：`--lf-accent`（#3b82f6）
- collab-api 节点：`--lf-accent-bright`（#60a5fa）
- PostgreSQL 节点：`--lf-fg`（#e6edf3，**不用 --lf-cyan**——landing.css:28 已重定义为 #60a5fa，与 accent-bright 撞色）

**不掉帧铁律**：

1. 流动光点用纯 CSS `@keyframes lf-flow`（offset-path 沿连线），**不用 framer-motion repeat:Infinity**（主线程开销 + SVG transform 跨浏览器兼容坑）。
2. 光点只动 `transform`/`opacity`，**禁 `filter: drop-shadow`/`blur`**（深色页 + accent 蓝叠加是最常见掉帧源）。发光感用 `<radialGradient>` fill 静态实现。
3. `will-change: transform` 仅给光点 `<g>`，不给整个 SVG（撑内存）。

**节点布局**（viewBox 900×360）：

- 上层两个节点并排：desktop（左，x≈120）+ admin（右，x≈780），y≈80
- 中层：collab-api（居中，x≈450），y≈200
- 下层：PostgreSQL（居中，x≈450），y≈320
- 连线：desktop→collab-api、admin→collab-api、collab-api→PostgreSQL（贝塞尔曲线）
- 光点沿 desktop→collab-api 与 admin→collab-api 两条 path 流动（三段错峰 animation-delay）

## 五、新增 CSS keyframe（追加 landing.css，reduce 全局规则之前）

```css
/* topology 流动光点：沿 path 滚动，三段错峰 */
@keyframes lf-flow {
  from {
    offset-distance: 0%;
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  90% {
    opacity: 1;
  }
  to {
    offset-distance: 100%;
    opacity: 0;
  }
}
.lf-flow-dot {
  offset-path: path('M120,80 C 450,80 450,200 450,200');
  animation: lf-flow 3s linear infinite;
}

/* reduce 显式降级（全局 * + !important 压不住，必须同带 !important） */
@media (prefers-reduced-motion: reduce) {
  .lf-flow-dot {
    animation: none !important;
    offset-distance: 50%;
    opacity: 0.6;
  }
}
```

> reduce 全局规则（landing.css:208-216）用 `.landing-scope *` + `!important` 会把 infinite 拍成 1 次、3s 拍成 0.01ms，光点瞬移到 0% 位置（opacity 0）消失。显式降级让光点静态停在连线中段可见。

## 六、导航改动

`LandingNav.tsx` 的 `NAV` 数组删「架构」项：

```ts
const NAV = (onNavigateDownload, onNavigateChangelog) => [
  { label: '功能', href: '#lf-features', onClick: undefined },
  { label: '下载', href: undefined, onClick: onNavigateDownload },
  { label: '更新日志', href: undefined, onClick: onNavigateChangelog },
  // 删 { label: '架构', href: '#lf-architecture', onClick: undefined }
];
```

导航不放 topology 入口（topology 是 Hero 下方自然滚到的区，非用户主动跳转目标）。

## 七、锚点影响

- 删 `#lf-architecture`，新 Topology 区给 `id="lf-topology"`。
- `#lf-top`（Hero）、`#lf-features`（Features）锚点不受影响，保留。
- `scrollMarginTop: '4rem'` 与 fixed nav `h-16`（4rem）对齐，沿用。

## 八、回滚点

git revert 单 commit（纯前端改动，无 DB/契约影响）。
