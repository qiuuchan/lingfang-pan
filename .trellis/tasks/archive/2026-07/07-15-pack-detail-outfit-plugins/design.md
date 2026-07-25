# 技术设计：打包 AI详情页与换装批量版为平台插件

## 边界

**改动范围**（仅插件目录新增 + 脚本内部 API 层改造）：
- 新增 `plugins/detail-poster/`（4 文件）+ `plugins/detail-poster.lfplugin`
- 新增 `plugins/outfit-batch/`（4 文件）+ `plugins/outfit-batch.lfplugin`
- 改造两脚本的 AI 调用层、设置 UI、状态路径、硬编码路径

**不动**：平台桥 `plugin_llm_bridge.rs`、relay、AI 政策扫描器、桌面插件加载器、其他插件。

## 参考实现

| 参照 | 说明 |
|------|------|
| `plugins/ai-outfit-test/index.js` | 桥 `/image/edit` 调用的标准范式（token 头、body 形状、env 无 fallback） |
| `plugins/videodl/manifest.json` + `main.py` | Python 插件 manifest 形状、`data/` 持久化、venv 运行、弹独立窗口 |
| `apps/desktop/src-tauri/src/plugin_llm_bridge.rs:393-582` | `/image/edit`、`/llm/chat`、`/v1/chat/completions` 路由契约 |
| `apps/collab-api/src/modules/plugin-ai-policy.ts` | 扫描器规则（合规判据） |

## 契约

### 桥调用（Python 共享 helper，两插件各持一份）

```python
import os, base64, mimetypes, requests

# AI 政策：读取桥变量不得带 fallback 默认值（bridgeEnvHasFallback 会判）
_BRIDGE_URL = os.environ.get("LINGFANG_PLUGIN_BRIDGE_URL")
_BRIDGE_TOKEN = os.environ.get("LINGFANG_PLUGIN_BRIDGE_TOKEN")

def bridge_ready() -> bool:
    return bool(_BRIDGE_URL and _BRIDGE_TOKEN)

def _bridge_headers():
    return {"X-LingFang-Plugin-Token": _BRIDGE_TOKEN}

def bridge_image_edit(prompt, image_paths, tier="fast", n=1, size="1024x1024", timeout=(30, 600)):
    """参考图编辑：返 list[str]，每项是 data:URI 或 http URL。"""
    images = []
    for p in image_paths:
        with open(p, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        mime = mimetypes.guess_type(p)[0] or "image/png"
        images.append({"filename": os.path.basename(p), "mimeType": mime, "data": b64})
    body = {"prompt": prompt, "images": images, "model": tier, "n": int(n), "size": size}
    resp = requests.post(_BRIDGE_URL + "/image/edit", json=body, headers=_bridge_headers(), timeout=timeout)
    resp.raise_for_status()
    return resp.json().get("images", [])  # 桥已抽取好

def bridge_chat(messages, tier="fast", timeout=(30, 300)):
    """OpenAI 兼容 chat：返完整 relay 响应 dict（choices[0].message.content）。"""
    body = {"model": tier, "messages": messages}
    resp = requests.post(_BRIDGE_URL + "/v1/chat/completions", json=body, headers=_bridge_headers(), timeout=timeout)
    resp.raise_for_status()
    return resp.json()
```

- 图片落盘：helper 返回 data:URI 时 base64 解码；http URL 时 `requests.get` 下载。
- **不持有任何密钥**；token 由桌面壳进程注入。
- 桥变量绝不在日志/print 中出现（`ai.bridge.secret_sink`）。

### manifest 形状

