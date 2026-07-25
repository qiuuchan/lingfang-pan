# 执行计划：打包 AI详情页与换装批量版为平台插件

## 前置确认（review gate，step 1.4 前）

- [ ] 用户确认 PRD 假设 A1（PyQt5 保留）、A2（反推 best-effort）、A3（剥离密钥 UI）、A4（档位默认 fast）。
- [ ] `task.py current` 指向本任务。

## 执行清单

### 阶段 0 · 脚手架
- [ ] 0.1 `mkdir plugins/detail-poster plugins/outfit-batch`
- [ ] 0.2 `cp ~/Downloads/详情页.py plugins/detail-poster/main.py`（重命名为 main.py）
- [ ] 0.3 `cp ~/Downloads/ai换装版本批量版.py plugins/outfit-batch/main.py`
- [ ] 0.4 写两份 `manifest.json`（design.md 契约段）、空 `requirements.txt`、占位 `README.md`

### 阶段 1 · detail-poster 改造（tkinter）
- [ ] 1.1 读完整 `main.py`（已读 1-2689，补读 2690-3257：GPT5.5 窗口、颜色图生成、入口）。
- [ ] 1.2 顶部配置块：删 `GEN_API_BASE_URL/GEN_API_KEY/GEN_EDITS_API/REVERSE_API_URL/REVERSE_MODEL/REVERSE_API_KEY/GPT55_*`；新增桥 helper（design.md 代码段）+ tier 默认值。
- [ ] 1.3 `_call_api()` → 改调 `bridge_image_edit()`；删手搓 multipart/boundary；`gpt-image-2` → tier；返回 data:URI/URL 落盘逻辑保留。
- [ ] 1.4 `_call_reverse_api()` + `_refine_prompt_with_title()` + GPT5.5 对话 → 改调 `bridge_chat()`；删 `REVERSE_MODEL`。
- [ ] 1.5 `load_reverse_config/save_reverse_config`：删密钥字段读写，保留 reverse_state/ps_path/tier。
- [ ] 1.6 `open_settings`：删三段 API URL+密钥；保留全局保存目录/PS 路径；加 fast/premium 下拉。
- [ ] 1.7 硬编码路径：`BUILTIN_FONTS` 改系统字体探测 + 导入；`iconbitmap(app.ico)` 去掉。
- [ ] 1.8 状态文件统一 `data/` 前缀（templates/app_state/reverse_config/color_tool/gpt55_chat）。
- [ ] 1.9 启动时 `bridge_ready()` 检查，未在桌面壳内运行给友好提示。

### 阶段 2 · outfit-batch 改造（PyQt5）
- [ ] 2.1 读完整 `main.py`（已读 1-1440，补读 1441-2058：init_ui、generate_action、各模式入口）。
- [ ] 2.2 配置块：删 `DEFAULT_API_KEY/DEFAULT_API_BASE/DEFAULT_API_ENDPOINT/API_GROUPS`；加桥 helper + tier。
- [ ] 2.3 `LocalAPIGenerator.generate()`：两路径合并为 `bridge_image_edit()`；删 `use_json`/endpoint 拼接/`X-API-Group`；images 返回值落盘。
- [ ] 2.4 `ApiKeyDialog` → 重做「执行参数」：并发/超时(≤600)/重试/档位；删 URL/密钥/分组。
- [ ] 2.5 `app_settings`：`api_group`→`tier`；`update_api_status_label`/窗口标题改显档位+并发。
- [ ] 2.6 状态路径：`task_db.json/prompt_templates.json/app.log/image/` → `data/` 前缀。
- [ ] 2.7 `get_api_key/get_api_group` 及残留密钥引用清理。

### 阶段 3 · 依赖与文档
- [ ] 3.1 `detail-poster/requirements.txt`：Pillow、requests、（tkinterdnd2 注释为可选）。
- [ ] 3.2 `outfit-batch/requirements.txt`：PyQt5、Pillow、requests、psutil。
- [ ] 3.3 两份 `README.md`（参照 videodl：用途、运行机制、首次 venv 安装提示、档位/计费说明、局限）。

### 阶段 4 · AI 政策验证（review gate）
- [ ] 4.1 静态自检：grep 确认两插件源码无 `sk-`、无 `api_key\s*=`、无 `base_url\s*=`、桥变量读取无第二参数、无 print 桥变量。
- [ ] 4.2 调 `checkPluginAiPolicy`：用 node 跑 collab-api 的扫描器对两插件 manifest+files，确认 `ok:true`、零诊断。
  ```bash
  # 若有现成 CLI 则用；否则写一次性 node 脚本 import checkPluginAiPolicy 喂 manifest+files
  ```
- [ ] 4.3 修复任何剩余诊断，回到 4.2 直到通过。

### 阶段 5 · 打包
- [ ] 5.1 `cd plugins/detail-poster && zip -r ../detail-poster.lfplugin manifest.json main.py requirements.txt README.md`
- [ ] 5.2 `cd plugins/outfit-batch && zip -r ../outfit-batch.lfplugin manifest.json main.py requirements.txt README.md`
- [ ] 5.3 `file plugins/*.lfplugin` 确认是 zip；`unzip -l` 确认内含 4 文件、无 `data/`/`__pycache__`。

### 阶段 6 · 实跑验证（条件性，需桌面壳）
- [ ] 6.1 在桌面客户端加载两插件，确认 manifest 解析、venv 创建、进程启动、窗口弹出。
- [ ] 6.2 detail-poster：生图 + 反推各试一次；outfit-batch：换装任务试一次。
- [ ] 6.3 若无法跑桌面壳（环境限制），明确告知用户需手动验证，不谎报通过。

## 验证命令

```bash
# AI 政策静态自检
grep -nE 'sk-[A-Za-z0-9_-]{16,}' plugins/detail-poster/main.py plugins/outfit-batch/main.py && echo "FAIL: 残留密钥" || echo "OK: 无硬编码密钥"
grep -niE '(api_key|api_url|base_url|baseURL|authorization)\s*[:=]' plugins/detail-poster/main.py plugins/outfit-batch/main.py | grep -vE '^\s*#' && echo "WARN: 需人工复核 AI 上下文" || echo "OK"
grep -nE 'LINGFANG_PLUGIN_BRIDGE_(URL|TOKEN)' plugins/detail-poster/main.py plugins/outfit-batch/main.py  # 人工确认每处无 fallback

# 桥扫描器（若 collab-api 可编译）
node -e "const {checkPluginAiPolicy}=require('./apps/collab-api/src/modules/plugin-ai-policy'); ..." # 按 4.2 填

# 打包产物
file plugins/detail-poster.lfplugin plugins/outfit-batch.lfplugin
```

## 评审门 / 回滚点

- **G1 阶段 1/2 改造完**：先跑阶段 4 静态自检，不过不进打包。
- **G2 阶段 4 AI 政策过**：才打包（不过扫描的插件装不进平台）。
- **回滚**：删 `plugins/detail-poster*` + `plugins/outfit-batch*` 即可，无副作用。

## 风险

- **R1 反推 vision 失败**（A2）：桥透传但上游渠道可能不吃 image_url → 优雅报错，不影响生图主路径。
- **R2 PyQt5 venv 安装慢/失败**：首次 pip install PyQt5 约 100MB+；与 videodl 装 PySide6 同量级，框架已处理 venv 创建。
- **R3 tkinterdnd2 缺失**：原脚本已 try/except 降级（拖放禁用、其余功能正常），无需硬依赖。
- **R4 源码太大扫描截断**：单文件 < 4MiB 文本上限（详情页 ~130KB、批量版 ~90KB），不触发。
