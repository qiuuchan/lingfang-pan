# 执行计划：social-auto-upload 插件

按序执行；每阶段末有验证。回退点：每阶段可独立 `git restore` / 删除插件目录。

## 阶段 0：vendored 上游 + 骨架

- [ ] 0.1 记录上游 commit：`git ls-remote https://github.com/dreammis/social-auto-upload main`（或 clone 取 HEAD sha），写入 README「上游版本」段。
- [ ] 0.2 把上游源码 vendored 到 `plugins/social-auto-upload/social-auto-upload/`。
  - 因 `git clone` 直连 github 被墙，用 GitHub API / raw 逐文件拉取，或 `git clone` 走可用代理；排除 `.git`、`sau_frontend`（Vue 前端，不用）、`media`（文档图，可选保留）、`docs`（可选）。
  - 保留：`sau_cli.py`、`uploader/`、`utils/`（含 stealth.min.js）、`myUtils/`、`db/`、`conf.example.py`、`pyproject.toml`、`requirements.txt`、`__init__.py`。
- [ ] 0.3 生成 `social-auto-upload/conf.py`：`BASE_DIR=Path(__file__).parent.resolve()`、`LOCAL_CHROME_PATH=""`、`LOCAL_CHROME_HEADLESS=True`、`DEBUG_MODE=True`、`YT_PROXY=None`、`XHS_SERVER` 默认值。
- [ ] 0.4 写插件骨架：`manifest.json`（§2）、空 `main.py`、`requirements.txt`（§3）、`README.md`、`.gitignore`（data/、.venv/、**pycache**/、cookies/）。
- [ ] **验证**：`ls plugins/social-auto-upload/social-auto-upload/uploader` 各平台目录齐全；`python -c "import ast; ast.parse(open('.../sau_cli.py').read())"` 语法 OK。

## 阶段 1：浏览器命中内置 Chromium（先打通核心，最高风险）

- [ ] 1.1 在插件目录建临时 venv 实测（非平台首启）：`uv venv && uv pip install patchright==1.61.1`（清华源）。
- [ ] 1.2 设 `PLAYWRIGHT_BROWSERS_PATH=<内置>/chromium/ms-playwright`、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，跑冒烟脚本：patchright launch chromium → 打印 `browser.version` 与可执行路径，确认 == chromium-1228 / 149.x，且__无下载__。
  - 内置目录定位：开发期从已安装 LingFang 的 resources 找，或 `LINGFANG_EMBEDDED_RUNTIME_DIR`。若本机无内置 chromium，临时用 `patchright install chromium` 装到该 PATH 模拟（仅开发验证，非运行时行为）。
- [ ] 1.3 实现 launch-hook：monkey-patch patchright async + sync 的 chromium.launch，去 `channel`、注入 `executable_path=<内置 chrome.exe>`。写独立小脚本验证：调 `launch(channel="chrome")` 经 hook 后启动的是内置 chromium。
- [ ] **验证**：冒烟脚本输出内置 chromium 版本；hook 测试通过。这是 go/no-go 门——不过则重新评估 §4 方案。

## 阶段 2：适配层 sau_bridge.py（先抖音 + 视频号端到端）

- [ ] 2.1 `sys.path` 注入 vendored 根，确认 `import conf` / `from uploader.douyin_uploader.main import ...` 成功。
- [ ] 2.2 读源码核对各平台真实 API：`*_setup` 签名、`cookie_auth`、`*Video/*Note` 字段与上传方法名（`.upload()`?）、async/sync。逐平台记录到本文件附录。
- [ ] 2.3 实现 `PlatformAdapter` 基类 + `DouyinAdapter` + `TencentAdapter`：login(qrcode_cb)/check/upload_video，account_file → `data/cookies/{p}_{acct}.json`。
- [ ] 2.4 抖音图文 `DouyinNote`、视频号字段差异处理。
- [ ] **验证**：命令行脚本驱动 DouyinAdapter.login（打印 QR 回调 payload）+ upload_video（用一个小测试 mp4）跑通；cookie 落 data/。

