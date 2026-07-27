# 技术设计：social-auto-upload 插件

## 1. 总体形态

```
plugins/social-auto-upload/
  manifest.json            # 插件清单（runtime_type=python, entry=main.py）
  main.py                  # PySide6 GUI 外壳 + 浏览器 launch-hook + 平台调度
  sau_bridge.py            # 薄适配层：import vendored 上游 API，统一各平台调用签名
  requirements.txt         # patchright==1.61.x + 上游依赖 + PySide6
  README.md
  social-auto-upload/      # ★ vendored 上游原项目（原样，含 conf.py）
    conf.py                # 由插件生成/随包：BASE_DIR=本目录, LOCAL_CHROME_PATH 见 §4
    sau_cli.py / uploader/ / utils/ / myUtils/ ...（上游原文件）
  data/                    # 运行时（gitignore，不打包）
    cookies/{platform}_{account}.json
    qrcode/                # 临时二维码图
    app.log
```

设计取舍：

- **GUI 外壳 + Python API 直调**（非 subprocess 调 `sau` CLI）。理由：需要 `qrcode_callback` 把二维码渲染进窗口、需要细粒度进度/错误、需要把 account_file 指到 data/。CLI 的终端二维码与固定 cookie 路径都不适合 GUI。
- **vendored 而非 pip 安装上游**：上游未发布到 PyPI 稳定包，且要「保留原项目」可见可审计；vendored 目录可锁定上游 commit。
- 参考先例：pixelle-video / moneyprinter-turbo（vendored 上游 + 薄启动器），rbflow-video（PySide6 GUI + data/ 持久化）。本插件取两者之长：vendored 上游 + 自写 GUI。

## 2. Manifest 与能力

```json
{
  "id": "com.lingfang.social-auto-upload",
  "name": "社交媒体自动上传",
  "version": "0.1.0",
  "description": "一键上传视频/图文到抖音、视频号、快手、小红书、B站、YouTube、百家号、TikTok。内置浏览器自动登录、扫码授权、批量发布。基于开源项目 social-auto-upload。",
  "runtime_type": "python",
  "entry": "main.py",
  "visibility": "tenant",
  "capabilities": [
    { "kind": "ui.view",   "reason": "展示插件操作界面", "risk": "none",   "requires_admin": false },
    { "kind": "fs.pick",   "reason": "选择待上传的视频/图片/封面文件", "risk": "low", "requires_admin": false },
    { "kind": "fs.write",  "reason": "保存登录态/日志/临时二维码到 data/", "risk": "low", "requires_admin": false },
    { "kind": "net.fetch", "reason": "上传器需访问各社交平台站点完成发布", "risk": "medium", "requires_admin": false }
  ]
}
```

- 能力名是稳定契约（contract/服务端白名单/桌面桥/SDK 一致）。实际只调用已声明能力。
- 浏览器自动化本身不需要单独 capability（patchright 直接驱动内置 chromium，进程内行为）；网络访问由 patchright 发起，声明 net.fetch 说明用途。
- 不声明 AI 能力（本插件无 LLM）。

## 3. 运行时与依赖

- 平台内置 Python 3.12（满足上游 `>=3.10,<3.13`）。
- 首启平台执行 `pip install -r requirements.txt`（清华镜像，优先 uv）。
- `requirements.txt`（平铺上游 pyproject 依赖 + GUI）：

  ```
  PySide6>=6.7            # GUI（与 rbflow-video 一致；plugin_runner 已有短路径缓存）
  patchright==1.61.1      # ★ 期望 chromium r1228 == 内置；drop-in 替换上游的 1.58.2
  loguru==0.7.3
  opencv-python>=4.13.0.92
  qrcode==8.2
  requests==2.32.3
  segno>=1.6.6
  # bilibili 平台需要 biliup（上游 run_biliup_command 依赖）——实现期确认包名/版本后加入
  ```

- 与上游差异仅 `patchright` 版本（1.58.2 → 1.61.1），原因：匹配内置 chromium r1228。上游业务代码不动。
- 不含任何第三方模型 SDK（合规）。

## 4. 浏览器：命中内置 Chromium（核心）

软件对每个插件进程**无条件注入**：

- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
- `PLAYWRIGHT_BROWSERS_PATH=<bundled>/chromium/ms-playwright`

