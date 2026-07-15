# AI 换装批量版（outfit-batch）

基于 PyQt5 的批量 AI 生图工具，支持换装/换内搭/换头/裂变/创意/口令/批量换装多模式、多人模式、任务队列（并发/超时/重试）、预览区选择/拖拽/重命名、PNG→JPEG 无损转换、高清放大。

## 运行机制

- `runtime_type: python`，桌面壳在 `%LOCALAPPDATA%/LingFang/python-venvs` 下建 venv，`pip install -r requirements.txt`（PyQt5 约 100MB+，首次几十秒）后 detached 运行 `python -u main.py`，弹出独立 PyQt5 窗口。
- **AI 调用经平台本地桥**（`/image/edit`），由桌面壳注入 `LINGFANG_PLUGIN_BRIDGE_URL` + `LINGFANG_PLUGIN_BRIDGE_TOKEN`，转发到平台 relay，**按团队灵石计费**，插件不持有任何密钥。
- 必须在桌面客户端中运行（脱离壳运行因无桥环境变量会提示并退出）。

## 档位

支持 `fast`（快速）/ `premium`（高级）档位，在「API 设置」窗口切换，默认 fast。档位决定上游命中模型与计费。

## 执行参数（本地调优）

「API 设置」窗口可调：最大并发任务数、单次请求超时（≤600s，受桥上限钳制）、最大重试次数。这些是本地执行调优，与计费无关。

## 持久化

任务历史（`task_db.json`）、提示词模板（`prompt_templates.json`）、日志、生成图统一落在插件目录的 `data/` 子目录，由框架保证存在。
