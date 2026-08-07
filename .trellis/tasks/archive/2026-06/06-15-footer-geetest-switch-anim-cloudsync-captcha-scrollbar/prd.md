# 页脚固定+极验开关测试+弹窗动画+平台信息云同步+验证码容器+隐藏滚动条

## Goal（目标）

一次性收口桌面端与管理端两类遗留体验/配置缺口：页脚不再随主内容滚动、极验验证码支持按场景开关并可后台连通性测试、关键弹窗补 framer-motion 进出动画、平台名与验证码场景随 `/api/platform-info` 云同步、验证码容器在 float 模式下正确渲染、全局隐藏滚动条同时保留功能性细滚动条。所有改动横跨 collab-api（后端配置/公开信息/测试端点）、collab-admin（设置面板/登录落地页/弹窗组件/CSS）、desktop（登录页/页脚/CSS/类型）三端。

## 背景（为什么改）

- 页脚跟随主内容滚动，视觉不固定、缺少产品级收边感。
- 极验此前只有「全局开/关」一档，无法区分 login/register/forgot 三场景；配置正确性也无验证手段（保存了错 key 也不知道）。
- dialog / detail-sheet / command-palette 切换为瞬时显隐，缺乏进出动画，交互廉价感强。
- 平台名、验证码场景此前不同步到登录落地页，多端展示不一致。
- 极验用 `product: 'bind'` 模式时容器不可见，用户「看不到验证码」。
- 各浏览器默认滚动条样式不一、且与鸿蒙字体极简风冲突。

## Requirements（需求）

### R1 页脚固定（flex 布局，不随主内容滚动）

- desktop 与 collab-admin 的 `<main>` 改 `flex-col overflow-hidden`，内容区 `min-h-0 flex-1 overflow-y-auto`，`<Footer />` 作为 `shrink-0` 兄弟节点贴视口底部。
- Footer 自身 `shrink-0`，注释明确「固定在视口底部，不随主内容滚动」。

### R2 极验开关测试（全栈闭环 + 单测）

- 后端 `geetestScenes` 配置项（白名单 `login`/`register`/`forgot`，固定顺序归一化），入 `PUBLIC_SETTING_KEYS` 与公开信息。
- `requireCaptcha(scene, captcha?)` 按场景判定，替代原全局 `isConfigured`；login/register/forgotPassword 三处分别传对应场景。
- 管理端设置页「验证码服务（极验）」Section：captchaId/captchaKey 输入 + 三场景 Checkbox + 保存/重置/测试按钮。
- 新增 `GET settings/geetest`（脱敏返回 hasCaptchaKey）与 `POST settings/test-captcha`（向极验 validate 发探测请求并落审计）。
- `getGeetestSettings` 对 captchaKey 脱敏；`testCaptcha` 区分未配置/接口正常/网络异常三态 + 403 权限。

### R3 弹窗动画（framer-motion + reduced-motion）

- dialog 重写：Overlay/Content 由 `forceMount + asChild` 交 motion.div 接管，Content 用 spring（stiffness 320/damping 30）做 scale+fade，遮罩 `backdrop-blur-[2px]`，尊重 `prefers-reduced-motion` 退化为瞬时 opacity。
- detail-sheet / command-palette 同步引入 `useReducedMotion` 与 spring 过渡，与 Dialog 风格统一。

### R4 平台信息云同步

- 后端 `getPublicInfo` 返回值与 `PublicInfoCacheEntry.value` 增 `geetestScenes` 字段。
- collab-admin 登录落地页与 desktop 登录页拉取 `platformName` + `geetestScenes`，平台名徽标块（首字母+平台名）展示，标题用 `{platformName} · 管理员登录`。

### R5 验证码容器

- 极验 `product` 由 `bind` 改为 `float`（容器浮入自带「点击验证」按钮）。
- 登录页容器渲染与提交校验均改为按场景判定（`captchaVisible = captchaId && sceneEnabled(scene)`），register/login/forgot 三场景各自独立校验。

### R6 隐藏滚动条

- desktop 与 collab-admin `index.css` 的 `@layer base` 全局隐藏 `*, body, html, .scrollbar-hide`（scrollbar-width:none + ::-webkit-scrollbar display:none）。
- `@layer utilities` 新增 `.scrollbar-thin`（功能性细滚动条，覆盖全局隐藏，用于代码块/日志/详情面板）。

## Constraints（约束）

- 简体中文（注释/commit）。文件操作用专用工具，前端 pnpm，Python 脚本 py launcher。
- 复用优先：framer-motion、Tauri fetch 通道、既有 settings/geetest 服务结构。
- R1 走 flex 布局方案（非 CSS `position: fixed`），语义等价「Footer 不随主内容滚动」。
- 不破坏既有：CORS 双 origin、tokenVersion、ValidationPipe、Prisma 错误映射、多会话/上传契约。

## Acceptance Criteria（验收标准）

- [ ] AC1 页脚固定：desktop 与 admin 主内容滚动时 Footer 贴视口底部不随动。
- [ ] AC2 极验开关测试：后台可配置三场景开关、保存生效、测试按钮返回连通结果（未配置/正常/异常三态）。
- [ ] AC3 弹窗动画：dialog/detail-sheet/command-palette 有 spring 进出动画，且 `prefers-reduced-motion` 下退化为瞬时。
- [ ] AC4 平台信息云同步：登录落地页展示后端配置的 platformName + 场景开关。
- [ ] AC5 验证码容器：float 模式容器可见，按场景条件渲染与校验。
- [ ] AC6 隐藏滚动条：全局默认无滚动条，代码块/日志等仍可用 `.scrollbar-thin` 细滚动条。
- [ ] AC7 单测全绿：`auth.service.spec.ts`（场景开关）+ `settings.service.spec.ts`（geetestScenes 校验/脱敏/测试/缓存）。
- [ ] AC8 本地验证全绿：`pnpm -C apps/collab-api typecheck` + `pnpm -C apps/collab-api test` + `pnpm -C apps/desktop typecheck` + `pnpm -C apps/collab-admin build`。

## Notes

- 实现已落在 21 个工作区改动文件中（commit 前需验证全绿再提交）。
- 子项 1 采用 flex `shrink-0` 方案而非字面 `position:fixed`，功能诉求（不随滚动）已达成。
