# Implement — 自制 Windows 安装/更新/卸载器替换 Tauri

关联：`prd.md`（R1–R10、验收）+ `design.md`（§1–§11）。按阶段执行，每阶段可独立验证。

## 阶段顺序总览

1. 后端 sha256 + 端点清理（独立、可先做、风险低）
2. 前端 admin 对齐 sha256
3. installer crate 骨架 + 自解压核心（纯逻辑，单测）
4. installer 各模式（install / silent / update / uninstall）
5. 主程序 update.rs + 清理 tauri-plugin-updater
6. 前端桌面更新 UI 对接 + 启动静默检查
7. Tauri 配置清理 + 打包脚本
8. 实机端到端验证

---

## 阶段 1：后端 sha256 + 清理 tauri-update

- [ ] `schema.prisma`：`ReleaseAsset` 加 `sha256 String @default("")`。
- [ ] 生成 migration：`pnpm --filter @lingfang/collab-api prisma migrate dev --name asset_sha256`
      （确认 workspace 包名；若非该名用实际包名）。
- [ ] `release.service.ts`：
  - `uploadAsset()` 写文件后算 sha256（`createHash('sha256')`，buffer 模式 update buffer，
    disk 模式流式读 filePath）存入 asset；移除读 `.sig` 逻辑（sigFile 参数可保留签名但停用，倾向删参数）。
  - `publicAsset()` 出参加 `sha256`。
  - 删 `tauriManifest()` 方法。
- [ ] `release.controller.ts`：删 `@Get('tauri-update')` 路由 + `ReleaseTauriQueryDto`/`requestBaseUrl` 相关 import（按需）。
- [ ] `dto/release.dto.ts`：删 `ReleaseTauriQueryDto`；`ReleaseAssetCreateDto.signature` 删（或保留兼容，倾向删）。
- [ ] `release-url.ts`：若 `absoluteUpdateAssetUrl` 仅 tauriManifest 用 → 删 + 删 `release-url.spec.ts` 对应用例；
      若 latest 出参也用相对→绝对则保留。**先 grep 确认引用点再删。**
- [ ] `release.service.spec.ts`：删 tauriManifest 用例，加 uploadAsset sha256 断言。

**验证**：`pnpm --filter <collab-api> test`（release 相关 spec 通过）；`pnpm --filter <collab-api> build`。

## 阶段 2：前端 admin 对齐

- [ ] `apps/collab-admin/src/lib/releases.ts`：`ReleaseAsset` 加 `sha256: string`；
      `uploadAsset()` 去掉 `sigFile` 参数与 `form.append('signature')`；`AssetCreateInput.signature` 删；
      `PLATFORM_META.WINDOWS.ext` 改 `.exe`。
- [ ] admin 发布页组件：移除 `.sig` 文件选择 UI，新增 sha256 展示（grep `uploadAsset(` 找调用页）。

**验证**：`pnpm --filter <collab-admin> build`（typecheck 通过）。

## 阶段 3：installer crate 骨架 + 自解压核心

- [ ] 根 `Cargo.toml` workspace members 加 `"apps/desktop/installer"`。
- [ ] 新建 `apps/desktop/installer/Cargo.toml`（依赖见 design §3）+ `src/main.rs`。
- [ ] `src/sfx.rs`：自解压尾部格式（design §2）。
  - `const MAGIC: [u8;8]`、`Trailer { magic, payload_len }`。
  - `read_trailer(path) -> Option<Trailer>`、`payload_offset(file_len, payload_len) -> u64`。
  - `extract_payload(exe_path, dest_dir)`：定位偏移 → zip crate 解压。
- [ ] `src/integrity.rs`：`verify_sha256(path, expected_hex) -> bool`（流式 sha2）。
- [ ] `src/paths.rs`：`default_install_dir()`（`%LOCALAPPDATA%\LingFang`）、`resolve_install_dir(arg)`。
- [ ] `src/cli.rs`：参数解析分派四模式（不引 clap 也可，手写 match argv，保持轻量；或用 clap）。
- [ ] **单测**（PRD 验收）：trailer 往返、payload_offset 计算、verify_sha256 命中/不命中、install_dir 解析。

**验证**：`cargo test -p lingfang-installer`。

## 阶段 4：installer 各模式

- [ ] `src/platform/windows.rs`：
  - `create_shortcut(target, lnk_path, icon)`（IShellLinkW + IPersistFile，COM init）。
  - `write_uninstall_key(...)` / `delete_uninstall_key()`（HKCU Uninstall，design §4）。
  - `wait_for_pid(pid, timeout)`（OpenProcess + WaitForSingleObject）。
  - `kill_running(exe_name)`（卸载前关主进程；可用 sysinfo 或 ToolHelp，src-tauri 已用 windows-sys ToolHelp 可参考）。
  - `schedule_self_delete()`（临时 updater 副本自删）。
