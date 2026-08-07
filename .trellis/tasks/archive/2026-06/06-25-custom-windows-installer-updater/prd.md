# 自制 Windows 安装/更新/卸载器替换 Tauri

## Goal

自制 Windows 端的安装器、更新器、卸载器，替换当前基于 Tauri NSIS + `tauri-plugin-updater`
的安装/更新/卸载方案，目标是**彻底摆脱 Tauri updater 的 minisign 签名密钥**
（`.tauri/lingfang.key` / conf.json `pubkey`），同时自定义安装/更新/卸载 UI 与流程，
更新检查/下载走自有更新服务器协议（不再受 Tauri 固定 `latest.json` 契约约束）。

平台范围：仅 Windows（架构预留后续扩展 macOS/Linux）。

## Confirmed Facts（代码勘察）

- **打包**：`apps/desktop/src-tauri/tauri.conf.json` → `bundle.targets: ["nsis"]`，
  `createUpdaterArtifacts: true`，`windows.nsis.installMode: "currentUser"`，
  `installerHooks: nsis/installer-hooks.nsh` 强制 `InstallDir = %LOCALAPPDATA%\LingFang`。
- **更新插件**：`tauri-plugin-updater = "2"`（Cargo.toml），main.rs 注册插件 +
  `check_update`/`download_and_install` 命令，全局 `PendingUpdate` State。
- **签名**：conf.json `plugins.updater.pubkey`（minisign 公钥，base64），
  `dangerousInsecureTransportProtocol: true`（允许 HTTP 内网后端）。构建需私钥签名生成 `.sig`。
- **endpoints 动态注入**：conf.json endpoints 留空，`updater.rs` 运行时用
  `app.updater_builder().endpoints()` 注入 `<backendUrl>/api/releases/tauri-update`。
- **后端**：`apps/collab-api` ReleaseController/ReleaseService。
  - `/api/releases/tauri-update`（@Public）：返回 Tauri 固定契约 `{version, pub_date, url, signature, notes}`，无更新返 204。
  - `/api/releases/latest`（@Public）：返回完整版本 + 多 asset（含 `updateAvailable` 标志、`sizeBytes`、`signature`）。
  - admin 上传安装包 + 可选 `.sig` → `downloads/` 目录，`signature` 存 `ReleaseAsset.signature`。
- **数据模型**（prisma）：`Release`（version/channel/status/isLatest/notes/publishedAt）+
  `ReleaseAsset`（platform/arch/url/filename/signature/sizeBytes，`@@unique([releaseId, platform, arch])`）。
- **前端 UI**：`Settings.tsx` Tab3「检查更新」（Dialog + changelog + 进度条 + 立即更新），
  `lib/updater.ts` 封装命令；`changelog.ts` 拉更新日志。
- **minisign 复用**：`minisign-verify = "0.2"` 还用于插件签名校验（plugin_security.rs），
  与 updater 同款依赖 —— 摆脱 updater 不必然移除 minisign-verify crate。

## Requirements

### R1 完整性校验：SHA-256 哈希（已定）

- 摒弃 minisign 非对称签名，改用 **SHA-256 哈希校验**：后端更新元数据附带安装包 SHA-256，
  客户端下载后比对哈希一致才安装。无需任何私钥/公钥。
- 安全模型：防下载途中损坏/篡改；**不防后端服务器被攻破后同时改包改哈希**（已知取舍，
  自部署内网场景可接受，与当前 `dangerousInsecureTransportProtocol: true` 现状一致，无实质降级）。
- 数据模型：`ReleaseAsset` 新增 `sha256` 字段（admin 上传时计算或填写），废弃/保留 `signature` 字段视迁移而定。

### R2 更新器形态：独立 updater.exe（已定，R7 微调下载产物）

- 随主程序一起安装一个独立的小工具 `updater.exe`，专门负责「替换正在运行的程序文件」。
- 流程：主程序检测更新 → 下载**新版自解压安装 EXE**到临时目录 → 校验 SHA-256
  → 启动 `updater.exe` 并退出自己 → `updater.exe` 等主进程退出 → 以静默模式调起新版安装 EXE
  覆盖安装目录 → 重新拉起主程序。
- 解决 Windows 运行中 .exe/.dll 被锁、进程不能覆盖自身的问题（Squirrel/electron-updater 通用做法）。
- 更新检查/下载进度 UI 在主程序内（自定义），`updater.exe` 静默执行替换。

### R3 安装器形态：自写 Rust 三合一工具（已定）

- **完整接管打包**：Tauri 仅用于 `cargo build` 编译出主程序二进制 + 资源目录
  （`runtimes/`、`builtin-plugins/`），`bundle.targets` 去掉 `nsis`（不再生成 Tauri NSIS 包）。
- 自写一个 **Rust 工具，三合一**（同一二进制不同子命令/模式）：
  - **安装器**：选目录 → 解压程序文件到 `%LOCALAPPDATA%\LingFang` → 开始菜单/桌面快捷方式
    → 写注册表「添加删除程序」项（Uninstall key）→ 落 `updater.exe`/卸载器。
  - **更新器**（R2）：等主进程退出 → 覆盖文件 → 重启主程序。
  - **卸载器**：从「添加删除程序」调起 → 关进程 → 删文件/快捷方式/注册表项 → 自删除。
