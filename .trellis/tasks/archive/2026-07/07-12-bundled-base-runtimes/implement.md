# Implement: 安装包内置完整基础运行时

## Step 1: Versioned Runtime Assets

- [x] 恢复 `apps/desktop/runtimes/` 并加入完整 Node/Python/FFmpeg/Chromium Windows x64 运行时。
- [x] 新增 runtime lock，固定制品来源、版本、SHA256 和关键文件哈希。
- [x] 新增维护者用 `prepare-runtimes.ps1`，支持显式刷新锁定的 Windows Chromium；日常构建不调用下载。
- [x] 新增跨平台 `verify-bundled-runtimes.mjs`，验证四类运行时关键文件、版本和 Playwright revision。
- [x] 直接以普通 Git 对象跟踪运行时文件，不添加 Git LFS attributes。
- [x] 对超过 Gitee 100 MB 单对象限制的 Chromium 文件提交固定分片，并在开发和构建入口离线原子还原。
- [x] 验证脚本可重复运行，并在前端/发布构建前强制执行。

## Step 2: Bundle Both Windows Installers

- [x] `tauri.conf.json` 恢复仓库 `runtimes` resource，并把只读 verifier 接入 `beforeBuildCommand`。
- [x] `build-nsis.ps1` 在发布前调用 runtime verifier。
- [x] `build-installer.ps1` 从同一仓库目录复制 `runtimes/` 并校验 staging。
- [x] 两条构建链缺失任何资源时失败，并输出具体 runtime/文件名。

## Step 3: Restore Bundled-Only Resolver

- [x] 将 `RuntimeSource` 收敛为 `Bundled`，恢复 override/exe sibling/Tauri resource/debug 仓库路径解析。
- [x] 增加 Chromium/Chrome 命令解析；统一注入 Node/Python/FFmpeg/Chromium 与 Windows 系统目录到受控 PATH。
- [x] 注入 bundled `PLAYWRIGHT_BROWSERS_PATH` 和 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`。
- [x] `ensure_playwright_browsers` 改为离线校验，不再触发下载；不兼容 revision 返回结构化错误。
- [x] 删除 AppManaged/UserSpecified 执行分支和旧 runtime config 读取。
- [x] 审计插件启动、内置插件、草稿预览、创建器、依赖安装、Agent shell/`run_command`，并拒绝 Playwright 浏览器安装旁路。

## Step 4: Remove Download And Override Product Paths

- [x] 删除 runtime 下载、卸载、系统探测、自定义路径和镜像配置相关 Tauri 命令及无用模块。
- [x] 删除 `RuntimeSetupGate`、首次启动下载引导和相关 localStorage 状态。
- [x] 将 runtime status 扩为 Node/Python/FFmpeg/Chromium 四项只读探测。
- [x] 重构 `RuntimeEnvTab` 为只读状态视图，移除全部操作控件和下载进度状态。
- [x] 清理错误文案，统一指向“安装包不完整/请重新安装”，不再提示下载或指定路径。

## Step 5: Tests And Release Verification

- [x] 更新 Rust resolver、plugin runner、plugin shell 和 status command 测试。
- [x] 更新前端 runtime API/UI/onboarding 契约。
- [x] 运行 `cargo test -p lingfang-desktop`。
- [x] 运行 `pnpm -C apps/desktop test`、`typecheck`、`vite:build`。
- [ ] 在 Windows 发布机运行 `prepare-runtimes.ps1`、两条安装包构建和资源 verifier。
- [ ] 在未安装 Node/Python/FFmpeg/Chrome 的干净 Windows x64 虚拟机完成离线命令与 Node/Python Playwright smoke test。

## Step 6: Permanent Project Contract

- [x] 更新 `nsis-installer.md`：正式安装包必须内置四套 runtime，禁止按需下载作为默认发布策略。
- [x] 更新 `plugin-runtime-persistence.md` 和前端 runtime spec：bundled-only 来源、Chromium/Playwright 契约、只读状态 UI。
- [x] 检查 README/架构文档中“按需下载”描述并同步。

## Validation Commands

```powershell
pwsh tools/verify-bundled-runtimes.ps1 -RuntimeRoot apps/desktop/runtimes
pwsh tools/build-nsis.ps1
pwsh tools/build-installer.ps1
```

```bash
cargo test -p lingfang-desktop
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
```

## Risk And Rollback Points

- Runtime manifest/checksum changes are the supply-chain boundary; review independently before accepting new binaries.
- Playwright upgrade requires Chromium revision update in the same change; verifier must reject drift.
- Resolver and UI removal should land only after both packaging paths consume repository runtimes.
- Keep each step independently reviewable; rollback uses the previous complete installer rather than mixing application and runtime versions.