**detail-poster/manifest.json**
```json
{
  "id": "com.lingfang.detail-poster",
  "name": "AI详情页海报生成器",
  "version": "0.1.0",
  "description": "AI 详情页/主图海报生成：提示词模板库 + 多模块批量生图 + 换装换脸 + 反推提示词 + 拼长图 + 高清修复 + 颜色图工具。生图与反推均经平台桥，按团队灵石计费，无需配置密钥。",
  "runtime_type": "python",
  "entry": "main.py",
  "visibility": "tenant",
  "capabilities": [
    { "kind": "image.edit", "reason": "经平台图片编辑能力生成海报/主图/换装图", "risk": "medium", "requires_admin": false },
    { "kind": "llm.chat", "reason": "经平台对话能力反推与精简提示词", "risk": "medium", "requires_admin": false }
  ]
}
```

**outfit-batch/manifest.json**
```json
{
  "id": "com.lingfang.outfit-batch",
  "name": "AI换装批量版",
  "version": "0.1.0",
  "description": "批量 AI 换装/换内搭/换头/裂变/创意/口令工具：任务队列（并发/超时/重试）、多人模式、预览拖拽重命名、PNG→JPEG、高清放大。经平台桥调用图片编辑，按团队灵石计费，无需配置密钥。",
  "runtime_type": "python",
  "entry": "main.py",
  "visibility": "tenant",
  "capabilities": [
    { "kind": "image.edit", "reason": "经平台图片编辑能力批量换装/换头/裂变", "risk": "medium", "requires_admin": false }
  ]
}
```

## 数据流

### 生图（两插件共用）
```
GUI 收集(prompt, 参考图paths, tier, size)
  → bridge_image_edit(...)            # base64 编码图 + POST 桥 /image/edit
  → 桥 route_image_edit               # 校验 image.edit 能力 + token
  → relay POST /api/relay/v1/images/edits?model=<tier>   # relay 注入上游 model，按张计费扣灵石
  → 桥 extract_image_urls → {images:[...]}
  → 插件 落盘 data/ + 刷新预览
```

### 反推提示词（仅 detail-poster）
```
GUI(参考图base64 + theme/cloth/scene)
  → bridge_chat(messages=[{role:user, content:[{type:text,...},{type:image_url,...}]}])
  → 桥 route_v1_chat_completions      # 校验 llm.chat + token，透传 messages
  → relay → 上游渠道                    # ⚠ 上游是否支持 vision 不可知（A2）
  → 返 choices[0].message.content
```

## 各插件改造点

### detail-poster（原 详情页.py，tkinter）
1. **API 层替换**：
   - `_call_api()`（`GEN_EDITS_API` multipart）→ `bridge_image_edit()`；删除手搓 boundary/multipart 代码。
   - `_call_reverse_api()`、`_refine_prompt_with_title()`（`REVERSE_API_URL`）→ `bridge_chat()`；`REVERSE_MODEL="gpt-5.5"` 删除，tier 走 fast/premium。
   - GPT5.5 对话窗口（`open_gpt55_chat`）同理走 `bridge_chat`。
2. **删配置**：模块顶部 `GEN_API_BASE_URL`/`GEN_API_KEY`/`REVERSE_API_URL`/`REVERSE_API_KEY`/`GPT55_*` 全删；`load_reverse_config`/`save_reverse_config` 只保留非密钥字段（reverse_state、ps_path）。
3. **设置窗口**：`open_settings` 删生图/反推/GPT5.5 三段 API URL+密钥；保留全局保存目录、PS 路径；新增 fast/premium 档位选择（存 reverse_config）。
4. **硬编码路径**：`BUILTIN_FONTS`（`C:\Users\admin\Documents\详情页\*.ttf`）改为运行时探测系统字体 + 允许用户导入；`iconbitmap('...app.ico')` 去掉或改相对路径探测。
5. **状态路径**：`TEMPLATE_FILE`/`STATE_FILE`/`REVERSE_CONFIG_FILE`/`COLOR_STATE_FILE`/`GPT55_CHAT_FILE` 统一加 `data/` 前缀。
6. **model 字段**：所有 `"gpt-image-2"` → tier 变量。