- 自定义 UI、零密钥、安装/更新/卸载逻辑统一在一处维护。
- 首次分发：自写安装器打包成一个自解压安装 EXE（含主程序文件 + updater/卸载器）。
- 需处理的 Windows 细节：快捷方式（.lnk）、注册表 Uninstall key、UAC（currentUser 安装免提权）、
  保留旧 `%LOCALAPPDATA%\LingFang` 路径以兼容已装旧版用户原地升级。

### R4 UI 技术：egui（已定）

- 安装器/卸载器界面用 **egui**（即时模式 GUI，自绘）：选目录、进度条、完成提示。
- 统一现代视觉风格，跨平台一致（呼应后续 macOS/Linux 扩展），体积可控（远小于 webview）。
- updater 模式静默无 UI（进度在主程序内展示），仅安装器/卸载器需要 egui 窗口。

### R5 更新协议/端点：复用 /api/releases/latest（已定）

- 复用现有 `/api/releases/latest`（@Public，已支持 `channel`/`platform`/`arch`/`currentVersion` 查询、
  返回多 asset + `updateAvailable` 标志 + `sizeBytes`），**给 asset 出参加 `sha256` 字段**。
- 自制更新器：GET `/api/releases/latest?platform=WINDOWS&arch=X86_64&currentVersion=x.y.z` →
  读 `updateAvailable` + 对应 asset 的 `url`/`sha256`/`sizeBytes`/`notes` → 下载 + 校验 + 交给 updater.exe。
- 后端改动最小：schema 加 `sha256` + 出参带上 + admin 上传时计算 sha256。

### R6 旧机制清理：彻底清理（已定）

- **彻底清理 Tauri updater 全部遗留**，旧 NSIS 用户不做自动迁移（手动下载新安装器重装）。
- conf.json：删 `plugins.updater`（pubkey/endpoints/dangerousInsecureTransportProtocol）、
  `bundle.createUpdaterArtifacts`、`bundle.targets` 的 `nsis`、`windows.nsis` 段、`installerHooks`。
- Cargo.toml：删 `tauri-plugin-updater`、`url`（仅 updater 用）。
  **保留 `minisign-verify`**（plugin_security.rs 插件签名仍在用，与本任务无关）。
- Rust：删 `updater.rs`、main.rs 的 updater 插件注册 + `check_update`/`download_and_install` 命令注册
  - `PendingUpdate` State。
- 前端：删/改造 `lib/updater.ts`，`Settings.tsx` 更新 UI 改对接新更新器（不是删，是换数据源/命令）。
- 后端：删 `/api/releases/tauri-update` 端点 + `tauriManifest()` + `ReleaseTauriQueryDto`。
  `ReleaseAsset.signature` DB 列保留（不强删避免 migration 风险），停止使用；admin 上传 `.sig` 逻辑移除。
- 构建：移除 `.tauri/lingfang.key` 依赖、`TAURI_SIGNING_PRIVATE_KEY_PATH` 环境变量需求。
- 自删 `nsis/installer-hooks.nsh`（NSIS 不再使用）。

### R7 发布产物形态：单一自解压安装 EXE（已定）

- 每个版本只产出一个 `LingFang-Setup-x.y.z.exe`（自解压，内含全部 app 文件 + updater/卸载器）。
  - 首次安装：双击走交互 UI（egui）。
  - 更新：主程序下载同一个 EXE，`updater.exe` 以静默/无人值守模式调起它覆盖安装。
- admin 发布页只传一个文件，`Release` 下 Windows 平台对应一个 `ReleaseAsset`。
- 自解压 EXE 内部需携带 app 文件（含 Python `runtimes/`、`builtin-plugins/`）；体积较大但首装/更新统一。
- 静默模式：安装 EXE 需支持命令行参数（如 `--silent --target <dir>`）供 updater 无 UI 调用。
- 增量/差分更新本期不做（runtime 整包资源，差分收益有限）。

### R8 工程位置 + 自解压构建（已定）

- 新建 crate **`apps/desktop/installer`**，加入根 `Cargo.toml` 的 workspace（与 `src-tauri` 同 workspace、共享 `Cargo.lock`）。
- 三合一工具是同一二进制不同子命令：`install`（默认/交互）、`--silent`（更新调用）、`uninstall`。
- 自解压方式：构建时把 `cargo build` 产出的主程序 + `runtimes/` + `builtin-plugins/` 等 app 文件
  打成压缩包，**追加到 installer.exe 尾部**（运行期读取自解压），避免 `include_bytes!` 编译期
  嵌入上百 MB runtime 导致编译极慢/吃内存。具体嵌入细节 design 阶段定。
- 打包流程：写一个脚本（PowerShell 或 Rust xtask）串起「编译主程序 → 编译 installer → 收集 app 文件
  → 压缩 → 追加到 installer.exe → 产出 LingFang-Setup-x.y.z.exe」。
