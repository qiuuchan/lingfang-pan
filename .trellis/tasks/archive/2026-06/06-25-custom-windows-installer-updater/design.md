# Design — 自制 Windows 安装/更新/卸载器替换 Tauri

关联：`prd.md`（R1–R10）。本文定 PRD Open Questions 里留给 design 的技术细节。

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│ 构建期（开发机）                                                │
│  cargo build (src-tauri) → lingfang-desktop.exe + 资源          │
│  cargo build (installer)  → installer.exe (egui + 三合一逻辑)   │
│  package 脚本：收集 app 文件 → zip → 追加到 installer.exe 尾部   │
│             → LingFang-Setup-x.y.z.exe（自解压安装包）           │
└─────────────────────────────────────────────────────────────┘
        │ admin 上传到 collab-api（自动算 sha256）
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 后端 collab-api                                                │
│  ReleaseAsset.sha256（上传时 createHash 算）                    │
│  GET /api/releases/latest → asset 出参含 sha256                 │
│  downloads/<file> 静态托管安装包                                 │
└─────────────────────────────────────────────────────────────┘
        │ 客户端检查更新
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 桌面主程序（lingfang-desktop.exe）                              │
│  Rust 命令 check_update：GET /latest → updateAvailable + asset │
│  Rust 命令 download_update：下载 EXE → 校验 sha256 → 调 updater │
│  退出自身 → updater.exe 接管                                    │
└─────────────────────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────────────────────┐
│ updater.exe（= installer.exe，update 子命令）                  │
│  等主进程退出 → 静默运行新版 Setup.exe 覆盖安装 → 重启主程序     │
└─────────────────────────────────────────────────────────────┘
```

三合一二进制 `installer.exe`（crate `apps/desktop/installer`）的运行模式由命令行参数分派：

| 模式                                                    | 触发                     | UI           | 行为                                                    |
| ------------------------------------------------------- | ------------------------ | ------------ | ------------------------------------------------------- |
| `install`（默认，无参/双击）                            | 用户双击 Setup.exe       | egui         | 交互安装：选目录→自解压→快捷方式→注册表→落 updater 副本 |
| `--silent --target <dir>`                               | updater 调用 / 无人值守  | 无           | 静默安装/覆盖到 `<dir>`                                 |
| `update --target <dir> --setup <path> --wait-pid <pid>` | 主程序自更新             | 无           | 等 pid 退出→静默运行 setup→重启主程序                   |
| `uninstall`                                             | 控制面板「添加删除程序」 | egui（确认） | 关进程→删文件/快捷方式/注册表→自删除                    |

> 注：`update` 模式本质是「等待 + 调 `--silent` + 重启」。安装目录里部署的 `updater.exe`
> 是 installer.exe 的一份副本（同二进制），保证自更新时它不在被覆盖的关键路径上独立运行
> （从安装目录复制到临时目录再执行，避免覆盖自身）。

## 2. 自解压格式（PRD R8 留待 design）

**追加到 EXE 尾部**方案（不用 `include_bytes!`，避免编译期吞上百 MB）：

```
[ installer.exe 原始 PE 字节 ][ payload.zip ][ 12 字节尾部 trailer ]
trailer = MAGIC(8 bytes "LFSFX\0\0\0") + payload_len(u32 little-endian)
```

- 运行时：读自身可执行文件路径（`std::env::current_exe`）→ 从文件末尾读 12 字节 trailer →
  校验 MAGIC → 用 `payload_len` 反推 zip 起始偏移 → 用 `zip` crate 从该偏移读取解压。
- 没有 trailer/MAGIC 不匹配 → 说明是「裸 installer.exe」（updater 复制副本场景或 dev 直跑），
  走「无内嵌 payload」分支（update/uninstall 模式不需要 payload，install 模式则报错）。
- payload zip 内部目录结构 = 安装目录最终布局：
  ```
  lingfang-desktop.exe
  updater.exe              # = installer.exe 的副本，安装时落地
  runtimes/...
  builtin-plugins/...
  icons/icon.ico           # 卸载器/快捷方式用
  ```
- 压缩级别：`runtimes/` 已是大量小文件，用 deflate 默认级别（zip crate `DEFLATE`）。
  追求体积可后续换 zstd，本期 deflate 够用且 zip crate 原生支持。

**关键纯函数（单测覆盖，PRD 验收）**：

- `locate_payload(exe_bytes_len, trailer) -> Option<offset>`：尾部偏移定位。
- `verify_sha256(path, expected_hex) -> bool`：流式读文件算 sha256 比对。
- `resolve_install_dir(arg, default) -> PathBuf`：目录解析（默认 `%LOCALAPPDATA%\LingFang`）。

## 3. installer crate 依赖

```toml
[package]
name = "lingfang-installer"
version = "0.0.6"        # 与 desktop 同步（package 脚本可注入）
edition = "2021"