### outfit-batch（原 ai换装版本批量版.py，PyQt5）
1. **API 层替换**：`LocalAPIGenerator.generate()` 两条路径（JSON / multipart）合并为单次 `bridge_image_edit()` 调用；`use_json`/`endpoint`/`api_base_url`/分组逻辑全删；返回的 images 直接落盘。
2. **删配置**：`DEFAULT_API_KEY`/`DEFAULT_API_BASE`/`DEFAULT_API_ENDPOINT`/`API_GROUPS` 删；`ApiKeyDialog` 重做为「执行参数」（并发/超时/重试/档位 fast-premium），删 URL/密钥/分组字段。
3. **档位**：`app_settings` 的 `api_group` → `tier`（fast/premium），UI 下拉替换原分组；`get_api_group()`/`X-API-Group` 头删除。
4. **model 字段**：payload `"model": "gpt-image-2"` → tier。
5. **状态路径**：`task_db.json`/`prompt_templates.json`/`app.log`/`image/` 落 `data/` 前缀；`DEFAULT_IMAGE_DIR = Path("data")/"image"`。
6. **标题栏**：`update_api_status_label`/窗口标题改为显示档位 + 并发，不显示 URL/分组。

## AI 政策合规细节（对照 `plugin-ai-policy.ts`）

| 扫描规则 | 合规做法 |
|----------|----------|
| `ai.config.forbidden`（`sk-...{16+}`） | 删全部硬编码密钥；占位符用中文（`sk-此处替换` 不命中，但仍删） |
| `ai.config.forbidden`（AI 上下文 `api_key=`/`base_url=` 赋值） | 删模块级 `*_API_KEY`/`*_API_URL`/`*_BASE_URL` 变量；settings 读取改用不触发正则的键名或直接用 dict |
| `ai.bridge.custom`（桥变量带 fallback） | `os.environ.get("LINGFANG_PLUGIN_BRIDGE_URL")` 无第二参数 |
| `ai.bridge.secret_sink`（print/写文件含桥变量） | 桥变量不进任何 print/log/磁盘 |
| `ai.capability.missing` | manifest 声明 `image.edit`（两插件）+ `llm.chat`（detail-poster） |
| `ai.sdk.third_party`（requirements） | 不含 anthropic/dashscope 等；Pillow/requests/PyQt5/psutil 均允许 |
| `ai.endpoint.third_party` | 自定义 IP 本不在黑名单；删除后更无关 |
| `detectCapabilities`（`/image/edit`、`/v1/chat/completions` 字符串触发能力探测） | 与 manifest 声明一致，正常通过 |

**关键陷阱**：`bridgeEnvHasFallback` 对 Python 也生效——`os.environ.get('X', '默认')`（逗号 + 默认值）会命中；`getenv("X") or "x"` 也命中。必须裸 `os.environ.get("X")` 或 `os.environ["X"]`。

## 兼容性 / 取舍

- **PyQt5 vs PySide6**（A1）：保留 PyQt5。迁移到 PySide6 需改 import、`pyqtSignal→Signal`、`exec_()→exec()`、`pyqtSignal→Signal` 等，2000 行文件风险高；venv 内 pip install PyQt5 可正常工作。后续若需 LGPL 合规再迁。
- **反推 vision**（A2）：relay chat 的 messages 类型标注 `{content: string}`，但运行时纯透传；上游渠道是否吃 `image_url` 不可知。保留功能 + try/except 优雅报错。
- **并发/超时/重试**：outfit-batch 保留这些本地执行调优（不涉及 AI 密钥），但桥单次调用超时上限 600s（`relay_post_raw`），UI 的 timeout 设置钳制到 ≤600。
- **任务持久化**：outfit-batch 的 `task_db.json` 记录历史任务，重启恢复预览——路径迁到 `data/` 后行为不变。

## 回滚形态

- 全部新增文件（`plugins/detail-poster*`、`plugins/outfit-batch*`），删除即回滚。
- 原脚本不动（仍在 Downloads）。无平台侧改动。