## 阶段 3：PySide6 GUI

- [ ] 3.1 主窗口布局（§6）：平台列表、账号管理、上传表单、任务队列/日志。
- [ ] 3.2 工作 QThread + asyncio loop；Signal 回传进度/日志/二维码。
- [ ] 3.3 登录对话框渲染二维码图；登录态持久化与免登录复用。
- [ ] 3.4 文件选择（视频/图片/封面）、表单字段按平台能力动态呈现、定时发布。
- [ ] 3.5 全局异常捕获 → data/app.log。
- [ ] **验证**：`python main.py` 本地起 GUI（带桥变量模拟或无桥直跑），抖音端到端走一遍 UI 流程。

## 阶段 4：补齐其余平台

- [ ] 4.1 快手 / 小红书 adapter（含图文 Note）。
- [ ] 4.2 YouTube adapter（注意 YT_PROXY 配置项）。
- [ ] 4.3 bilibili adapter（biliup 子进程）：确认 biliup 包名/版本加入 requirements；cookie 机制验证。
- [ ] 4.4 百家号 / TikTok adapter：读 `uploader/baijiahao_uploader`、`uploader/tk_uploader` 源码确认入口后实现。
- [ ] **验证**：每平台 UI 可达 + 登录/上传调用链接通（无真实账号的平台至少到「构造请求→发起」不报导入/签名错）。

## 阶段 5：打包与合规

- [ ] 5.1 `lingfang-plugin validate plugins/social-auto-upload` 通过。
- [ ] 5.2 `lingfang-plugin build` 产出 .lfplugin；解压检查含 `_meta.json`（formatVersion 4）、不含 .venv/data/**pycache**、无绝对路径。
- [ ] 5.3 桌面端导入 → 启动 GUI → 能力声明与实际一致。
- [ ] 5.4 合规自查：源码/manifest/README/日志无 Key/JWT/token/供应商 URL；requirements 无 AI SDK。
- [ ] **验证**：validate + build 成功；桌面导入启动成功。

## 阶段 6：收尾

- [ ] 6.1 README：功能、支持平台、上游版本与 commit、内置 chromium 说明、与上游差异（patchright 版本 + launch-hook shim）、使用步骤。
- [ ] 6.2 `trellis-check`（spec 合规 + 验证命令）。
- [ ] 6.3 `trellis-update-spec`：把「patchright 版本须匹配内置 chromium revision」「channel=chrome 需 hook」「cookie 走 data/」等经验写入 `.trellis/spec/`（plugin 开发相关）。
- [ ] 6.4 提交（Phase 3.4 批量提交）。

## Review Gates

- 阶段 1 末（浏览器命中）= 硬 go/no-go。
- 阶段 2 末（抖音+视频号端到端）= 核心功能确认，建议用户验收后再铺其余平台。
- 阶段 5 末（打包）= 发布前确认。

## 附录：各平台 API 核对（实现期填充）

| 平台        | setup              | cookie_auth                 | 上传对象/方法          | async?     | 备注               |
| ----------- | ------------------ | --------------------------- | ---------------------- | ---------- | ------------------ |
| douyin      | douyin_setup       | cookie_auth(channel=chrome) | DouYinVideo/DouYinNote | async      | cookie 校验需 hook |
| tencent     | tencent_setup      | cookie_auth                 | TencentVideo           | ?          |                    |
| kuaishou    | ks_setup           | cookie_auth                 | KSVideo/KSNote         | ?          |                    |
| xiaohongshu | xiaohongshu_setup  | cookie_auth                 | XiaoHongShuVideo/Note  | ?          |                    |
| youtube     | youtube_setup      | cookie_auth                 | YouTubeVideo           | ?          | YT_PROXY           |
| bilibili    | run_biliup_command | —                           | biliup CLI             | subprocess | 需 biliup 包       |
| baijiahao   | 待确认             | 待确认                      | 待确认                 | ?          | sau_cli 未导入     |
| tiktok      | 待确认             | 待确认                      | 待确认                 | ?          | sau_cli 未导入     |
