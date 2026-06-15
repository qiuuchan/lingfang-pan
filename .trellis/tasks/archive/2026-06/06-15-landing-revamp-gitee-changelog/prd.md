# 官网首页重构与 Gitee 更新日志接入

## Goal

围绕 `apps/collab-admin` 落地页（未登录态）与 `apps/collab-api` 后端，完成 5 项交付：
1. 首页「system — topology」动画美化（用动画替代 ASCII 静态框）
2. 删掉 architecture section（含「单后端一个平台 / 契约先行」文案）+ 顶部导航「架构」入口
3. 更新日志从 Gitee 私有仓库 release 拉取（地址 `https://gitee.com/yijianruyuan/lingfang`），管理平台可配置密钥
4. 美化首页页脚
5. 美化下载页

任务 1 与任务 2 强耦合（topology 当前嵌在 architecture 组件内），合并为子任务 `topology-revamp`。任务 3 是后端+前端联动，独立为子任务 `gitee-changelog`。任务 4、5 各自独立。

## Requirements

### 任务 1+2（子任务 topology-revamp）

- 删除 `LandingArchitecture.tsx` 组件及 `Landing.tsx` 对它的引用。
- 新增 `LandingTopology.tsx`，置于 Hero 下方、Features 上方（section 顺序 Hero → Topology → Features → Footer）。
- topology 用 SVG 三节点（desktop / admin → collab-api → PostgreSQL）+ 契约侧标（独立横条卡片，不塞进 SVG）。
- 流动光点用纯 CSS `@keyframes lf-flow`（offset-path 沿连线），**不用 framer-motion repeat:Infinity**（避免主线程开销 + SVG transform 跨浏览器兼容坑）。
- 节点入场用 `motion.tsx` 已有的 `StaggerContainer`/`StaggerItem`（一次性入场）。
- 移动端（md 以下）隐藏 SVG，换纵向卡片栈（`hidden md:block` / `md:hidden`）。
- PostgreSQL 节点用 `--lf-fg`，不用 `--lf-cyan`（已重定义为与 accent-bright 同色，会撞色）。
- 顶部导航 `LandingNav` 删「架构」项，页脚同步删。导航只留「功能 / 下载 / 更新日志」。
- `prefers-reduced-motion` 下光点静态停在连线中段（显式规则带 `!important` 覆盖全局 `*` 规则）。

### 任务 3（子任务 gitee-changelog）

- 后端新增 `GiteeChangelogService`（`apps/collab-api/src/modules/gitee-changelog.service.ts`），从 Gitee 拉取 release。
- 新增公开端点 `GET /api/changelog`（@Public），返回独立 `ChangelogEntry[]`（**不与 `Release` 同构**）。
- 鉴权用 `Authorization: Bearer <token>`，**禁止 `?access_token=` query**（pino 记录 req.url 会泄漏）。
- 新增 3 个 PlatformSetting key：`giteeOwner`、`giteeRepo`、`giteeAccessToken`（token 脱敏，getGiteeSettings 只返回 `hasAccessToken` 布尔）。
- owner/repo 字符白名单校验（首尾字母数字、中间 `._-`、显式拒 `..`），防 URL 路径段注入。
- 服务端缓存 10min TTL + singleflight inflight 互斥（并发去重，避免击穿触发 Gitee rate limit）。
- 容灾：token 未配/失败/限流/网络异常永不抛，返回 `degraded:true` + 缓存或空数组。
- 修复既有审计脱敏缺陷：`SECRET_KEYS={smtpPass, geetestCaptchaKey, giteeAccessToken}`，审计 metadata 对密钥类 key 只记 `{configured}` 不记明文。
- 新增 admin 端点 `GET /api/admin/settings/gitee` + `POST /api/admin/settings/test-gitee`（探测 releases 端点连通性）。
- 前端 `ChangelogPage.tsx` 改用新端点 `listChangelog`，类型 `ChangelogEntry[]`，加降级横幅。
- 前端 `renderNotes` 升级 markdown 解析（支持 `#`/`##`/`###`、`![]()` 图片、`[]()` 链接、缩进列表、`---` 分隔线、保留空行）。
- 前端 `settings-view.tsx` 新增 Gitee 配置卡片（复刻极验卡片范式）。

