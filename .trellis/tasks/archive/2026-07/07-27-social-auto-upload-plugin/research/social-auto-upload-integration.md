# social-auto-upload 集成研究

仓库：`github.com/dreammis/social-auto-upload`（main 分支，2026-07 检视）

## 项目结构（原样保留，vendored）

```
sau_cli.py            # `sau` 命令入口（[project.scripts] sau = "sau_cli:main"）
sau_backend.py/       # 可选后端
sau_frontend/         # 可选 Vue 前端（本插件不用）
conf.example.py       # 配置模板（用户生成 conf.py）
uploader/
  base_video.py
  douyin_uploader/main.py      # 抖音
  tencent_uploader/main.py     # 视频号
  ks_uploader/main.py          # 快手
  xiaohongshu_uploader/main.py # 小红书
  xhs_uploader/                # 小红书旧实现
  youtube_uploader/main.py     # YouTube
  bilibili_uploader/runtime.py # B站（走 biliup CLI 子进程）
  baijiahao_uploader/main.py   # 百家号
  tk_uploader/                 # TikTok
utils/
  browser_hook.py     # 浏览器启动选项（读 conf.LOCAL_CHROME_PATH）
  base_social_media.py# set_init_script（用 utils/stealth.min.js）
  login_qrcode.py     # 二维码处理
  constant.py         # 分区枚举
myUtils/              # auth/login/postVideo
utils/stealth.min.js  # 反检测注入脚本（存在，HTTP 200）
examples/             # get_*_cookie.py / upload_*.py
```

依赖（pyproject.toml）：`loguru==0.7.3, opencv-python>=4.13, patchright==1.58.2, qrcode==8.2, requests==2.32.3, segno>=1.6.6`，`requires-python >=3.10,<3.13`。

## 浏览器启动（关键集成面）

### 主流程：utils/browser_hook.py

```python
from conf import LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
def get_browser_options():
    options = {'headless': LOCAL_CHROME_HEADLESS, 'args': [...反检测参数...]}
    if LOCAL_CHROME_PATH:
        options['executable_path'] = LOCAL_CHROME_PATH
    return options
```

- 若 `LOCAL_CHROME_PATH` 为空 → patchright 默认 launch → 走 `PLAYWRIGHT_BROWSERS_PATH` → 命中内置 chromium-1228（pin patchright==1.61.x 时）。**无需改 conf 即可用内置浏览器。**
- 若设置 `LOCAL_CHROME_PATH` → 用 `executable_path` 直接启动指定二进制（绕过 revision 查找，双保险）。

### 冲突点：douyin cookie_auth 硬编码 channel="chrome"

`uploader/douyin_uploader/main.py::cookie_auth()`：

```python
launch_kwargs = {"headless": use_headless, "channel": "chrome", "args": [...]}
browser = await playwright.chromium.launch(**launch_kwargs)
```

- `channel="chrome"` 让 patchright 查找**系统安装的 Google Chrome**，忽略 `executable_path` 与 `PLAYWRIGHT_BROWSERS_PATH`。
- 用途：抖音 cookie 校验需有头 + 真实 Chrome 指纹避反爬。
- 问题：若机器无系统 Chrome，或要求「全链路用内置 chromium」，此路径不符合。
- **解决方案（最小 shim，不改上游源码）**：在插件 wrapper（main.py）里对 patchright 的 `chromium.launch` 做运行时 monkey-patch / launch-hook：当检测到 `channel="chrome"`（或统一）时，改为 `executable_path=<内置 chromium exe>` 并去掉 `channel`。上游文件保持原样（满足「github 项目是什么就是什么」）。

## conf.py（需由插件生成）

```python
BASE_DIR = Path(__file__).parent.resolve()   # = vendored 项目根（用于读 utils/stealth.min.js 等资源，只读即可）
XHS_SERVER = "http://127.0.0.1:11901"
LOCAL_CHROME_PATH = ""        # 留空走 PLAYWRIGHT_BROWSERS_PATH；或填内置 chromium exe 作双保险
LOCAL_CHROME_HEADLESS = True
DEBUG_MODE = True
YT_PROXY = None
```

- `BASE_DIR` 必须是 vendored 项目根（stealth.min.js 等相对它解析），不能改成 data/。

## Cookie / 账号持久化

- `sau_cli.resolve_account_file(platform, account_name)` → `BASE_DIR/cookies/{platform}_{account_name}.json`。
- 各上传器的 `*_setup(account_file, ...)` / `cookie_auth(account_file)` / `*Video(...).upload()` 都以 **account_file 路径为参数**。
- **插件方案**：wrapper 直接 import 各平台 `*_setup / cookie_auth / *Video / *Note`，自行把 account_file 指向 `PLUGIN_DIR/data/cookies/{platform}_{account}.json`（可写 data/ 目录，符合插件规范「持久状态写 data/」），不复用 sau_cli 的 BASE_DIR/cookies（那是不可变 release 目录）。

## 登录（二维码）UX

- `*_setup(account_file, handle=True, return_detail=True, qrcode_callback=cb, headless=...)`。
- `qrcode_callback(payload)` 会收到二维码 payload（含 data URL / 图片路径 / 当前 url）。
- 抖音流程：`_extract_douyin_qrcode_src` 从页面抓 QR data URL → `save_data_url_image` 存图 → `decode_qrcode_from_path` 解码 → 回调。
- **插件方案**：GUI 传入 `qrcode_callback`，把 QR 图片渲染到插件窗口供手机扫码；cookie 校验/登录在后台线程跑（asyncio），登录态持久化到 data/cookies/。

