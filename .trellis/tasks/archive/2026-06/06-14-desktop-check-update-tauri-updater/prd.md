# 桌面端加入检查更新（Tauri updater 集成）

## Goal（目标）

桌面应用集成 Tauri updater 插件，实现完整的「检查更新 → 下载 → 验签 → 安装 → 重启」自动更新流程。更新源指向用户配置的后端 `/api/releases/*`（release 模块已就绪），支持手动检查（设置页按钮）+ 启动时静默检查。

## 背景（为什么改）

- 后端 release 模块**已完整就位**（上一任务交付）：`GET /api/releases/latest?channel=&platform=&arch=&currentVersion=` 返回版本 + assets + signature + `updateAvailable` 标志，`@Public` 无需登录。
- seed 已有 1.0.0 版本（Windows/Mac assets，signature 暂空需真实打包后补）。
- 桌面端**完全没有**更新检查能力，当前版本 0.0.1（tauri.conf.json）。
- 用户决策：走完整 Tauri 自动更新（非轻量提示）；生成签名密钥对，手动打包验证。

## Scope（范围）

### R1 签名基础设施（已生成）

- ✅ 密钥对已生成：`.tauri/lingfang.key`（私钥，gitignore）+ `.tauri/lingfang.key.pub`（公钥，进 tauri.conf.json）。
- ✅ `.gitignore` 加 `.tauri/` + `*.key`（私钥永不入仓）。
- 构建时设 `TAURI_SIGNING_PRIVATE_KEY_PATH=.tauri/lingfang.key` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`，产物自动签名。

### R2 Tauri updater 插件集成（Rust）

- `Cargo.toml` 加 `tauri-plugin-updater = "2"`。
- `main.rs` 注册插件：`.plugin(tauri_plugin_updater::Builder::new().build())`。
- `tauri.conf.json` 加 `bundle.createUpdaterArtifacts: true` + `plugins.updater.pubkey`（内嵌公钥）。
- endpoints **不在 conf.json 写死**（后端地址是用户动态配置的），用 Rust 运行时 `app.updater_builder().endpoints([url]).build()` 动态拼。

### R3 后端适配 Tauri updater 契约端点（collab-api）

Tauri updater 期望 endpoint 返回固定 JSON：`{version, pub_date, url, signature, notes}`（单 asset）。当前 `/api/releases/latest` 返回业务结构（assets 数组）。**新增** `GET /api/releases/tauri-update?channel=&platform=&arch=&current_version=`：

- `@Public`。
- 复用 `releaseService.latest()` 拿业务结构。
- 挑出 platform/arch 匹配的单个 asset。
- 映射为 Tauri 契约：`{version: r.version, pub_date: r.publishedAt, url: asset.url, signature: asset.signature, notes: r.notes}`。
- 无匹配 asset 或无已发布版本 → HTTP 204 No Content（Tauri updater 把非 200 当「无更新」）。

### R4 桌面 Rust 检查更新命令（新 `updater.rs`）

- `check_update({ channel, backendUrl })` 命令：
  - 拼接 `{backendUrl}/api/releases/tauri-update?channel=STABLE&platform={os}&arch={arch}&current_version={app version}`。
  - `app.updater_builder().endpoints([url]).build()?.check().await`。
  - 返回 `{ available: bool, version: string?, notes: string? }`（不自动下载，只检查）。
  - 平台映射：Tauri 的 `{{target}}`（windows/darwin/linux）+ `{{arch}}`（x86_64/aarch64）从 `std::env::consts` 取。
- `download_and_install()` 命令：拿到 Update 对象后 `download_and_install(on_progress, on_download_complete)` + `app.restart()`。进度通过 emit 事件 `updater://progress` 给前端。
- 首次 setup 时可选静默检查（emit `updater://update-available` 让前端决定是否提示）。

### R5 前端设置页「检查更新」UI

