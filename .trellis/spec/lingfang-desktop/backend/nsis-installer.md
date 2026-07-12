# NSIS 安装器与打包

> 2026-06-17 集成 v0.0.2 打包时沉淀。知识来自 Tauri 源码 config.rs / installer.nsi 模板 + NSIS 官方文档 + 实战构建。

## 打包命令

```powershell
# 仓库根目录（私钥在 .tauri/lingfang.key，不入仓）
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .\.tauri\lingfang.key -Raw)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""   # 无密码则空串
pnpm --filter @lingfang/desktop tauri build --bundles nsis
```

- 产物：`target/release/bundle/nsis/LingFang_<ver>_x64-setup.exe` + `.exe.sig`（updater 签名，见 [[updater-integration]]）。
- `createUpdaterArtifacts: true` → 自动产 `.sig`，签名密钥与 updater pubkey 配对（见 [[updater-integration]] 签名密钥管理）。
- `--bundles nsis` 限定只打 NSIS（跳过其他 bundle 类型）。
- 工作区 target 在仓库根 `target/`（非 `apps/desktop/src-tauri/target`），因 workspace 配置。

## NSIS 配置边界（NsisConfig，Tauri 源码查证）

`bundle.windows.nsis` 字段（`#[serde(rename_all = "camelCase")]`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `template` | `PathBuf?` | 自定义 `.nsi` 模板，替换整个安装脚本（Handlebars）。**动结构才用**。 |
| `installerHooks` | `PathBuf?` | `.nsh`，注入 `NSIS_HOOK_PREINSTALL`/`POSTINSTALL`/`PREUNINSTALL`/`POSTUNINSTALL` 宏。 |
| `installerIcon` / `headerImage` / `sidebarImage` | `PathBuf?` | 安装器图标 / 顶部横幅 150×57 / 欢迎完成页侧图 164×314。LingFang 已配（R8 美化）。 |
| `languages` | `Vec<String>?` | NSIS 语言名数组，默认 `["English"]`。LingFang: `["SimpChinese","English"]`。 |
| `displayLanguageSelector` | `bool` | 安装前弹语言选择器。LingFang: true。 |
| `customLanguageFiles` | `HashMap<String,PathBuf>?` | **只覆盖 Tauri 自定义消息**（见下）。 |
| `installMode` | enum | `currentUser`(默认)/`perMachine`/`both`。LingFang: currentUser。 |
| `compression` | enum | `lzma`(默认)/`zlib`/`bzip2`/`none`。 |

**`license` 不在 NsisConfig**，在顶层 `bundle.license` / `bundle.licenseFile`。

## sidebarImage 不可省略（实战踩坑）

- **删 `sidebarImage` 会导致安装器文字全部消失**（欢迎页文字区域被挤压成空白）。NSIS MUI2 欢迎页/完成页布局依赖 sidebar 位图占位，移除后布局崩坏。
- `headerImage`（顶部横幅）可安全删除，删除后顶部回归 NSIS 默认（精简）。
- LingFang 当前：**只配 `sidebarImage`（带品牌 logo），不配 `headerImage`**（顶部精简）。
- sidebar 位图由 `tools/generate_nsis_sidebar.py` 生成（164×314 24bpp，垂直渐变 + LingFang L 标 + 字样 + 副标题，内容集中在上部安全区，底部 ~40px 被按钮遮挡）。

## customLanguageFiles 禁用（实战踩坑）

- **`customLanguageFiles` 会破坏 Tauri 自带简中语言文件加载**，导致安装器维护页（PageReinstall）等所有 Tauri 自定义字符串变空。
  - 现象：第二页「安装前卸载/请勿卸载」单选按钮无文字（`$(uninstallBeforeInstalling)`/`$(dontUninstall)` 解析为空串）。
  - 根因：custom `.nsh` 经 installer.nsi 的 `language_files` 循环 `!include`，其 `!undef` 操作干扰 Tauri 默认 SimpChinese.nsh 的加载（Tauri v2.11.2 实测）。模板无 LangString 空值兜底，解析不到即空串。
  - Tauri v2.11.2 自带 SimpChinese.nsh **已完整定义**所有维护页字符串（`uninstallBeforeInstalling`="安装前卸载"等 13 条齐全），无需 customLanguageFiles 覆盖。
- **结论：LingFang 不使用 `customLanguageFiles`**。如需改 Tauri 自定义文案，改用 `template`（自定义 .nsi 整模板），不要用 customLanguageFiles。
- 机制备查（勿用）：`HashMap<语言名, .nsh 路径>`，只覆盖 Tauri 自定义消息（不管 NSIS 标准页文案）；覆盖语法须 `!undef` + 重新 `LangString`，常量 `${LANG_SIMPCHINESE}`（语言 ID 2052）。

## resources 打包约束

- `bundle.resources` 用 source→target 对象映射，如 `"../builtin-plugins": "builtin-plugins"`。
- `bundle.resources` 必须同时包含 `../builtin-plugins -> builtin-plugins` 与 `../runtimes -> runtimes`。正式包缺少 Python、Node.js、FFmpeg 或 Chromium 任一项都属于构建失败。
- 两条安装链只读取仓库 `apps/desktop/runtimes/`；构建不得联网下载或使用用户缓存。大型运行时作为普通 Git 文件提交，不使用 Git LFS；超过 Gitee 100 MB 单对象限制的文件必须由锁清单列出的 `apps/desktop/runtime-parts/` 固定分片在构建前离线原子还原。不得把 `runtime-parts/` 加入 Tauri/SFX resources，安装包只包含还原后的完整文件。
- `beforeDevCommand`、`beforeBuildCommand` 和发布脚本必须先运行 `runtime:prepare` 再运行 `runtime:verify`，校验分片还原结果、`runtime-lock.json` 的关键文件大小/SHA256以及 Playwright Chromium revision。
- **支持 glob 包含，不支持排除语法**（无 `!`/`exclude`）。要排除 `__pycache__` 等：要么用精确包含 glob（会丢目录结构），要么 `beforeBuildCommand` 预清理，要么源目录本身保持干净。
- builtin-plugins 必须打进包（quality.md 约束）：解包用 `7z l <exe>` 验证 `builtin-plugins/` 下各插件 manifest + 源码齐全。
- runtimes 体积较大，打包前应确认目录中只包含锁定的发布文件；不要包含下载压缩包或用户级配置。

## 验证清单（改 NSIS 配置后）

- [ ] `tauri build --bundles nsis` 成功，产出 exe + .sig。
- [ ] NSIS 编译零 warning/error（grep 日志 `warning|error|undefined`）。
- [ ] `7z l` 验证 builtin-plugins 资源齐全。
- [ ] `7z l` 验证 `runtimes/python/`、`runtimes/nodejs/` 资源齐全，包含可执行文件和 pip/npm/pnpm 入口。
- [ ] updater 签名产物结构符合 [[updater-integration]] 契约。
- [ ] 改 CSP/资源后跑 `pnpm -C apps/desktop vite:build` 验证前端不受影响（quality.md 约束）。
- [ ] 实际 GUI 安装跑一遍（语言选择器/向导/快捷方式/卸载入口）——AI 无法代劳，需人工。

## 完全自定义 Web UI 安装器（未采纳，留档）

方案③（外层 Web UI 引导 + 静默 NSIS）经评估未纳入 v0.0.2。命门：NSIS 静默模式（`/S`）**不输出进度**，外层 Web UI 要显示真实进度必须自定义 `.nsi` 模板往文件/注册表写进度标记再轮询——成本高且 updater 静默安装链路无法被 Web UI 替换。择期另开任务研究。