### 4.1 默认 launch 路径（绝大多数上传/登录流程）

- pin `patchright==1.61.1` → 其 browsers.json 期望 chromium **1228**。
- patchright 默认 `chromium.launch()` 在 `PLAYWRIGHT_BROWSERS_PATH` 下找 `chromium-1228/chrome-win64/chrome.exe` → **命中内置**，不下载。
- `utils/browser_hook.py::get_browser_options()` 在 `LOCAL_CHROME_PATH` 为空时不加 executable_path，走上述默认路径。
- **双保险**：conf.py 可把 `LOCAL_CHROME_PATH` 设为内置 chromium exe 绝对路径（由 main.py 启动时探测 `PLAYWRIGHT_BROWSERS_PATH`/PATH 动态写入或注入），使 get_browser_options 走 executable_path，彻底脱离 revision 查找。实现期二选一或叠加，以实测稳定者为准。

### 4.2 硬编码 channel="chrome" 路径（抖音 cookie_auth 等）

- 上游 `cookie_auth` 用 `launch(channel="chrome")` 找系统 Chrome，忽略 PLAYWRIGHT_BROWSERS_PATH。
- **launch-hook shim（不改上游源码）**：main.py 在 import 上游前，monkey-patch patchright 的 chromium `launch`：

  ```python
  # 伪代码
  from patchright.async_api import async_playwright  # 上游用 async
  _orig_launch = ...chromium.launch
  def _hooked_launch(*a, **kw):
      kw.pop("channel", None)                 # 去掉系统 Chrome 通道
      kw.setdefault("executable_path", BUNDLED_CHROME_EXE)  # 指向内置 chromium
      return _orig_launch(*a, **kw)
  ```

  - `BUNDLED_CHROME_EXE` 由 `PLAYWRIGHT_BROWSERS_PATH` + `chromium-1228/chrome-win64/chrome.exe` 拼出（revision 从软件常量/目录探测）。
  - 同步 API（sync_playwright）同理 hook（上游部分路径可能用 sync）。实现期确认上游各平台用的是 async 还是 sync，分别 hook。
- 这样 cookie 校验也用内置 chromium，机器无系统 Chrome 亦可。

### 4.3 headless 策略

- 登录/cookie 校验：抖音明确要求**有头**避反爬（上游注释）。但 GUI 场景下二维码是抓图渲染到窗口，浏览器本身可 headless 运行（QR 从页面 DOM 抓 data URL）。实现期实测：若 headless 触发风控，则登录流程用有头（弹出独立浏览器窗口供扫码）——由 conf `LOCAL_CHROME_HEADLESS` / 各 setup 的 headless 参数控制。
- 上传：默认 headless=True（后台跑），进度回 GUI。

## 5. 适配层 sau_bridge.py

职责：把上游异构的平台 API 收敛成统一接口，供 GUI 调用；隔离上游 import 细节。

```python
# 统一接口（示意）
class PlatformAdapter:
    name: str                      # "douyin" / "tencent" / ...
    supports_note: bool            # 是否支持图文
    async def login(account, qrcode_cb, headless) -> LoginResult
    async def check(account) -> bool
    async def upload_video(account, req, progress_cb) -> Result
    async def upload_note(account, req, progress_cb) -> Result   # 仅支持图文的平台

PLATFORMS: dict[str, PlatformAdapter]  # douyin/tencent/ks/xiaohongshu/youtube/bilibili/baijiahao/tiktok
```

- 各 adapter 内部 import `uploader.<platform>_uploader.main` 的 `*_setup / cookie_auth / *Video / *Note`，account_file 指向 `data/cookies/{platform}_{account}.json`。
- **bilibili** 走 `run_biliup_command`（biliup CLI 子进程），adapter 单独实现（构造 biliup 命令 + 传 cookie），实现期验证。
- **百家号 / TikTok**：sau_cli 未导入，需读 `uploader/baijiahao_uploader` / `uploader/tk_uploader` 源码确认入口与登录方式后补 adapter。
- import 前置：`sys.path.insert(0, str(VENDORED_DIR))`，并确保 `conf` 可 import（vendored 根含 conf.py）。
- 上游用 asyncio；GUI 在 QThread 里跑独立 event loop 调 adapter，信号回主线程刷 UI。

