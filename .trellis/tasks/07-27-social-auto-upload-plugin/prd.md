# social-auto-upload 社交媒体自动上传插件（保留原项目 + 内置 Chromium）

## Goal

把开源项目 [dreammis/social-auto-upload](https://github.com/dreammis/social-auto-upload)（自动化上传视频/图文到抖音、视频号、快手、小红书、B站、YouTube、百家号、TikTok）封装成一个 lingfang 桌面 Python 插件，提供图形界面完成「选平台 → 选素材 → 填标题标签 → 扫码登录 → 上传并看进度」。

两条硬约束：

1. **保留原项目**：social-auto-upload 的上传/登录/反检测逻辑原样 vendored 进插件，不重写、不改其业务源码；插件只做外壳（manifest + GUI + 浏览器重定向 shim + 依赖对齐）。
2. **Chromium 用软件内的**：浏览器一律使用 lingfang 桌面内置的 Chromium（revision 1228 / 149.0.7827.55），**不执行 `patchright install chromium`**、不联网下载浏览器、不依赖用户机器上的 Google Chrome。

## Requirements

### 功能

- R1 插件以 PySide6 图形界面运行（与现有 rbflow-video 等插件一致），runtime_type=python。
- R2 支持 social-auto-upload 当前主线支持的全部平台：抖音、视频号（腾讯）、快手、小红书、B站、YouTube、百家号、TikTok。每个平台至少支持「视频上传」；原项目支持图文（笔记）的平台（抖音/快手/小红书）同时支持图文。
- R3 账号登录：每个平台支持扫码登录，二维码渲染在插件窗口内；登录态（cookie）持久化，重启插件后免登录复用。
- R4 上传表单：选择视频/图片文件、标题、描述/正文、标签、封面（原项目支持的字段）、发布方式（立即 / 定时）。字段按各平台上游能力呈现，缺省字段可留空。
- R5 上传进度与结果反馈：实时显示上传状态/日志，成功/失败有明确提示与错误信息。
- R6 多账号：同一平台可管理多个账号（账号名区分），可切换当前账号。

### 浏览器 / 运行时

- R7 浏览器必须命中软件内置 Chromium（revision 1228）。通过 pin `patchright==1.61.x`（其期望 revision 恰为 1228）+ 软件注入的 `PLAYWRIGHT_BROWSERS_PATH` 实现；插件运行全程不下载浏览器。
- R8 对上游硬编码 `channel="chrome"` 的路径（如抖音 cookie 校验），通过插件 wrapper 的运行时 launch-hook 重定向到内置 Chromium，**不修改上游源码文件**。
- R9 插件依赖通过平台首启 `pip install -r requirements.txt` 安装（清华镜像）；requirements.txt 不含平台 AI 政策禁止的第三方模型 SDK。
- R10 持久状态（cookie、日志、临时二维码）一律写入插件 `data/` 目录，不污染不可变的 vendored 项目目录；vendored 目录内不产生运行时写文件。

### 打包 / 合规

- R11 能用 SDK CLI 构建出合法 `.lfplugin` v4 制品并通过 `lingfang-plugin validate`；manifest 能力声明与实际调用一致。
- R12 制品不含 `.venv`、`data/`、`__pycache__`、缓存、用户文件或本机绝对路径。
- R13 插件源码、manifest、README、日志中不含任何 API Key / JWT / 桥 token / 供应商 URL。

## Acceptance Criteria

- [ ] `plugins/social-auto-upload/` 含 manifest.json（runtime_type=python）、main.py（PySide6 GUI）、requirements.txt、README.md、vendored 的 `social-auto-upload/` 原项目。
- [ ] vendored 的 social-auto-upload 业务源码与上游一致（除新增的 conf.py 与文档说明的 shim 外，不改上游 .py 业务逻辑）；能指出上游 commit 版本。
- [ ] requirements.txt 中 `patchright==1.61.x`，且插件运行时浏览器命中内置 chromium-1228（日志/可执行路径可证），无浏览器下载行为。
- [ ] 抖音、视频号至少一个平台能端到端跑通：扫码登录 → cookie 持久化 → 选视频填标题 → 上传成功（或在上游已知限制内给出明确错误）。其余平台 UI 可达、登录/上传调用链接通。
- [ ] 抖音 cookie 校验路径（channel="chrome"）经 launch-hook 改用内置 Chromium，机器无系统 Chrome 也能完成校验。
- [ ] cookie/日志/二维码均落在 `data/` 下；vendored 目录运行后无新增运行时文件。
- [ ] `pnpm -C packages/plugin-sdk exec lingfang-plugin validate plugins/social-auto-upload` 通过；`lingfang-plugin build` 产出 .lfplugin 成功。
- [ ] 在桌面端导入插件可启动 GUI，能力声明与实际调用一致。

## Out of Scope（本任务不做）

- 不改 lingfang 桌面 Rust（如给 declares_playwright 加 patchright 匹配）——保持插件自包含；如需要另起小任务。
- 不集成 sau_backend / sau_frontend（上游自带的 Web 后端/前端），插件自带 GUI。
- 不接入平台 AI 能力（本插件不做文案生成等 LLM 功能）。
- 各平台反检测/风控规避的额外增强（沿用上游既有策略）。

## Notes

- 研究见 `research/chromium-bundling.md`、`research/social-auto-upload-integration.md`。
- 技术设计见 `design.md`；执行计划见 `implement.md`。