### 任务 4（子任务 footer-revamp）

- `LandingFooter.tsx` 多列重构（品牌 / 产品 / 资源 / 关于）。
- 删「架构」死链，禁用项用 `aria-disabled` + `opacity-60` + `cursor-not-allowed`（非可点死链）。
- 加版本徽标。**不加社交图标**（CLAUDE.md 明确无 GitHub / 外部仓库链接，Gitee 是私有仓库）。
- 顶部渐变分隔。

### 任务 5（子任务 download-revamp）

- `DownloadPage.tsx` 日期统一用 `formatDate`（当前 `toISOString().slice(0,10)` 是强制 UTC，与 ChangelogPage 本地时区不一致）。
- 签名校验说明改数据驱动（遍历 assets 查 `signature` 非空：全签名 / 部分未签名 / 隐藏）。
- 平台卡 hover 加顶部 accent 线（`w-0 → w-full`）。
- release notes 用独立 `<details>` 区（复用升级后的 `renderNotes`），不塞进平台卡。
- **不加 sha256 / commitish**（schema.prisma 无此字段，`signature` 是 Tauri base64 签名非 sha256）。

## Constraints

- 不破坏 `/api/releases`（list/latest/tauri-update/get）现有契约——下载页 + Tauri updater 链路零影响。Gitee 数据走独立 `/api/changelog`，职责分离。
- 不新增 Prisma 表/字段（全部复用 PlatformSetting key/value）。
- 不引 react-markdown 等重型 markdown 库（+40KB gzip，落地页首屏变大）。用升级后的正则解析器覆盖 80% 场景。
- 不引 Redis（单实例 collab-api，module-level 缓存足够；多实例部署时一并迁移所有缓存，不在本次引入）。
- 所有动画遵守 `prefers-reduced-motion`（landing.css 已有全局规则，新 keyframe 需补显式降级）。
- 全程简体中文（注释、文案、commit message）。文件 UTF-8 无 BOM。
- 所有代码改动配套 Vitest 单元测试（覆盖正常流程、边界、错误恢复）。

## Acceptance Criteria

- [ ] 首页 topology 动画区在 Hero 下方正确渲染，光点沿连线流动，移动端降级为纵向卡片栈，reduce-motion 静态展示。
- [ ] architecture section 及导航「架构」入口完全移除，无死链残留。
- [ ] `GET /api/changelog` 端点工作：配置 token 后返回 Gitee release 列表；未配置/失败时降级不报错。
- [ ] 管理端设置页可配置 Gitee owner/repo/accessToken，token 脱敏不返回明文，可测试连通性。
- [ ] ChangelogPage 正确渲染 Gitee markdown notes（标题/图片/链接/列表），降级时显示横幅。
- [ ] updateSettings 审计对 smtpPass/geetestCaptchaKey/giteeAccessToken 不记明文。
- [ ] 页脚多列结构，无死链，版本徽标正确。
- [ ] 下载页日期统一、签名状态数据驱动、hover 动效、notes 折叠区正常。
- [ ] `pnpm -C apps/collab-api typecheck && pnpm -C apps/collab-admin typecheck` 通过。
- [ ] `pnpm -C apps/collab-api test` 全绿（含新增 Gitee 用例）。
- [ ] `pnpm -C apps/collab-admin build` 通过。

## Notes

- 设计决策定稿见各子任务 `design.md`（由三方评审 workflow 产出，落到文件/函数/字段级）。
- 子任务依赖：footer-revamp 与 topology-revamp 都改 `LandingFooter.tsx`（删架构项 + 多列重构），建议 topology-revamp 先合（删架构），footer-revamp 再在干净基础上重构。
- download-revamp 的 `<details>` notes 区依赖 gitee-changelog 子任务升级后的 `renderNotes`——若并行，renderNotes 升级归 gitee-changelog 子任务所有，download-revamp 复用。
- Gitee API 契约来源：Gitee 官方 Swagger + gitee-php/gitee-sdk + mamh-mixed/go-gitee 源码交叉验证（无 published_at，用 created_at 排序；asset 的 name/size 字段未完整建模，降级不展示 size）。
