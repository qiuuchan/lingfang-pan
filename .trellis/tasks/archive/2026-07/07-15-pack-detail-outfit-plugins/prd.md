# 打包 AI详情页与换装批量版为平台插件

## Goal

把两个独立 Python GUI 脚本（`Downloads/详情页.py` tkinter 海报生成器、`Downloads/ai换装版本批量版.py` PyQt5 批量换装工具）改造为符合平台规范的 `.lfplugin` 插件，放入 `plugins/` 目录。核心是让它们**经平台本地桥调用 AI**（而非直连外部 API + 硬编码密钥），从而通过平台 AI 使用政策、计费走团队灵石。

## Background

- 两个脚本原样直连外部 AI 端点（`138.128.192.198` / `47.112.8.9` / `179.253.244.196`）并硬编码 `sk-...` 密钥，会被平台 AI 政策扫描器（`apps/collab-api/src/modules/plugin-ai-policy.ts`）以 `ai.config.forbidden`（硬编码密钥 + `api_key=`/`base_url=` 赋值）、`ai.capability.missing`（`/v1/images/edits`、`/v1/chat/completions` 触发能力探测）拒绝。扫描在预览/运行/安装/agent 创建全链路强制。
- 平台桥（`plugin_llm_bridge.rs`）提供 `/image/edit`（image.edit 能力，参考图编辑）、`/v1/chat/completions`（llm.chat 能力，OpenAI 兼容透传）等路由，经 `LINGFANG_PLUGIN_BRIDGE_URL` + `LINGFANG_PLUGIN_BRIDGE_TOKEN` 注入，转发到 relay 按团队灵石计费。参照已有 `plugins/ai-outfit-test`（Node）、`plugins/videodl`（Python）。
- 桥的 `model` 仅认 `fast`/`premium` 档位（默认 fast），不认 `gpt-image-2`/`gpt-5.5` 等具体型号。

## Requirements

### 功能性

- **R1 详情页插件**（`detail-poster`）：保留原脚本全部 GUI 能力——提示词模板库、多模块批量生图、SKU/创意模块、换装/换脸模式、拼长图、主图生成、高清修复、颜色图工具、反推提示词。生图走桥 `/image/edit`，反推走桥 `/v1/chat/completions`。
- **R2 换装批量版插件**（`outfit-batch`）：保留原脚本全部 GUI 能力——换装/换内搭/换头/裂变/创意/口令/批量换装多模式、多人模式、任务队列（并发/超时/重试）、预览区选择/拖拽/重命名、PNG→JPEG、高清放大。生图走桥 `/image/edit`。
- **R3 档位选择**：两个插件 UI 提供 fast/premium 档位选择（替换原 API 分组/密钥设置），默认 fast。

### 约束（AI 政策合规）

- **C1 源码零硬编码密钥**：删除所有 `sk-...` 及明文 API key/url 默认值。
- **C2 桥环境变量无 fallback**：`LINGFANG_PLUGIN_BRIDGE_URL`/`_TOKEN` 读取不得带第二参数（`os.environ.get('X')` 无默认值），不 `print` 桥变量。
- **C3 删除 AI 上下文里的自管配置字段**：源码不得出现 `api_key=`/`api_url=`/`base_url=`/`baseURL=`/`authorization=` 赋值（AI 上下文，含 `chat.completions`/`images.generat`/`openai` 等关键词的文件）。
- **C4 能力声明齐全**：detail-poster 声明 `image.edit` + `llm.chat`；outfit-batch 声明 `image.edit`。
- **C5 第三方依赖合规**：requirements.txt 不得含 `anthropic`/`google-generativeai`/`dashscope` 等被禁 SDK；`openai` 可保留但本插件不使用。

### 工程

- **E1 工程化适配**：硬编码 Windows 路径（字体 `C:\Users\admin\Documents\详情页\*.ttf`、图标 `app.ico`）去硬编码/降级处理；状态文件（`app_state.json`、`task_db.json` 等）落 `data/` 子目录（框架保证存在）。
- **E2 打包**：每个插件产 `manifest.json` + 入口 `main.py` + `requirements.txt` + `README.md`，并打包成同名 `.lfplugin`（zip）放 `plugins/`。
- **E3 依赖**：detail-poster → Pillow、requests、（可选 tkinterdnd2）；outfit-batch → PyQt5、Pillow、requests、psutil。

## Acceptance Criteria

- [ ] AI 政策扫描对两个插件的 manifest + 全部源码返回 `ok: true`、零诊断（用 `plugin-ai-policy.ts` 的 `checkPluginAiPolicy` 或桌面预览面板验证）。
- [ ] 两个插件 `.lfplugin` 产物存在于 `plugins/`，manifest 能力声明正确。
- [ ] detail-poster：填提示词 + 参考图 → 点生成 → 经桥返回图片显示在预览区；反推提示词经桥返回文本（反推走多模态 vision，若平台渠道不支持则优雅报错，不崩）。
- [ ] outfit-batch：选模特+服装图 + 模式 → 提交任务 → 经桥返回结果落到预览区；并发/重试/取消行为正常。
- [ ] 两插件源码无 `sk-`、无 `api_key=`/`base_url=` 等 AI 配置赋值；桥变量无 fallback、无 print。
- [ ] 状态文件写到 `data/`，不污染插件根目录；无硬编码他人路径。

## Assumptions（待 review 确认）

- **A1 PyQt5 保留**：outfit-batch 不迁移到 PySide6（最小改动、降低 2000 行文件迁移风险）。若需 LGPL 合规或与 videodl 统一，再议。
- **A2 反推提示词保留为 best-effort**：detail-poster 的反推用多模态 `image_url`，relay chat 路径类型标注 `content: string`（运行时透传），上游渠道是否支持 vision 不可知；保留功能，失败时弹错误提示，不阻断其余功能。
- **A3 剥离 API 密钥/URL/分组设置 UI**：这些改为平台托管（桥+灵石）；保留本地执行调优（并发数/超时/重试/保存目录/PS 路径）。
- **A4 档位默认 fast**：UI 加 fast/premium 下拉，替换原 API_GROUPS 分组概念。

## Out of Scope

- 不重写 GUI（保留 tkinter / PyQt5 原界面与交互）。
- 不实现插件自动更新/市场发布流程（仅本地 `.lfplugin` 产物 + 目录结构）。
- 不改平台桥 / relay / AI 政策扫描器本身。
