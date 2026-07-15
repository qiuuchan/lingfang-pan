# AI 详情页海报生成器（detail-poster）

基于 tkinter 的电商详情页/主图 AI 海报生成器。提示词模板库 + 多模块批量生图 + 换装换脸 + 反推提示词 + 拼长图 + 高清修复 + 颜色图工具。

## 运行机制

- `runtime_type: python`，桌面壳在 `%LOCALAPPDATA%/LingFang/python-venvs` 下建 venv，`pip install -r requirements.txt` 后 detached 运行 `python -u main.py`，弹出独立 tkinter 窗口。
- **AI 调用经平台本地桥**（`/image/edit` 生图、`/v1/chat/completions` 反推提示词），由桌面壳注入 `LINGFANG_PLUGIN_BRIDGE_URL` + `LINGFANG_PLUGIN_BRIDGE_TOKEN`，转发到平台 relay，**按团队灵石计费**，插件不持有任何密钥。
- 必须在桌面客户端中运行（脱离壳运行因无桥环境变量会提示并退出）。

## 档位

生图与反推均支持 `fast`（快速）/ `premium`（高级）档位，在「设置」窗口切换，默认 fast。档位决定上游命中模型与计费。

## 持久化

状态文件统一落在插件目录的 `data/` 子目录（模板库、应用状态、反推配置、颜色图状态、对话记录），由框架保证存在。

## 局限

- 反推提示词需平台上游渠道支持视觉（image_url）；若渠道不支持，反推会报错，不影响生图主功能。
- 系统未安装的字体（如原脚本内置的「白无常可可体」等）需用户自行导入；颜色图工具会探测系统已装字体。