- Settings.tsx 顶层加「检查更新」入口（Tab3 后端服务 Card 下方，或独立 Card）。
- 点击 → `tauriInvoke('check_update', { channel: 'STABLE', backendUrl })` → 显示结果：
  - 已是最新 → toast「当前已是最新版本」。
  - 有更新 → Dialog 显示 `version` + `notes`（markdown 渲染，复用现有 markdown 组件）+ 「立即更新」按钮。
  - 「立即更新」→ `tauriInvoke('download_and_install')` → 进度条（监听 `updater://progress`）→ 完成后应用自动重启。
- 错误处理：backendUrl 未配置 → 提示先配后端；网络失败 → toast 错误。

## Constraints（约束）

- **简体中文**（注释/UI 文案）。UTF-8 无 BOM。文件操作用专用工具。
- **复用优先**：release 模块 `latest()` service 方法复用，不重写版本判定逻辑（`isNewer`）；前端复用 markdown 组件。
- **签名强制**：Tauri updater 协议强制验签，不可绕过。pubkey 进 tauri.conf.json（公开），私钥永不入仓。
- **endpoint 动态**：后端地址用户配置（`lf:backendUrl`），updater endpoint 必须 Rust 运行时拼接，不写死 conf.json。
- **平台范围**：首版仅 Windows 实测（本机环境）；macOS/Linux 代码路径写好但不强制验证（Tauri updater 跨平台一致）。
- 破坏式：直接加 updater 插件，不向后兼容（无旧更新逻辑）。

## Acceptance Criteria

- [ ] AC1 设置页有「检查更新」按钮，点击后调 `check_update`，显示检查中态。
- [ ] AC2 当前版本（0.0.1）后端有更新版本（1.0.0）→ 显示 Dialog（版本号 + changelog markdown）。
- [ ] AC3 当前版本已是最新 → toast「当前已是最新版本」。
- [ ] AC4 「立即更新」→ 下载安装包 + 进度条 + 自动安装 + 应用重启到新版本。
- [ ] AC5 后端未配置 backendUrl 时 → 提示「请先在设置页配置后端地址」。
- [ ] AC6 后端无已发布版本（tauri-update 返 204）→ 提示「暂无可用更新」。
- [ ] AC7 后端 asset 无匹配平台（如 Linux 桌面查 Windows 包）→ 友好提示，不崩。
- [ ] AC8 `Cargo.toml` + `main.rs` + `tauri.conf.json` 正确配置 updater 插件 + pubkey + createUpdaterArtifacts。
- [ ] AC9 构建产物（`pnpm tauri build` 带 `TAURI_SIGNING_PRIVATE_KEY_PATH`）生成带签名的安装包 + `.sig` 文件。
- [ ] AC10 `cargo test` + `pnpm --filter desktop typecheck/build` 全绿；现有 146 测不回归。
- [ ] AC11 `/api/releases/tauri-update` 端点返回 Tauri 契约格式（单测断言字段名/204 语义）。

## 分阶段（渐进式）

- **阶段1 后端端点**：`/api/releases/tauri-update` + 单测。
- **阶段2 桌面 updater 集成**：Cargo.toml + tauri.conf.json + main.rs 注册插件 + updater.rs（check_update + download_and_install）+ 单测。
- **阶段3 前端 UI**：Settings 检查更新入口 + 结果 Dialog + 进度条 + listener。
- **阶段4 打包验证**：带签名密钥构建 → 补 seed asset signature → 实测检查更新→下载→安装流程。

## Notes

- Tauri 2 updater 知识来自 context7 `/tauri-apps/tauri-docs`（官方文档，非训练记忆）：`UpdaterExt::updater_builder().endpoints()` 支持运行时动态 URL，解决后端地址动态配置问题。
- 签名密钥对已生成于 `.tauri/`（gitignore），公钥 `dW50cnVzdGVk...`（base64）待嵌入 tauri.conf.json。
- design.md 写技术设计（updater 契约映射/Rust 命令签名/UI 布局/平台映射），implement.md 写四阶段 checklist。
