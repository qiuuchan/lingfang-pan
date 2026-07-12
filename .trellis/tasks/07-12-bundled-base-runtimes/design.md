# Design: 安装包内置完整基础运行时

## 1. Scope And Invariants

- 仅支持 Windows x64 正式发布。
- 唯一执行来源是安装包内置的 `runtimes/`，不探测或回退系统 `PATH`，不读取旧 runtime config 作为执行来源。
- Node.js、Python、FFmpeg、Chromium 缺少任一关键文件都视为安装损坏；构建阶段和运行时状态页都必须明确暴露。
- 大型二进制作为普通 Git 文件提交（不使用 Git LFS）；超过 Gitee 100 MB 单对象限制的文件以固定分片提交，并在开发/构建入口离线原子还原。构建不得以联网下载作为前置条件。

## 2. Version Manifest And Prepared Layout

新增仓库内清单 `apps/desktop/runtimes/runtime-lock.json`，固定每个制品的版本、来源、SHA256、目录和关键文件哈希。初始版本沿用当前兼容线：

- Node.js `22.21.1` Windows x64，含 npm；准备阶段启用并固定 pnpm。
- Python `3.12.13` python-build-standalone install-only，必须含 `venv`、`ensurepip` 和 pip wheel。
- FFmpeg 采用固定版本的 Windows x64 static/shared-free build，至少含 `ffmpeg.exe`、`ffprobe.exe` 及运行所需 DLL。
- Chromium 与仓库锁定的 Playwright `1.61.1` 对齐：revision `1228`、browser version `149.0.7827.55`；包含 Playwright 所需的 full Chromium 与 headless shell。

仓库与安装包共用的唯一布局：

```text
apps/desktop/runtimes/
  nodejs/node.exe, npm.cmd, pnpm.cmd, ...
  python/python.exe, Scripts/pip.exe, Lib/ensurepip/_bundled/..., ...
  ffmpeg/ffmpeg.exe, ffprobe.exe
  chromium/ms-playwright/chromium-1228/chrome-win64/chrome.exe
  chromium/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe
  runtime-lock.json
```

`runtime-lock.json` 随运行时提交，供开发启动、两条打包链及产物验证共用。`materializedFiles` 记录需从同级 `apps/desktop/runtime-parts/` 普通 Git 分片还原的目标路径、分片列表、大小和 SHA256；两条安装链只复制 `runtimes/`，因此安装包只包含还原后的完整文件，不重复携带分片。

## 3. Build Pipeline

保留 `tools/prepare-runtimes.ps1` 作为维护者显式升级/重建运行时的工具，而不是日常开发和打包前置步骤：

1. 读取版本清单，下载到 `.runtime-cache/windows-x64/downloads`，命中缓存仍重新校验 SHA256。
2. 解压到临时 staging，拒绝路径穿越，并归一化到上述布局。
3. 执行关键命令和版本探测；Chromium 校验 Playwright revision 目录及两个入口。
4. 原子替换 `apps/desktop/runtimes` 并生成 `runtime-lock.json`，随后由维护者审阅并提交全部变更。

`beforeBuildCommand` 只验证仓库内运行时后构建前端，不联网下载。官方 NSIS 的 `bundle.resources` 将仓库 `runtimes` 映射到 `runtimes`；自制 SFX 从同一目录复制。任何校验失败都中止构建。

新增 `tools/verify-bundled-runtimes.ps1`，既可验证仓库 `apps/desktop/runtimes`，也可验证安装/staging 目录；打包脚本在发布产物生成前强制调用。

## 4. Runtime Resolution

`RuntimeResolver` 恢复单一 `Bundled` 来源，查找优先级：

1. 测试/开发显式覆盖 `LINGFANG_EMBEDDED_RUNTIME_DIR`。
2. 可执行文件同级 `runtimes/`（自制 SFX 安装布局）。
3. Tauri `resource_dir()/runtimes`（官方 NSIS 布局）。
4. debug 构建的仓库 `apps/desktop/runtimes`。

Resolver 新增 Chromium 字段和 `chromium()`；命令映射覆盖 `chromium`、`chrome`、`chrome.exe`。受控 PATH 包含 Node、Python、FFmpeg、Chromium 与必要 Windows 系统目录，但不包含宿主用户 PATH。

所有插件子进程注入：

- `PLAYWRIGHT_BROWSERS_PATH=<bundled>/chromium/ms-playwright`
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`

`ensure_playwright_browsers` 改为只校验内置 revision，不再调用 `playwright install`。版本不匹配时报明确的“插件 Playwright 版本与应用内置 Chromium 不兼容”，不能联网补装。

## 5. Configuration And UI

- 删除 `runtime_download.rs` 及其 Tauri 下载命令。
- 删除 runtime config 中用户指定、应用下载和下载镜像字段；pip/npm 镜像仍可作为固定的子进程环境常量存在，但设置页不提供运行时来源切换。
- 删除 `RuntimeSetupGate` 和首次启动下载引导。
- `get_runtime_status` 返回四项只读状态：`available`、`version`、`binaryPath`、`error`、`source='bundled'`。
- `RuntimeEnvTab` 只展示 Node.js、Python、FFmpeg、Chromium 的识别状态、版本和路径，无操作按钮。

## 6. Plugin Development Coverage

统一 Resolver 是以下路径的唯一运行时入口：持久化插件启动、内置脚本插件启动、草稿预览、创建器代码执行、Python venv 创建与 pip 安装、Node 依赖安装与 scripts、Agent `run_command`/shell、Playwright 浏览器启动。任何路径不得裸调用宿主 `python`、`node`、`npm`、`pnpm`、`ffmpeg`、`chrome` 或 `chromium`。

## 7. Update And Compatibility

- 每个正式安装/更新包都携带完整运行时，升级后运行时与应用版本原子对齐，不复用旧版本目录作为真相源。
- 旧 `%LOCALAPPDATA%/LingFang/runtimes` 和 runtime config 不再读取；为避免误删用户数据，本任务不主动删除，后续可单独做清理迁移。
- Python 插件 venv 与 Node 插件 `node_modules` 继续保留；若解释器 ABI 或 Node major 变化，既有自愈/重装逻辑负责刷新依赖。

## 8. Validation And Rollback

- Rust 单测覆盖四类解析、命令映射、PATH、Playwright 环境和缺失文件错误。
- 前端测试覆盖四项只读状态和无操作入口。
- Windows 发布机执行两条打包链、资源清单检查及干净虚拟机离线 smoke test。
- 回滚时可恢复按需下载提交，但发布回滚必须连同旧安装包整体回滚，不能混用运行时清单。

## 9. Trade-offs

- 安装包显著增大，换取离线和一致性；用户已确认不设体积上限。
- Playwright 1.61.1 需要 full Chromium 与 headless shell，二者都放在一个 managed browser root 下，避免用户缓存再次安装。
- 仓库 clone 与 checkout 体积显著增加，换取跨开发机零准备和完全离线构建；运行时升级必须作为显式、可审阅的仓库变更。
- 普通 Git 会永久增加仓库历史体积；用户确认沿用此前可推送的直接提交方式，不引入 Git LFS 前置依赖。