[[bin]]
name = "installer"       # 产出 installer.exe；安装后复制为 updater.exe

[dependencies]
eframe = "0.28"          # egui + 窗口（仅 install/uninstall 模式初始化）
egui = "0.28"
zip = { version = "2", default-features = false, features = ["deflate"] }
sha2 = "0.10"            # SHA-256
windows-sys = { version = "0.59", features = [   # 注册表/快捷方式/进程
  "Win32_Foundation", "Win32_System_Registry", "Win32_UI_Shell",
  "Win32_System_Com", "Win32_System_Threading", "Win32_UI_Shell_Common",
] }
dirs = "5"               # LOCALAPPDATA 定位（与 src-tauri 同款）
anyhow = "1"
```

- 快捷方式（.lnk）：用 `IShellLinkW` + `IPersistFile`（COM，windows-sys）。无需第三方 crate。
- `windows_subsystem = "windows"`（release）：install/uninstall 模式不弹控制台。
  但 silent/update 模式也无控制台即可（日志写文件，见 §6）。

## 4. 安装目录与注册表布局

- 安装目录：`%LOCALAPPDATA%\LingFang`（保留旧路径，兼容旧版用户原地覆盖；与现 NSIS hook 一致）。
- 快捷方式：
  - 开始菜单：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\灵坊工作台.lnk`
  - 桌面：`%USERPROFILE%\Desktop\灵坊工作台.lnk`（安装时可勾选）
