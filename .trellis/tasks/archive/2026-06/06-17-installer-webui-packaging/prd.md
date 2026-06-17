# v0.0.2 打包与安装器文案/资源打磨

## Goal

为 LingFang 桌面应用（apps/desktop，Tauri 2 + React）打包 v0.0.2 NSIS 安装包，本地验证可用，并在现有 R8 美化基础上把安装器文案与资源进一步打磨到可发布水平。

**范围收敛**：用户确认「暂不做 Web UI，先打包」。完全自定义 Web UI 安装器（原方案③）择期另开任务研究，**不纳入本任务**。

## 已确认事实（来自代码/配置查证）

- 打包命令：`pnpm -C apps/desktop build`（即 `tauri build`），目标 `["nsis"]`，`installMode: currentUser`，`createUpdaterArtifacts: true`。
- `tauri.conf.json` 已配 `bundle.windows.nsis`：`installerIcon` + `headerImage`(nsis-header.bmp 150×57) + `sidebarImage`(nsis-sidebar.bmp 164×314) + `languages: [SimpChinese, English]` + `displayLanguageSelector: true`。**本任务新增 `customLanguageFiles`**（覆盖 Tauri 自定义消息）。无 `template`/`installerHooks`。
- `customLanguageFiles` 语义（Tauri 源码 config.rs 查证）：`HashMap<String, PathBuf>`，key=语言名（必须在 `languages` 数组里），value=`.nsh` 文件路径。**只覆盖 Tauri 自定义消息**（版本冲突/webview2/快捷方式等 23 条），**不管 NSIS 标准页文案**（欢迎/目录/安装/完成由 NSIS 自带语言文件控制）。`.nsh` 内须 `!undef` + 重新 `LangString`（NSIS 不允许重复声明），用 `${LANG_SIMPCHINESE}` 常量。custom 文件在默认语言 .nsh 之后加载，覆盖生效。
- `license` 不在 `NsisConfig` 上，在 `BundleConfig` 顶层（`bundle.license` / `bundle.licenseFile`）。本任务不加 license。
- updater 签名链（见 `updater-integration.md` spec）：
  - 私钥 `.tauri/lingfang.key`（不入仓），pubkey 内嵌 `tauri.conf.json`。
  - 构建用 `TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri/lingfang.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build --bundles nsis`，产出 `LingFang_0.0.2_x64-setup.exe` + `.exe.sig`。
- 品牌资产：`tools/generate_logo.py` 用 PIL 绘 1024 主图标（靛蓝→紫→天蓝→青几何 L 标，深色底）。`icons/` 含全套 ico/icns/png + nsis header/sidebar bmp。
- 无 CI/CD，全靠本地打包。
- `resources` 映射 `../builtin-plugins` → `builtin-plugins`，必须随包打出。

## Requirements

- R1 执行 v0.0.2 打包：用正确的签名密钥环境变量跑 `tauri build --bundles nsis`，产出可用的 NSIS exe + updater 签名产物（`.exe` + `.exe.sig`）+ builtin-plugins 资源。✅
- R2 验证安装包：本地实际安装、启动应用、确认快捷方式/卸载入口/应用能正常打开；验证 updater 产物签名可用（结构与 spec 一致）。
- R3 安装器文案/资源打磨（轻量，不动 NSIS 结构）：在 R8 基础上用 `customLanguageFiles` 覆盖 Tauri 自定义消息中个别不地道措辞（`silentDowngrades` 的「安静安装」→「静默安装」）；**重绘 header/sidebar 位图**（R8 遗留缺陷：原位图是纯渐变色块，没绘 LingFang logo）。
- R4 不破坏 updater 签名兼容与 builtin-plugins resources 打包。✅

## 用户反馈问题（v0.0.2 首次安装验证）

1. **界面全英文** — 旧包观察，新包（无 customLanguageFiles）已恢复中文。
2. **图片和 logo 不一样** — ✅ 已修：R8 旧位图是纯色块（generate_installer_assets.py 的 L 标 alpha 绘制 bug），已用 generate_nsis_sidebar.py 重绘带 logo 位图，并删除旧脚本。
3. **删 sidebar 后文字全消失** — ✅ 已修：NSIS MUI2 欢迎页布局依赖 sidebar 位图，移除导致文字区域消失。恢复 sidebarImage（仅删顶部 header）。
4. **维护页单选按钮无文字** — ✅ 已修：根因是 customLanguageFiles 破坏 Tauri 自带简中加载（.nsh 的 !undef 干扰默认 SimpChinese.nsh 加载，模板无空值兜底）。移除 customLanguageFiles 后维护页「安装前卸载/请勿卸载」文字恢复。

## 最终配置（已验证可用）

```json
"nsis": {
  "installerIcon": "icons/icon.ico",
  "sidebarImage": "icons/nsis-sidebar.bmp",
  "installMode": "currentUser",
  "languages": ["SimpChinese", "English"],
  "displayLanguageSelector": true
}
```

- 顶部无 header 横幅（精简），欢迎页有 LingFang logo sidebar（保文字布局）。
- 无 customLanguageFiles（避免破坏简中加载）。
- 安装包：`target/release/bundle/nsis/LingFang_0.0.2_x64-setup.exe` + `.sig`，2026-06-17 11:17 构建。

## Acceptance Criteria

- [ ] `tauri build --bundles nsis` 成功产出 `LingFang_0.0.2_x64-setup.exe` + `.exe.sig`。
- [ ] 本地实际安装可正常完成，应用可启动，卸载入口正常。
- [ ] 安装界面显示品牌图标/横幅 + 简体中文（语言选择器生效）。
- [ ] updater 签名产物结构符合 `updater-integration.md` 契约（version/url/signature/pub_date）。
- [ ] builtin-plugins 资源正确打进安装包。
- [ ] 文案/资源打磨项落地并留痕（截图或说明）。

## Out of Scope

- 完全自定义 Web UI 安装器（方案③）——另开任务研究。
- 自定义 `.nsi` 模板 / `installerHooks`（动 NSIS 结构）。
- macOS / Linux 安装器（本期仅 Windows NSIS）。
- 应用内自动更新流程改造（保留 Tauri updater 静默安装）。
- 卸载器 UI 改造。
- CI/CD 自动打包流水线。

## Notes

- 本任务定为轻量任务，PRD-only。
- 打包依赖 Windows 环境 + Rust toolchain + `.tauri/lingfang.key` 私钥，构建耗时较长（首次可能 10+ 分钟）。
- 若 `.tauri/lingfang.key` 不在本地，需用户提供或确认密钥管理方式，否则无法产出签名安装包。