- `tools/create-distribution.ps1` 是源码分发包脚本，与本任务无关，不改。

### R9 更新检查触发：手动 + 启动静默自动检查（已定）

- 保留设置页手动「检查更新」按钮（改造为对接新机制：`/api/releases/latest` + 下载 + SHA-256 校验 + 调 updater.exe）。
- 新增**启动时后台静默检查一次**：主程序启动后台查 `/api/releases/latest`，有更新则非阻塞提示用户
  （不强制、不自动下载）。需避免打扰（如本次启动忽略后不再弹）。
- 不做强制静默自动安装（保留用户控制权，大包静默不合适）。
- 前端 UI（更新 Dialog/进度条/changelog）尽量复用现有 `Settings.tsx` 结构，仅换数据源与下载/安装命令。

### R10 SHA-256 来源：后端上传自动计算（已定）

- admin 上传安装包 EXE，后端 `uploadAsset()` 对文件内容算 SHA-256，存入 `ReleaseAsset.sha256`。
- admin 零额外操作，哈希必然与实际文件一致。替换现有读 `.sig` 的逻辑（R6 已记移除 `.sig`）。

## Acceptance Criteria

### 安装器

- [ ] 双击 `LingFang-Setup-x.y.z.exe` 弹出 egui 安装界面，可选/确认安装目录（默认 `%LOCALAPPDATA%\LingFang`）。
- [ ] 安装完成后：app 文件（主程序 + `runtimes/` + `builtin-plugins/` + `updater.exe`）落到目标目录；
      开始菜单 + 桌面有「灵坊工作台」快捷方式；注册表写入 Uninstall key（控制面板「添加删除程序」可见）。
- [ ] 安装全程无需任何签名密钥、无需 UAC 管理员提权（currentUser 安装）。
- [ ] 安装后双击快捷方式可正常启动主程序，内置插件/runtime 可用。

### 更新器

- [ ] 主程序「检查更新」命中新版本时，下载新版 EXE 到临时目录并校验 SHA-256；哈希不匹配则中止并报错，不安装。
- [ ] 校验通过后启动 `updater.exe` 并退出主程序；`updater.exe` 等主进程退出后静默覆盖安装目录、重启主程序到新版本。
- [ ] 更新进度（下载字节/总量）在主程序 UI 内展示；更新失败（网络/校验/覆盖）有可读错误提示，主程序可恢复。

### 卸载器

- [ ] 控制面板「添加删除程序」点卸载调起卸载流程：关闭运行中的主进程 → 删除安装目录文件 →
      删快捷方式 → 删注册表 Uninstall key → 卸载器自删除。
- [ ] 卸载后开始菜单/桌面/注册表项均清除，安装目录清空。

### 后端 + 发布

- [ ] `ReleaseAsset` 新增 `sha256` 字段，`uploadAsset()` 上传时自动计算并存储。
- [ ] `/api/releases/latest` asset 出参包含 `sha256`；自制更新器据此校验。
- [ ] `/api/releases/tauri-update` 端点 + `tauriManifest()` + `ReleaseTauriQueryDto` 已移除；相关测试更新/删除。
- [ ] collab-admin 发布页上传安装包后展示 sha256；移除 `.sig` 上传相关 UI。

### 清理 + 构建

- [ ] `tauri-plugin-updater`、`url` crate、`updater.rs`、main.rs updater 注册/命令/State 全部移除；
      `minisign-verify` 保留且 plugin_security.rs 仍编译通过。
- [ ] `tauri.conf.json` 移除 `plugins.updater`、`createUpdaterArtifacts`、`nsis` targets/段、`installerHooks`；
      `nsis/installer-hooks.nsh` 删除。
- [ ] 构建脚本可一键产出 `LingFang-Setup-x.y.z.exe`，无需 `TAURI_SIGNING_PRIVATE_KEY_PATH` / `.tauri/lingfang.key`。

### 验证

- [ ] `cargo build`（workspace，含新 installer crate + src-tauri）通过。
- [ ] `installer` crate 关键纯函数（自解压偏移定位、SHA-256 校验、路径解析）有单元测试且通过。
- [ ] collab-api release 模块相关测试（`release.service.spec.ts` / `release-url.spec.ts`）更新后通过。
- [ ] 端到端手动验证（实机）：全新安装 → 启动 → 检查更新升级 → 卸载，四步走通（实机步骤记 implement.md）。

## Out of Scope

- macOS / Linux 安装更新（架构预留，本期不实现）
- 插件签名校验（plugin_security.rs）的改动 —— 与本任务无关
- 增量/差分更新（本期单一全量自解压 EXE）
- 旧 NSIS 用户的自动迁移（手动重装）
- 强制静默自动安装（保留用户控制权）

## Open Questions

- 无剩余阻塞性产品决策。技术细节（自解压尾部格式、注册表键路径、updater 进程等待机制、
  egui 窗口无边框样式）在 design.md 中确定。
