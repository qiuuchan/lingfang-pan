# 内置 Chromium 与 patchright 兼容性研究

## 软件内置 Chromium 机制（apps/desktop/src-tauri）

### 位置与版本

- `runtime_resolver.rs`:
  - `PLAYWRIGHT_CHROMIUM_REVISION = "1228"`
  - `PLAYWRIGHT_CHROMIUM_VERSION = "149.0.7827.55"`
  - 内置浏览器目录：`<bundled_root>/chromium/ms-playwright/`
  - 可执行文件：
    - `ms-playwright/chromium-1228/chrome-win64/chrome.exe`
    - `ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe`
- `chromium_runtime_complete()` 校验上述两个文件都存在才算完整。

### 环境变量注入（无条件，所有插件进程）

`RuntimeResolver::env()`（runtime_resolver.rs:247）对**每个**插件进程注入：

- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`（禁止浏览器库联网下载浏览器）
- `PLAYWRIGHT_BROWSERS_PATH=<bundled>/chromium/ms-playwright`（当内置 chromium 存在时）
- 同时清空宿主 PATH，重建受限 PATH（含 python/node/ffmpeg + System32）。

> 关键：这两个变量**无条件注入**，不依赖插件是否声明 playwright。

### Playwright 检测与预校验（plugin_runner.rs）

- `declares_playwright(plugin_dir)`：仅匹配 `playwright` / `playwright-core` / `@playwright/test`（Node）或 `playwright`（Python requirements.txt）。**不匹配 `patchright`**。
- `ensure_playwright_browsers()`：仅当 `declares_playwright()` 命中时，预校验内置 chromium-1228 是否完整；未命中则直接 `Ok(())` 跳过。
- 结论：patchright 插件不会触发预校验（无害），但 env 变量仍被注入，运行时仍能命中内置浏览器。预校验只是「提前报友好错误」，非运行必需。

## patchright 版本 ↔ chromium revision 映射（实测确认）

| 库版本                                  | chromium revision | browserVersion                      |
| --------------------------------------- | ----------------- | ----------------------------------- |
| playwright/patchright 1.58.x            | 1208              | 145.0.7632.6                        |
| playwright 1.59.x                       | ~1216             | 147.0.7727.15                       |
| playwright 1.60.x                       | 1223              | 148.0.7778.96                       |
| **playwright/patchright 1.61.0–1.61.1** | **1228**          | **149.0.7827.55** ✅ 与内置完全一致 |
| playwright main(1.61+)                  | 1231/1232         | 150.0.7871.46                       |

**结论：pin `patchright==1.61.1` + `playwright==1.61.0`，二者期望的 chromium revision 恰为 1228，与软件内置完全一致。**
注意 PyPI 可用性：`playwright` 只发布到 **1.61.0**（无 1.61.1）；`patchright` 有 1.61.1/1.61.2。故取 patchright==1.61.1 + playwright==1.61.0。
配合软件注入的 `PLAYWRIGHT_BROWSERS_PATH`，二者直接命中 `chromium-1228`，**无需 `patchright install chromium`**。

验证来源：`raw.githubusercontent.com/microsoft/playwright/v1.61.0/packages/playwright-core/browsers.json` → revision 1228 / 149.0.7827.55。

### 本机实测验证（2026-07-27，Phase 1 go/no-go 通过）

- 内置运行时实际路径：`C:\Users\znc15\AppData\Local\LingFang\runtimes\`（含 `chromium/ms-playwright/chromium-1228`、`python/python.exe`=3.12.13、无内置 uv）。
- 用内置 python 3.12 建 venv，装 `patchright==1.61.1` + `playwright==1.61.0`，读各自 `driver/package/browsers.json` → 均 chromium revision **1228** / 149.0.7827.55。
- 设 `PLAYWRIGHT_BROWSERS_PATH=<内置>/chromium/ms-playwright` + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`：
  - patchright/playwright 默认 `launch()` → `browser.version == 149.0.7827.55`，`executable_path == ...\chromium-1228\chrome-win64\chrome.exe`，**无下载**。SMOKE_OK。
  - 不 hook 时 `launch(channel="chrome")` → 启动**系统 Chrome 150**（本机已装），证明 channel 路径会绕过内置浏览器。
  - hook（去 `channel` + 注入内置 `executable_path`）后 `launch(channel="chrome")` → 启动内置 **149.0.7827.55**。sync + async 均验证通过（HOOK_OK / ASYNC_HOOK_OK）。
- hook 落点：`{patchright,playwright}.{sync_api,async_api}._generated.BrowserType.launch`（四个类各 patch 一次；仅当 `self.name == 'chromium'` 时改写）。

## patchright 是否认 PLAYWRIGHT_BROWSERS_PATH

- patchright 是 playwright 的最小 patch fork（drop-in replacement），保留 playwright 的环境变量名。
- 证据：patchright-python issue #45 中用户 interchangeably 使用 `PLAYWRIGHT_BROWSERS_PATH` 与 `PATCHRIGHT_BROWSERS_PATH`，二者均被识别。
- 结论：软件注入的 `PLAYWRIGHT_BROWSERS_PATH` 对 patchright 生效。

## 内置 Python 版本

- 平台内置 Python **3.12**（见 plugins/ai-video-mixer/requirements.txt 注释「平台内置 Python 3.12 可装」）。
- social-auto-upload 要求 `requires-python = ">=3.10,<3.13"` → 3.12 满足。

## 依赖安装机制（plugin_runner.rs）

- Python 插件首启由平台执行 `pip install -r requirements.txt`（清华镜像），优先 `uv pip install --python`，无 uv 时回退 `venv/python -m pip install`。
- venv 位于插件目录 `.venv/`（打包时排除）。
- requirements.txt **必须能装**（契约）；不得含平台 AI 政策禁止的第三方模型 SDK（dashscope/google-genai/litellm 等）。
- social-auto-upload 依赖（loguru/opencv-python/patchright/qrcode/requests/segno）均合规，无 AI SDK。

## 可选增强（非必需）

- 可在 `declares_playwright()` 增加 `patchright` 名字匹配，使 patchright 插件也触发内置浏览器预校验（更友好的缺浏览器报错）。属 desktop Rust 改动，本任务默认不做以保持插件自包含；如做需另起 small change 并跑 `cargo test -p lingfang-desktop`。