## 平台 ↔ API 对照（sau_cli.py imports）

| 平台               | setup                                                     | cookie_auth             | 上传对象                           |
| ------------------ | --------------------------------------------------------- | ----------------------- | ---------------------------------- |
| 抖音 douyin        | douyin_setup                                              | douyin_cookie_auth      | DouYinVideo / DouYinNote           |
| 快手 kuaishou      | ks_setup                                                  | kuaishou_cookie_auth    | KSVideo / KSNote                   |
| 视频号 tencent     | tencent_setup                                             | tencent_cookie_auth     | TencentVideo                       |
| 小红书 xiaohongshu | xiaohongshu_setup                                         | xiaohongshu_cookie_auth | XiaoHongShuVideo / XiaoHongShuNote |
| YouTube            | youtube_setup                                             | youtube_cookie_auth     | YouTubeVideo                       |
| B站 bilibili       | run_biliup_command（biliup CLI 子进程，机制不同）         | —                       | —                                  |
| 百家号 baijiahao   | uploader/baijiahao_uploader（sau_cli 未导入，需单独确认） | —                       | —                                  |
| TikTok tk          | uploader/tk_uploader（sau_cli 未导入）                    | —                       | —                                  |

- `*Video` dataclass 字段：account_name, video_file, title, description, tags, publish_date, thumbnail_file(+landscape/portrait), product_link/title, publish_strategy(immediate/scheduled), debug, headless, declaration 等。
- **bilibili 特殊**：走 `biliup` 第三方 CLI（`run_biliup_command`），需额外装 biliup 包，cookie/登录机制与他平台不同。实现时需单独验证。
- 上传方法名（`.upload()` / `.publish()`）与定时发布参数，实现期以源码为准逐一确认。

## 反检测

- `set_init_script(context)` 注入 `utils/stealth.min.js`；启动参数含 `--disable-blink-features=AutomationControlled` 等。
- patchright 本身 patch 了 CDP 泄露信号（Runtime.enable / Target.setAutoAttach）。二者叠加。

## Windows 长路径注意

- plugin_runner 已为 PySide6 深层 wheel 做短路径缓存；但 venv 装大包仍需留意 MAX_PATH(260)。
- patchright wheel ~43MB（含 driver），opencv-python 较大。插件目录路径应尽量短（plugins/social-auto-upload/）。
- 参考 moneyprinter-turbo：用 vendor.tar.gz 压缩分发避免深嵌套超长路径。social-auto-upload 嵌套不深，普通 vendored 目录即可，但打包 .lfplugin 时需确认不超路径/大小限制。

## Phase 2 实测验证（2026-07-27）

- `sau_bridge.py` 适配层打通：sys.path 注入 vendored 根 → `import conf / uploader.*` 成功；launch-hook 安装成功（HOOK_INSTALLED=True）。
- **抖音 login 端到端（到扫码前）跑通**：`DouyinAdapter.login(headless=True)` 启动内置 chromium → 进抖音创作者登录页 → 抽取二维码 → 存 `data/cookies/douyin_<acct>_login_qrcode_*.png` → `qrcode_callback` 收到 payload **`{image_path, image_data_url}`**（GUI 直接用 image_path 或 data URL 渲染）。
- **tencent 关键发现**：`_build_launch_kwargs` 在 `LOCAL_CHROME_PATH` 为空时对**所有** launch（cookie_auth / cookie_gen / 上传视频 / 上传笔记）都设 `channel="chrome"`。故 launch-hook 对视频号是**必需**（不止抖音 cookie 校验）——hook 全局拦截 `channel=="chrome"` 正好覆盖。
- 抖音上传路径用 `channel="chromium"`（经 PLAYWRIGHT_BROWSERS_PATH 命中内置，无需 hook）；抖音 cookie_auth 用 `channel="chrome"`（需 hook）。
- 各平台 convenience wrapper 自管 playwright 上下文：`DouYinVideo.douyin_upload_video()` / `DouYinNote.douyin_upload_note()` / `TencentVideo.tencent_upload_video()` / `TencentNote.tencent_upload_note()`，适配器直接 await 即可，hook 对其内部 launch 生效。
- 引擎依赖实测可装（内置 python 3.12）：patchright==1.61.1 / playwright==1.61.0 / loguru==0.7.3 / opencv-python(5.0.0.93) / qrcode==8.2 / requests==2.32.3 / segno。

## Phase 5 实测：发布 AI 政策扫描（2026-07-27）

- 首次发布报 HTTP 400 `plugin_ai_policy_failed`（插件不符合平台 AI 使用政策）。本地用 `inspectPluginArtifact` + `checkPluginAiPolicy` 复现，唯一诊断：`[ai.policy.unscannable] social-auto-upload/requirements.txt - 文本不是有效 UTF-8 或包含 NUL`。
- 根因：上游 `requirements.txt` 是 UTF-16-LE（BOM `ff fe`，Windows PowerShell `uv pip freeze >` 产物，含 NUL）。平台 AI 政策扫描要求可扫描文本为合法 UTF-8。
- 解法：重编码该文件 UTF-16→UTF-8（依赖内容逐行不变，仅编码变）。重打包后 `checkPluginAiPolicy` 返回 **ok:true，0 诊断**。
- 注：该文件是上游完整冻结 lock（含 Flask/SQLAlchemy/playwright==1.52.0 等 Web 后端 deps），插件实际只用插件根 `requirements.txt`；此文件仅保真留存，重编码不影响运行。
- 经验：vendored 第三方项目前要检查上游文本文件编码（UTF-16/二进制伪装文本会被 AI 政策扫描判 unscannable 而拒发布）。
