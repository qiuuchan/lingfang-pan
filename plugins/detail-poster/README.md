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
- **字体已内置**：插件自带 `fonts/` 目录（白无常可可体、思源黑体/宋体、阿里巴巴普惠体等），颜色图工具开箱即用；系统已装字体与用户导入字体同样可选。
- **出图比例**：上游 image-edit 模型只认标准尺寸（1024×1024 / 1024×1536），插件按所选比例（1:1 / 3:4 / 9:16 / 2:3）请求标准尺寸并在客户端 center-crop 到精确像素，保证「选什么比例出什么比例」。
