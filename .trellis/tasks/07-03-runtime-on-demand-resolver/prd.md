# 移除内置运行时改为按需下载与统一Resolver

## Goal

把桌面端（apps/desktop）打进安装包的内置 Python 3.12 / Node 22 运行时（`apps/desktop/runtimes/`，约 200MB）移除，改为应用按需下载便携版到用户目录；运行时解析层升级为统一 Resolver，所有 Python/Node 调用（含 Agent 工具链）一律走它，保证「应用一定用自己管理的运行时」；镜像源加 UI、可配，仅注入本应用子进程；插件层零改动无感切换。

## Confirmed Facts（现状）

- `apps/desktop/runtimes/python`（CPython 3.12.13）和 `runtimes/nodejs`（Node 22.21.1）直接打进安装包；`tools/build-installer.ps1:67` 复制到 exe 同级，`tauri.conf.json:17-20` 声明为 resource。
- `embedded_runtime.rs` 只查内置目录、**完全不探测系统 PATH**；`env()` 还会清掉宿主 PATH，只注入内置路径 + 硬编码镜像源（清华 PyPI / npmmirror）。
- `CliRuntimeTab.tsx:12` 注释明确「运行时只能来自应用包内的 runtimes/ 目录；不再引导安装或使用系统 Node/Python」——纯内置是此前有意为之。
- `probe_script_runtime`（`plugin_script.rs:113`）只跑 `--version` 取字符串，无 semver 比较。
- 所有 Python/Node 进程调用都已收敛到 `EmbeddedRuntime::require_runtime_command()`，**无任何裸调系统命令的代码路径**（`plugin_runner.rs` / `plugin_script.rs` 的 `Command::new(&binary)`，binary 全部来自 resolver）。
- 镜像源硬编码在 `embedded_runtime.rs:6-12`，无 UI、不可配、不写系统全局。
- 平台仅 Windows x64；持久化前端走 localStorage（`lf:` 前缀），Rust 侧 plugin_store 有 `PluginStoreConfig` 锚点模式（`app_data_dir/plugins/.lingfang/config.json`）。

## Decisions（用户已确认）

- **内置运行时**：完全移除。
- **安装方式**：应用内下载便携版到 `%LOCALAPPDATA%/LingFang/runtimes/`，不污染系统、不需 UAC。
- **运行时来源**：Resolver 严格按 config 解析，**系统 PATH 永不作为执行来源**（仅作信息展示）。
- **镜像源**：UI 选源（清华/阿里/腾讯/华为 + 自定义），仅注入本应用子进程。
- **插件接入**：Resolver 升级，插件/Agent 无感。
- **版本门槛**：Python ≥ 3.10、Node ≥ 18。
- **开发态**：dev 也走下载（下载到 `<repo>/apps/desktop/.local-runtimes/`，gitignore），dev/生产代码路径一致。
- **系统已有合资格本**：默认走应用下载；设置页提供「使用我电脑上已安装的」opt-in（手动指定路径，仍经 Resolver，source=UserSpecified）。
- **预装依赖（preset）**：MVP 放弃；每个插件按自身 `requirements.txt` / `package.json` 装。P1 再做基础包预装加速。

## Requirements

- 移除安装包内置运行时：删除 `apps/desktop/runtimes/`，从 `build-installer.ps1` 和 `tauri.conf.json` 去掉打包引用，安装包瘦身约 200MB。
- 运行时解析层升级：`embedded_runtime.rs` 重构为 `runtime_resolver.rs`，支持 AppManaged / UserSpecified 两类来源，严格按 config 解析、不查系统 PATH；`env()` 从 config 读镜像源、删除硬编码常量。公开 API 签名不变，调用方零改动或最小改动。
- 运行时下载管线：新增下载 / 校验（SHA256）/ 解压 / 原子落盘 / 激活 / 进度上报；支持 Python（python-build-standalone）和 Node（官方 zip + npmmirror 加速）；失败重试。
- 镜像源配置：预置国内几家源 + 自定义；持久化到 `runtime-config.json`；设置页 UI 选源。
- 设置页改造：`CliRuntimeTab` → 环境管理页（运行时状态 + 来源 + 下载/卸载/指定路径 + 镜像源 + 下载进度）。
- 首次启动引导：node+python 都缺时弹引导卡（一键下载 / 跳过先用 client 插件），不阻塞基础功能。
- 配置持久化：`runtime-config.json`（`%LOCALAPPDATA%/LingFang/runtimes/.lingfang/`），Rust 真相源。
- Agent/创建器收敛：所有 Python/Node 调用经 Resolver；系统 PATH 不作为执行来源。

## Acceptance Criteria

- [ ] 安装包不再含 `runtimes/`，体积下降约 200MB；冷启动时若运行时未就绪，弹出 RuntimeSetupGate 引导。
- [ ] 引导卡一键下载 Python + Node，进度条走完，状态变「应用管理 · vX」；下载完成即激活，Resolver 命中。
- [ ] 创建一个 `requirements.txt` 含 requests 的 Python 插件，RunPlugin 能用应用管理的 venv 装包并运行；改 pip 镜像源后新建 venv 用新源。
- [ ] 创建一个 nodejs 插件（package.json 含 start），持久化运行成功。
- [ ] 卸载某运行时后，对应类型插件运行报 RuntimeMissing 引导下载，**不静默回退系统 PATH**。
- [ ] 设置页手动指定系统已装 Python 路径，状态变「用户指定」，Python 插件用它跑通（opt-in 复用）。
- [ ] Agent 创建器让 AI 写并运行 Python 插件，进程路径来自应用管理运行时，不是系统 python。
- [ ] 现有 builtin-plugins（calculator/python、2048/nodejs、notes/client）全部回归通过。
- [ ] `cargo test` 通过（resolver 优先级/降级、下载校验、env 镜像切换）。

## Out Of Scope

- Mac/Linux 运行时获取（brew / 系统 python / 官方 pkg）——后续若支持需另设计。
- 预装依赖（preset 基础包）——P1。
- 多版本共存 + 默认版本切换——P1。
- 自建 CDN 镜像 python-build-standalone——P1。
- 下载断点续传的完整稳健性（MVP 实现基础 Range 支持，深度优化 P1）。

## Open Questions

- 无阻塞性开放问题（开发态已确认走下载；其余 trade-off 已定）。

## Notes

- 详细技术设计与执行清单见 `design.md` / `implement.md`。
- 完整方案背景见 `C:\Users\znc15\.claude\plans\python-nodejs-python-nodejs-staged-mango.md`。