## 6. GUI（main.py，PySide6）

布局（参考 rbflow-video 风格）：

- 左：平台选择（列表/Tab）+ 账号管理（当前账号下拉、新增/登录/登出、登录态指示灯）。
- 中：上传表单——素材类型（视频/图文，按平台能力）、文件选择（fs.pick）、标题、描述/正文、标签、封面、发布方式（立即/定时 + 时间）。
- 右/下：任务队列 + 实时日志/进度条。
- 登录对话框：渲染二维码图片（来自 qrcode_callback），状态提示「等待扫码 / 已登录 / 失效」。

线程模型：

- 主线程 = Qt UI。
- 工作 QThread 跑 asyncio loop，执行 login/upload；通过 Signal 把进度/日志/二维码图发回主线程。
- 全局异常捕获写 data/app.log（参考 rbflow-video）。

桥变量：本插件**不调用平台 LLM/视频桥**，故不强依赖 LINGFANG_PLUGIN_BRIDGE_URL；如后续需 storage.kv 等再用 SDK HTTP fallback。当前仅用进程内能力 + 文件系统。

## 7. 数据流

```
[GUI 选平台/素材/账号]
   → sau_bridge.<platform>.upload_video(account, req, progress_cb)
      → sys.path 注入 vendored → import uploader.<p>.main
      → patchright launch（命中内置 chromium-1228；channel 路径经 hook）
      → 读 data/cookies/{p}_{account}.json（storage_state）
         若失效 → *_setup(qrcode_callback) → GUI 渲染 QR → 扫码 → 写回 cookie
      → 构造 *Video(...).upload() → 各平台站点发布
      → progress_cb / 日志 → Signal → GUI
   → 结果落 data/app.log
```

## 8. 打包与路径

- vendored 目录嵌套不深，普通目录即可（不必 tar.gz）。但需验证：
  - `.lfplugin` build 排除 `.venv / data / __pycache__ / *.pyc`（build 器默认排除）。
  - Windows MAX_PATH(260)：插件安装路径 + vendored 深层文件不超限。patchright/opencv wheel 装进 .venv（短路径缓存已处理 PySide6；其余实现期验证）。
- conf.py 随包（生成好，BASE_DIR 用 `Path(__file__).parent` 相对解析，无绝对路径）。
- 不在包内放 cookie/日志/用户文件。

## 9. 安全 / 合规

- 不持有任何平台 API Key / JWT / 桥 token；登录态是用户自己的社交账号 cookie，存本地 data/（用户自有数据，允许）。
- 错误提示可含上游错误码/信息，不泄露完整本地路径堆栈。
- 网络仅访问各社交平台站点（net.fetch 已声明）。

## 10. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| patchright 1.61.1 与内置 chromium 协议不兼容 | 已确认 revision 完全一致（1228）；实测 launch 冒烟 |
| channel="chrome" hook 漏掉某些路径 | 全局 hook patchright launch；实测抖音 cookie 校验无系统 Chrome 通过 |
| headless 登录触发平台风控 | 登录路径可切有头（弹窗扫码）；沿用上游有头策略 |
| bilibili/baijiahao/tiktok 入口与他平台不同 | adapter 逐个验证；先保证抖音+视频号端到端，其余平台分阶段接通 |
| Windows 长路径/大 wheel 安装失败 | 短路径缓存 + 实测 pip install；必要时压缩 vendored |
| 上游 API 字段/方法名与假设不符 | 实现期以 vendored 源码为准逐平台核对 |

回退：插件独立目录，删除 `plugins/social-auto-upload/` 即完全回退，不影响其它插件与桌面。

## 11. 验证命令

- 插件校验：`pnpm -C packages/plugin-sdk exec lingfang-plugin validate plugins/social-auto-upload`
- 插件构建：`pnpm -C packages/plugin-sdk exec lingfang-plugin build <abs plugin dir> --out <abs .lfplugin>`
- 浏览器冒烟（插件 venv 内）：`python -c "from patchright.sync_api import sync_playwright; ..."` 验证 launch 命中 chromium-1228、无下载。
- 桌面端导入预览 GUI。
- （本任务不改 Rust，故不需 cargo test；若做可选的 declares_playwright 增强则跑 `cargo test -p lingfang-desktop`。）
