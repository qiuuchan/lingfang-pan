# LingFang 管理端 / 官网（二合一）

平台管理后台 **与** 官网落地页合并为同一个 React SPA：

- **未登录** → 显示官网落地页（深色技术感，含产品介绍、下载、更新日志、架构、登录入口）
- **登录后** → 进入管理后台（浅色 shadcn/ui，含仪表盘、用户、团队、插件、审批、审计）

同一 app、同一端口（:4174）、同一套构建。普通用户和团队管理员不使用该入口。

## 本地开发

API 默认地址为 `http://localhost:3000`。推荐显式指定：

```bash
# 1. 启动后端
pnpm collab:api:dev          # → http://localhost:3000

# 2. 启动管理端 / 官网（合并 app）
VITE_API_BASE_URL=http://localhost:3000 pnpm collab:admin:dev
# → http://localhost:4174（未登录看官网落地页，登录后进后台）
```

> 跨域：管理端/官网同源（:4174）调用 collab-api（:3000），
> 需在 `apps/collab-api/.env` 的 `CORS_ALLOWED_ORIGINS` 包含 `http://localhost:4174`（默认已含）。

## 环境变量

优先读取：

```env
VITE_API_BASE_URL=http://localhost:3000
```

兼容旧变量名：

```env
VITE_COLLAB_API_BASE=http://localhost:3000
```

## 构建

```bash
pnpm -C apps/collab-admin typecheck
VITE_API_BASE_URL=http://localhost:3000 pnpm -C apps/collab-admin build
pnpm -C apps/collab-admin preview
```

## 官网落地页

落地页代码在 `src/components/landing/`：

```
landing/
├── landing.css              深色作用域样式（.landing-scope，隔离自后台浅色 shadcn 主题）
├── Landing.tsx              根组件（组合各 section + 内嵌登录 Dialog）
├── LandingNav.tsx           顶部导航（logo + 锚点 + 登录按钮）
├── LandingHero.tsx          Hero（大标题 + 终端装饰 + 版本徽标 + CTA）
├── LandingFeatures.tsx      三大核心功能卡片
├── LandingDownload.tsx      下载区（从 /api/releases/latest 取数）
├── LandingChangelog.tsx     更新日志时间线（从 /api/releases 取数）
├── LandingArchitecture.tsx  技术栈 + 系统拓扑
└── LandingFooter.tsx        页脚
```

- 深色美学用 CSS 变量前缀 `--lf-*` 隔离，不污染后台的浅色 shadcn 令牌。
- Download / Changelog 是从 `/api/releases/*` 取真实版本数据的组件，API 不可用时优雅降级。
- `App.tsx` 中：`!session ? <Landing onAuthed={setSession} /> : <管理后台 />`。
  落地页内嵌登录 Dialog，登录成功 `onAuthed` → setSession → 自动切到后台。

## 附录：更新 API 契约（供桌面端 / 其他应用对接）

更新能力由 collab-api 的 `release` 模块提供，数据存 PostgreSQL（`Release` + `ReleaseAsset` 表）。

### 公开端点（无需鉴权，落地页 Download/Changelog 与桌面端检查更新共用）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/releases/latest` | 最新版本。query：`channel`（STABLE/BETA）、`platform`（WINDOWS/DARWIN/LINUX）、`arch`（X86_64/AARCH64/UNIVERSAL）、`currentVersion`（返回 `updateAvailable` 标志） |
| `GET` | `/api/releases` | 版本列表。query：`channel`、`limit`（1–50，默认 10） |
| `GET` | `/api/releases/:version` | 指定版本详情（含全部产物） |

### 管理端点（需平台 Admin JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/admin/releases` | 创建版本（DRAFT） |
| `PATCH` | `/api/admin/releases/:id` | 更新标题 / 更新说明 |
| `POST` | `/api/admin/releases/:id/publish` | 发布（原子维护 `isLatest` 唯一） |
| `POST` | `/api/admin/releases/:id/archive` | 归档 |
| `POST` | `/api/admin/releases/:id/assets` | 登记产物（平台 / 架构 / 下载链接 / 签名） |
| `DELETE` | `/api/admin/releases/:id/assets/:assetId` | 删除产物 |

### Tauri 2 updater 接入路径（后续工作）

桌面端当前**未接入** Tauri 官方 updater（无 `tauri-plugin-updater` 依赖 / 配置 / 权限）。
本模块的 `/api/releases/latest` 契约已与 Tauri updater 的查询格式兼容，后续接入步骤：

1. 生成签名密钥对：`pnpm tauri signer generate`（得到 pubkey 与私钥）。
2. `apps/desktop/src-tauri/Cargo.toml` 加 `tauri-plugin-updater = "2"`。
3. `tauri.conf.json` 加 `plugins.updater.endpoints` 指向 `https://<api>/api/releases/latest?platform={{target}}&arch={{arch}}&currentVersion={{current_version}}`，
   以及 `plugins.updater.pubkey`。
4. 打包时用私钥签名产物，`signature` 写入 `ReleaseAsset.signature`（通过 `/api/admin/releases/:id/assets` 登记）。
5. `capabilities/default.json` 加 `updater:default` 权限。

完成后桌面端即可调用现有 `/api/releases/latest` 端点完成自动更新检查。
