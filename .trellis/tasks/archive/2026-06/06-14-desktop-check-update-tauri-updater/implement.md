# 执行计划：桌面端检查更新（Tauri updater 集成）

> 配套 `design.md`。四阶段渐进式 checklist。简体中文，文件操作用专用工具，pnpm + cargo。

## 前置（已完成）

- ✅ 签名密钥对生成于 `.tauri/lingfang.key`（私钥）+ `.tauri/lingfang.key.pub`（公钥）。
- ✅ `.gitignore` 加 `.tauri/` + `*.key`（私钥永不入仓）。
- 依赖：后端 release 模块已就位（`/api/releases/latest` + `releaseService.latest()`）。

---

## 阶段 1：后端 Tauri 契约端点

**目标**：新增 `/api/releases/tauri-update`，返回 Tauri updater 固定 JSON 契约。

### 1.1 release.service 加 tauriManifest 方法

- 改 `apps/collab-api/src/modules/release.service.ts`：
  - 紧邻 `latest()`（:41）追加 `async tauriManifest(channel, platform?, arch?)`：
    - 复用 latest 查询逻辑（isLatest=true + PUBLISHED）。
    - 挑 `assets.find(a => a.platform===platform && a.arch===arch)`。
    - 有 asset → 返回 `{version, pub_date: publishedAt, url: asset.url, signature: asset.signature, notes}`。
    - 无版本或无匹配 asset → 返回 `null`（controller 据此返 204）。
- 验证：`pnpm --filter @lingfang/collab-api typecheck`。

### 1.2 release.controller 加 tauru-update 路由

- 改 `apps/collab-api/src/modules/release.controller.ts`：
  - 追加 `@Get('tauri-update') @Public()`，query 接 `channel/platform/arch/current_version`。
  - 调 `releaseService.tauriManifest(channel, platform, arch)`：null → `res.status(204).send()`；非 null → `res.json(manifest)`。
  - 注意：用 `@Res() res: Response` 手动控制 204（不能直接 return null，Nest 会序列化成 `null` 字符串 200）。
- 验证：`pnpm --filter @lingfang/collab-api typecheck` + 手动 curl `GET /api/releases/tauri-update?channel=STABLE&platform=WINDOWS&arch=X86_64&current_version=0.0.1` 返 200 + Tauri 契约 JSON；无匹配返 204。

### 1.3 单测

- 改 `apps/collab-api/src/modules/release.service.spec.ts` 追加：
  - `tauri_manifest_returns_contract`：有版本+匹配 asset → 返 `{version, pub_date, url, signature, notes}`（断言字段名精确）。
  - `tauri_manifest_no_asset_returns_null`：版本存在但无匹配平台 asset → null。
  - `tauri_manifest_no_release_returns_null`：无已发布版本 → null。
- 验证：`pnpm --filter @lingfang/collab-api test`。

**阶段 1 Review Gate**：typecheck + test 全绿 + curl 实测契约端点返正确结构/204。未过不进阶段 2。

---

## 阶段 2：桌面 Tauri updater 集成

**目标**：插件装好 + check_update/download_and_install 命令就位。

### 2.1 Cargo.toml + tauri.conf.json

- 改 `apps/desktop/src-tauri/Cargo.toml`：`[dependencies]` 追加 `tauri-plugin-updater = "2"`。
- 改 `apps/desktop/src-tauri/tauri.conf.json`：
  - `bundle` 加 `"createUpdaterArtifacts": true`。
  - 追加 `"plugins": { "updater": { "pubkey": "<.tauri/lingfang.key.pub 内容>", "endpoints": [] } }`。
  - pubkey 从 `.tauri/lingfang.key.pub` 读（base64 字符串，整行内嵌）。
- 验证：`cd apps/desktop/src-tauri && cargo build`（插件依赖拉取 + 编译通过）。

### 2.2 updater.rs（新建）

- 新建 `apps/desktop/src-tauri/src/updater.rs`（design §4.4 完整）：
  - `PendingUpdate(pub Mutex<Option<Update>>)` 全局 state。
  - `UpdateMetadata` struct（camelCase 序列化）。
  - `DownloadEvent` enum（Channel 推进度，Started/Progress/Finished）。
  - `check_update(app, pending, channel, backend_url)` 命令。
  - `download_and_install(pending, on_event, app)` 命令。
  - `current_platform()` 辅助（OS/ARCH → WINDOWS/X86_64 等）。
  - 顶部注释：声明 Tauri updater 契约 + endpoint 动态注入原因（后端地址用户配置）。
- 验证：`cd apps/desktop/src-tauri && cargo build`。

### 2.3 main.rs 注册

- 改 `apps/desktop/src-tauri/src/main.rs`：
  - `mod updater;`。
  - builder `.plugin(tauri_plugin_updater::Builder::new().build())`。
  - setup `app.manage(updater::PendingUpdate(std::sync::Mutex::new(None)))`。
  - invoke_handler 追加 `updater::check_update, updater::download_and_install,`。
- 验证：`cd apps/desktop/src-tauri && cargo test && cargo build`（无 warning）。

### 2.4 updater.rs 单测

- `#[cfg(test)]`：
  - `current_platform_maps_correctly`（cfg gate，断言 WINDOWS/X86_64 等映射）。
  - URL 拼接正确（抽个 `build_update_url(backend, channel, platform, arch, ver)` 纯函数测）。