- [ ] `src/modes/install.rs`（egui）：选目录 → 进度 → `extract_payload` → 快捷方式 → 注册表 → 落 updater.exe 副本。
- [ ] `src/modes/silent.rs`：无 UI 解压覆盖到 `--target`。
- [ ] `src/modes/update.rs`：`wait_for_pid` → 运行 `--setup --silent --target` → 删临时 setup → `--restart` 拉起 → 自删。
- [ ] `src/modes/uninstall.rs`（egui 确认）：关进程 → 删文件/快捷方式/注册表 → 自删。
- [ ] release 构建设 `windows_subsystem = "windows"`。

**验证**：`cargo build -p lingfang-installer --release`；裸 exe 手测 `installer.exe uninstall` 不崩（无 payload 分支）。

## 阶段 5：主程序 update.rs + 清理 updater 插件

- [ ] 删 `apps/desktop/src-tauri/src/updater.rs`。
- [ ] 新增 `src/update.rs`：`check_update` + `download_update`（design §5）。复用 reqwest（已在依赖）+ Channel + sha2。
      sha2 加入 src-tauri Cargo.toml（或复用 minisign 传递依赖？显式声明 sha2 更稳）。
- [ ] `main.rs`：删 `mod updater` / `tauri_plugin_updater` 插件注册 / `PendingUpdate` State /
      旧命令注册；加 `mod update` + 新命令注册。
- [ ] `src-tauri/Cargo.toml`：删 `tauri-plugin-updater`、`url`；按需加 `sha2`。保留 `minisign-verify`。

**验证**：`cargo build -p lingfang-desktop`；`cargo test -p lingfang-desktop`（update.rs 的 url 拼接/平台映射纯函数单测沿用）。

## 阶段 6：前端桌面更新 UI 对接

- [ ] `apps/desktop/src/lib/updater.ts`：`UpdateMetadata` 加 `downloadUrl`/`sha256`；
      `checkUpdate`/`downloadAndInstall` 对接新命令（事件类型 Started/Progress/Finished 不变）。
- [ ] `Settings.tsx`：检查更新逻辑沿用，确认入参/出参字段对齐。
- [ ] `App.tsx`：启动后台静默 `checkUpdate`，有更新非阻塞提示 + `sessionStorage` 防重复（R9）。

**验证**：`pnpm --filter <desktop> build`（vite typecheck）。

## 阶段 7：Tauri 配置 + 打包脚本

- [ ] `tauri.conf.json`：删 `plugins.updater`、`createUpdaterArtifacts`、`windows.nsis`、`installerHooks`；
      `bundle.targets` 处理（去 nsis）。
- [ ] 删 `src-tauri/nsis/installer-hooks.nsh`（及空目录）。
- [ ] `tools/build-installer.ps1`：
  1. `cargo build --release -p lingfang-desktop`（+ 前端 `pnpm vite:build`）。
  2. `cargo build --release -p lingfang-installer`。
  3. 收集 app 文件（desktop exe + runtimes/ + builtin-plugins/ + icons）到 staging。
  4. zip staging（含 updater.exe = installer.exe 副本）。
  5. 拼接 `installer.exe + zip + trailer` → `LingFang-Setup-{version}.exe`。
  6. 输出 sha256（供核对）。

**验证**：脚本跑通产出 Setup.exe；文件大小合理（含 runtime）。

## 阶段 8：实机端到端验证（PRD 最后验收）

- [ ] 全新机器/干净目录：双击 Setup.exe → egui 安装 → 快捷方式 + 注册表项出现。
- [ ] 启动主程序：内置插件/runtime 正常。
- [ ] 制造一个高版本号发布（admin 上传新 Setup.exe，自动算 sha256）→ 主程序检查更新 →
      下载 + 校验 + updater 覆盖 + 重启到新版本。
- [ ] 篡改测试：故意改坏 sha256 → 主程序拒绝安装并报错。
- [ ] 控制面板「添加删除程序」卸载 → 文件/快捷方式/注册表清除干净。

---

## 风险文件 / 回滚点

- `apps/desktop/src-tauri/src/main.rs`：命令注册改动，改错会编译失败（编译器兜底）。
- `schema.prisma` + migration：DB 变更，回滚需 migrate down 或手动；先在 dev 库验证。
- `release.service.ts` uploadAsset：现有上传逻辑，改动影响发布；保留旧测试对照。
- 自更新覆盖文件（update 模式）：实机行为不确定性最高，杀软/占用风险，阶段 8 必须实机过。
- 整个任务在 feature 分支开发；不可逆的「删 tauri-plugin-updater」可由 git revert 恢复。

## 验证命令汇总

- 后端：`pnpm --filter <collab-api> test` + `build`
- admin：`pnpm --filter <collab-admin> build`
- desktop 前端：`pnpm --filter <desktop> build`
- Rust：`cargo build`（workspace）、`cargo test -p lingfang-installer`、`cargo test -p lingfang-desktop`
- 打包：`pwsh tools/build-installer.ps1`

> 待办（start 前确认）：collab-api / desktop / collab-admin 的实际 pnpm 包名（用于 --filter），
> 在阶段 1 开始时 `grep '"name"' apps/*/package.json` 确认。