- 注册表 Uninstall key（currentUser → HKCU）：
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.lingfang.desktop`
  | 值                  | 内容                            |
  | ------------------- | ------------------------------- |
  | DisplayName         | 灵坊工作台                      |
  | DisplayVersion      | x.y.z                           |
  | Publisher           | 灵坊工作台                      |
  | DisplayIcon         | `<dir>\lingfang-desktop.exe`    |
  | InstallLocation     | `<dir>`                         |
  | UninstallString     | `"<dir>\updater.exe" uninstall` |
  | EstimatedSize       | KB（安装后算）                  |
  | NoModify / NoRepair | 1                               |

## 5. 更新流程（端到端）

主程序（src-tauri）新增模块 `update.rs`（替换删除的 `updater.rs`），暴露两个命令：

```rust
// check_update(backend_url) -> Option<UpdateInfo>
//   GET {backend}/api/releases/latest?channel=STABLE&platform=WINDOWS&arch=X86_64&currentVersion={v}
//   reqwest（已在依赖）解析 JSON。若 updateAvailable==true 且有 WINDOWS/X86_64 asset →
//   返回 { version, notes, downloadUrl(绝对), sha256, sizeBytes }；否则 None。
//
// download_update(info, on_event: Channel) -> ()
//   1. 下载 downloadUrl → %TEMP%\LingFang-Setup-{version}.exe（流式，推 Started/Progress/Finished）
//   2. 流式算 sha256，与 info.sha256 比对；不符 → 删文件 + Err
//   3. 复制安装目录的 updater.exe → %TEMP%\lingfang-updater-{pid}.exe（避免被覆盖）
//   4. 启动该临时 updater：`update --target <installDir> --setup <setupPath> --wait-pid <selfPid> [--restart]`
//   5. app.exit(0) 退出主程序，交给 updater
```

`UpdateInfo` / `DownloadEvent` 的 serde 契约沿用现 `updater.rs` 的 camelCase + Channel 模式
（前端 `lib/updater.ts` 改动最小：`checkUpdate` 返回结构加 `downloadUrl`/`sha256`，
`downloadAndInstall` 改名/改实现但事件类型不变）。

updater 的 `update` 模式逻辑：

1. `--wait-pid` 轮询等待该 pid 进程退出（windows-sys `OpenProcess` + `WaitForSingleObject`，超时兜底）。
2. 运行 `--setup <path> --silent --target <dir>`（即解压覆盖；新版 Setup.exe 自带 payload）。
3. 删除临时 Setup.exe。
4. `--restart` 时启动 `<dir>\lingfang-desktop.exe`。
5. 临时 updater 副本自删除（schedule delete：写一个 `cmd /c del` 延迟删，或 MoveFileEx REBOOT）。

**启动静默检查（R9）**：前端 App 启动后台调 `checkUpdate`，有更新弹非阻塞 toast/badge，
用 `sessionStorage` 标记「本次启动已忽略」避免重复打扰。不自动下载。

## 6. 错误处理与日志

- updater/silent 无 UI 模式：日志写 `%LOCALAPPDATA%\LingFang\logs\updater.log`（追加，带时间戳——
  注意 Rust 端可用 `std::time`，本进程非 workflow 沙箱，`SystemTime::now()` 可用）。
- 关键失败点与对策：
  | 失败                      | 处理                                           |
  | ------------------------- | ---------------------------------------------- |
  | sha256 不匹配             | 删临时包，主程序 toast 报错，不启动 updater    |
  | 下载中断                  | reqwest 错误冒泡，主程序可重试                 |
  | 主进程未在超时内退出      | updater 超时后强制继续（或放弃并写日志）       |
  | 覆盖时文件占用            | 重试 N 次 + 退避；仍失败写日志、保留旧版本可用 |
  | 注册表写入失败（install） | egui 报错，回滚已复制文件（best-effort）       |

## 7. 后端改动（collab-api）

1. `schema.prisma`：`ReleaseAsset` 加 `sha256 String @default("")`。migration。
2. `release.service.ts`：
   - `uploadAsset()`：写文件后 `createHash('sha256').update(buffer/file).digest('hex')` 存 `sha256`；
     移除读 `.sig` → `signature` 的逻辑（signature 留空，列保留）。
   - `publicAsset()`：出参加 `sha256`。
   - 删 `tauriManifest()`。
3. `release.controller.ts`：删 `tauri-update` 路由 + import。
4. `dto/release.dto.ts`：删 `ReleaseTauriQueryDto`；`ReleaseAssetCreateDto` 去掉 `signature`（可保留为兼容，倾向删）。
5. `release-url.ts` / `release-url.spec.ts`：`absoluteUpdateAssetUrl` 若仅 tauriManifest 用则删，否则保留。
6. specs：`release.service.spec.ts` 去掉 tauriManifest 用例，加 sha256 断言。

## 8. 前端改动

- `apps/desktop/src/lib/updater.ts`：`UpdateMetadata` 加 `downloadUrl`/`sha256`；命令对接 `update.rs` 新命令。
- `apps/desktop/src/pages/Settings.tsx`：检查更新逻辑复用，事件类型不变；新增启动静默检查（在 `App.tsx`）。
- `apps/collab-admin`：`releases.ts` 的 `ReleaseAsset` 加 `sha256`；上传 UI 去掉 `.sig` 选择、展示 sha256。
  `PLATFORM_META.WINDOWS.ext` 改 `.exe`。

## 9. Tauri 配置 / 构建改动

- `tauri.conf.json`：删 `plugins.updater`、`bundle.createUpdaterArtifacts`、`bundle.windows.nsis`、
  `bundle.targets` 改 `[]` 或保留 `app` 产物方式（仅要 `cargo build` 出 exe + 资源，不要 bundler 签名）。
  > 确认：去掉 nsis 后用 `tauri build --no-bundle` 或直接 `cargo build --release` 产出 exe，
  > 资源（runtimes/builtin-plugins）由 package 脚本从 `apps/desktop/` 收集，不依赖 tauri bundler 的 resources 拷贝。
- `Cargo.toml`(src-tauri)：删 `tauri-plugin-updater`、`url`。
- 根 `Cargo.toml`：workspace members 加 `apps/desktop/installer`。
- 删 `apps/desktop/src-tauri/nsis/installer-hooks.nsh`。
- 新增 `tools/build-installer.ps1`（或 cargo xtask）：编译 + 收集 + 自解压打包，产出 Setup.exe。

## 10. 跨平台预留

- installer crate 的 Windows 特定逻辑（注册表/lnk/进程等待）放 `platform/windows.rs`，
  trait `Platform { install_shortcuts, register_uninstall, wait_pid, ... }`，
  后续加 `platform/macos.rs` / `platform/linux.rs`。egui/zip/sha2 逻辑跨平台共用。本期仅实现 windows。

## 11. 风险与回滚

- **最大风险**：自更新「覆盖正在运行文件」在真实机器上的行为（杀软拦截、文件占用、UAC）。
  必须实机验证（PRD 验收最后一项）。
- **回滚点**：本任务在分支开发；若自制更新器实机不稳，可临时保留旧 `updater.rs` + tauri-plugin-updater
  做后备（git 历史可恢复），但 PRD 已决定彻底清理，回滚=revert 分支。
- **体积**：Setup.exe 含 Python runtime 可能上百 MB，下载更新即全量。已知取舍（R7）。