- 验证：`cd apps/desktop/src-tauri && cargo test`。

**阶段 2 Review Gate**：cargo test + build 全绿（无 warning）。未过不进阶段 3。

---

## 阶段 3：前端检查更新 UI

**目标**：设置页加检查更新入口 + 结果 Dialog + 进度。

### 3.1 lib 封装

- 新建 `apps/desktop/src/lib/updater.ts`：
  - `checkUpdate(backendUrl)` → `tauriInvoke('check_update', {channel:'STABLE', backendUrl})`。
  - `downloadAndInstall(onEvent)` → `tauriInvoke('download_and_install', {onEvent})`（Channel 类型）。
  - 类型：`UpdateMetadata`、`DownloadEvent`。
- 验证：`pnpm --filter desktop typecheck`。

### 3.2 Settings 加检查更新 Card

- 改 `apps/desktop/src/pages/Settings.tsx`：
  - Tab3（后端服务 TabsContent）内，后端地址 Card 下方加「检查更新」Card。
  - state：`checking`/`updateMeta`（UpdateMetadata|null）/`installing`/`progress`（{downloaded,total}）。
  - LoadingButton「检查更新」→ checkUpdate(backendUrl)：backendUrl 空 → toast「请先配置后端地址」；meta=null → toast「当前已是最新版本」；meta → setUpdateMeta 弹 Dialog。
  - Dialog：标题「发现新版本 v{version}」+ notes（复用 `<Markdown>` from `@/components/markdown`）+ 「立即更新」/「稍后」。
  - 「立即更新」→ downloadAndInstall(onEvent)：onEvent 收 Started/Progress/Finished → 更新 progress state → 进度条 → Finished 后应用自动重启。
- 验证：`pnpm --filter desktop typecheck`。

### 3.3 进度条 UI

- Dialog 内加进度条：`progress.downloaded / progress.total` 百分比 + `<progress>` 元素或自定义 div。
- installing=true 时禁用关闭按钮。
- 验证：`pnpm --filter desktop typecheck && pnpm --filter desktop build`。

**阶段 3 Review Gate**：typecheck + build 全绿 + 现有 146 测不回归。未过不进阶段 4。

---

## 阶段 4：打包签名 + 端到端验证

**目标**：构建带签名安装包，补 seed asset signature，实测完整更新流程。

### 4.1 构建带签名包

- 设环境变量后构建：
  ```powershell
  $env:TAURI_SIGNING_PRIVATE_KEY_PATH="O:\lingfang-platform\.tauri\lingfang.key"
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  pnpm --filter desktop build
  ```
- 产物：`apps/desktop/src-tauri/target/release/bundle/msi/LingFang_*.msi` + `LingFang_*.msi.zip` + `LingFang_*.msi.zip.sig`。
- 读 `.sig` 文件内容（base64 minisign 签名）。

### 4.2 补 seed asset signature

- 当前 seed 1.0.0 的 WINDOWS asset signature 为空。用 admin 端点或直接 DB 改：
  - `DELETE /api/admin/releases/:id/assets/:assetId` 删旧空 signature asset → `POST /api/admin/releases/:id/assets` 传真实 url/filename/signature/sizeBytes。
  - 或直接 prisma update signature 字段（一次性脚本）。
- url 指向本地可访问的包路径（如 `file:///O:/...` 或起个静态服务器）。

### 4.3 端到端实测

- 启动后端（已跑）+ 桌面 dev。
- 设置页「检查更新」→ 应显示「发现新版本 v1.0.0」+ changelog。
- 「立即更新」→ 下载进度 → 安装 → 重启。
- 验证：AC1-AC9 全部手动通过。

**阶段 4 Review Gate**：完整检查更新→下载→安装→重启流程跑通（AC1-AC9）。

---

## Review Gate 汇总

| 阶段 | Gate 命令                                                     | 通过标准            |
| ---- | ------------------------------------------------------------- | ------------------- |
| 1    | `pnpm --filter @lingfang/collab-api typecheck && test` + curl | 全绿 + 契约端点正确 |
| 2    | `cd apps/desktop/src-tauri && cargo test && cargo build`      | 全绿无 warning      |
| 3    | `pnpm --filter desktop typecheck && build`                    | 全绿 + 146 测不回归 |
| 4    | 手动端到端                                                    | AC1-AC9 跑通        |

## 回滚点

- 阶段1：新端点纯增量，回滚 = 删 tauru-update 路由 + tauriManifest 方法。
- 阶段2：插件 + 命令新增，回滚 = Cargo.toml 删依赖 + tauri.conf.json 删 plugins.updater + 删 updater.rs + main.rs 注销。createUpdaterArtifacts=true 不影响非更新构建。
- 阶段3：Settings 加 Card，回滚 = 删 Card + lib/updater.ts。
- 阶段4：DB asset signature 改动，回滚 = 重跑 seed 恢复空 signature。

## 产出物

**新增**：`updater.rs`、`lib/updater.ts`、后端 `tauri-update` 路由 + `tauriManifest` service 方法 + 单测。
**修改**：`Cargo.toml`、`tauri.conf.json`、`main.rs`、`release.service.ts`、`release.controller.ts`、`release.service.spec.ts`、`Settings.tsx`、`.gitignore`（已加 .tauri）。
